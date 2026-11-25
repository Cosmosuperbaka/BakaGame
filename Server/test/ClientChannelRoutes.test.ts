import { expect, test } from "bun:test";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { ClientArtifacts } from "../src/infrastructure/ClientArtifacts";
import {
  CLIENT_TICKET_TTL_MS,
  ClientChannel,
  InMemoryClientChannelStore,
} from "../src/infrastructure/ClientChannel";
import { DESKTOP_MACOS_MINIMUM_SYSTEM_VERSION } from "../src/infrastructure/ClientChannelContract";
import { ClientWebBundle } from "../src/infrastructure/ClientWebBundle";
import { clientChannelRoutes } from "../src/transport/routes/ClientChannelRoutes";

/** 桌面一档给最低版本、移动一档留空：正好覆盖「两端各自门槛」的读回口径。 */
const appAt = (desktopMinimum: string) =>
  clientChannelRoutes(
    new ClientChannel({
      store: new InMemoryClientChannelStore(),
      minimumVersion: (clientType) => (clientType === "desktop" ? desktopMinimum : ""),
    })
  );

async function check(app: ReturnType<typeof appAt>, search: string, userAgent?: string) {
  const response = await app.handle(
    new Request(`http://localhost/api/client/update-check?${search}`, {
      headers: userAgent ? { "user-agent": userAgent } : {},
    })
  );
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.json().catch(() => null),
  };
}

/** 壳原生请求只带客户端段；Mac 壳按自己的系统版本填，WebView 则在默认串后面追加同一段。 */
const macShellUa = (osVersion: string, client = "2.0.0") =>
  `BakaGame/${client} (macOS ${osVersion}; arm64; desktop) Game/unknown`;

test("注册与领挑战按来源限流：同一来源超额 429，换来源照常，读回接口不受影响", async () => {
  const app = appAt("2.0.0");
  const challenge = (ip: string) =>
    app.handle(
      new Request("http://localhost/api/client/challenge", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": ip },
        body: JSON.stringify({ clientId: "client-abcdef" }),
      })
    );
  // 共用出口的一屋子玩家同时进房（每人挑战 + 签名两步）不能被误伤：额度按几十台设备留。
  for (let index = 0; index < 120; index += 1)
    expect((await challenge("203.0.113.9")).status).toBe(200);
  const refused = await challenge("203.0.113.9");
  expect(refused.status).toBe(429);
  expect(refused.headers.get("retry-after")).not.toBeNull();
  expect(await refused.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
  expect((await challenge("203.0.113.10")).status).toBe(200);
  expect((await check(app, "clientType=desktop&clientVersion=2.0.0")).status).toBe(200);
});

test("请求体不合法的请求同样计入来源额度：校验失败不能成为免费的探测通道", async () => {
  const app = appAt("2.0.0");
  const malformed = (ip: string) =>
    app.handle(
      new Request("http://localhost/api/client/challenge", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": ip },
        body: JSON.stringify({ clientId: "x" }),
      })
    );
  const statuses: number[] = [];
  for (let index = 0; index < 130; index += 1)
    statuses.push((await malformed("203.0.113.20")).status);
  expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  expect(statuses[0]).not.toBe(429);
});

test("低于最低版本回 outdated，并把门槛一起回显给提醒用", async () => {
  expect(await check(appAt("2.0.0"), "clientType=desktop&clientVersion=1.9.0")).toMatchObject({
    status: 200,
    body: { minimumVersion: "2.0.0", outdated: true },
  });
});

test("等于最低版本即算够新：门槛是「不低于」不是「大于」", async () => {
  const result = await check(appAt("2.0.0"), "clientType=desktop&clientVersion=2.0.0");
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ outdated: false });
});

test("没配最低版本不报错：恒为够新，门槛回空串", async () => {
  const result = await check(appAt(""), "clientType=desktop&clientVersion=0.1.0");
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ minimumVersion: "", outdated: false });
});

test("两端门槛各算各的：桌面的旧不代表移动的旧", async () => {
  const result = await check(appAt("2.0.0"), "clientType=mobile&clientVersion=1.0.0");
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ minimumVersion: "", outdated: false });
});

test("提醒读回的门槛不许被边缘缓存：抬档要立刻生效", async () => {
  const result = await check(appAt("2.0.0"), "clientType=desktop&clientVersion=2.0.0");
  expect(result.cacheControl).toBe("no-store");
});

test("已发布最新版高于当前壳时回 behindLatest：发新版不必自动抬硬门槛", async () => {
  const artifacts = new ClientArtifacts({
    urls: { windows: "https://cdn.test/files/BakaGame-latest-x64.exe" },
    fetcher: (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith(".version")) {
        return { ok: true, text: async () => "2.5.0\n" } as unknown as Response;
      }
      return {
        ok: true,
        headers: new Headers({ "content-length": "10" }),
        method: init?.method,
      } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  const app = clientChannelRoutes(
    new ClientChannel({
      store: new InMemoryClientChannelStore(),
      minimumVersion: () => "2.0.0",
    }),
    artifacts
  );

  const result = await check(app, "clientType=desktop&clientVersion=2.0.0");
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({
    minimumVersion: "2.0.0",
    outdated: false,
    latestVersion: "2.5.0",
    behindLatest: true,
  });
});

test("版本刚好等于最新发布版时不再提示；旁文件缺失时两档都为假", async () => {
  const artifacts = new ClientArtifacts({
    urls: { windows: "https://cdn.test/files/BakaGame-latest-x64.exe" },
    fetcher: (async (url: string) => {
      if (String(url).endsWith(".version")) {
        return { ok: true, text: async () => "2.5.0" } as unknown as Response;
      }
      return { ok: true, headers: new Headers() } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  const upToDate = clientChannelRoutes(
    new ClientChannel({ store: new InMemoryClientChannelStore(), minimumVersion: () => "" }),
    artifacts
  );

  expect(await check(upToDate, "clientType=desktop&clientVersion=2.5.0")).toMatchObject({
    body: { latestVersion: "2.5.0", behindLatest: false },
  });

  // 同一份通道，但不给制品服务：没有旁文件就没有软提醒依据，只保留硬门槛口径。
  const noArtifacts = clientChannelRoutes(
    new ClientChannel({ store: new InMemoryClientChannelStore(), minimumVersion: () => "" })
  );
  expect(await check(noArtifacts, "clientType=desktop&clientVersion=0.1.0")).toMatchObject({
    body: { latestVersion: "", behindLatest: false },
  });
});

test("桌面壳按自报平台比对最新版：macOS 看 macOS 的包，没带平台或认不出的按 Windows", async () => {
  const artifacts = new ClientArtifacts({
    urls: {
      windows: "https://cdn.test/files/BakaGame-latest-x64.exe",
      macos: "https://cdn.test/files/BakaGame-latest-universal.dmg",
      android: "https://cdn.test/files/BakaGame-latest-release.apk",
    },
    fetcher: (async (url: string) => {
      const text = String(url);
      if (text.endsWith(".version")) {
        const version = text.includes(".dmg") ? "2.1.0" : text.includes(".apk") ? "3.0.0" : "2.5.0";
        return { ok: true, text: async () => version } as unknown as Response;
      }
      return { ok: true, headers: new Headers() } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  const app = clientChannelRoutes(
    new ClientChannel({ store: new InMemoryClientChannelStore(), minimumVersion: () => "" }),
    artifacts
  );

  expect(await check(app, "clientType=desktop&clientVersion=2.1.0&platform=macos")).toMatchObject({
    status: 200,
    body: { latestVersion: "2.1.0", behindLatest: false },
  });
  expect(await check(app, "clientType=desktop&clientVersion=2.1.0")).toMatchObject({
    status: 200,
    body: { latestVersion: "2.5.0", behindLatest: true },
  });
  expect(await check(app, "clientType=desktop&clientVersion=2.1.0&platform=windows")).toMatchObject(
    { body: { latestVersion: "2.5.0", behindLatest: true } }
  );
  expect(await check(app, "clientType=desktop&clientVersion=2.1.0&platform=linux")).toMatchObject({
    body: { latestVersion: "2.5.0" },
  });
  // 移动壳只认安卓包，自报平台不改变它
  expect(await check(app, "clientType=mobile&clientVersion=2.1.0&platform=macos")).toMatchObject({
    body: { latestVersion: "3.0.0", behindLatest: true },
  });
});

test("系统低于新包最低版本的 Mac 壳不再催更新；读不出系统版本时照旧提醒", async () => {
  const artifacts = new ClientArtifacts({
    urls: { macos: "https://cdn.test/files/BakaGame-latest-universal.dmg" },
    fetcher: (async (url: string) =>
      String(url).endsWith(".version")
        ? ({ ok: true, text: async () => "2.1.0" } as unknown as Response)
        : ({ ok: true, headers: new Headers() } as unknown as Response)) as unknown as typeof fetch,
  });
  const app = clientChannelRoutes(
    new ClientChannel({ store: new InMemoryClientChannelStore(), minimumVersion: () => "" }),
    artifacts
  );
  const [major] = DESKTOP_MACOS_MINIMUM_SYSTEM_VERSION.split(".");
  const query = "clientType=desktop&clientVersion=2.0.0&platform=macos";
  const webview = (osVersion: string) =>
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ${macShellUa(osVersion)}`;

  expect(await check(app, query, webview(`${Number(major) - 1}.6`))).toMatchObject({
    body: { latestVersion: "2.1.0", behindLatest: false },
  });
  expect(await check(app, query, webview(`${major}.0`))).toMatchObject({
    body: { behindLatest: true },
  });
  expect(await check(app, query)).toMatchObject({ body: { behindLatest: true } });
});

test("macOS 包没配（缺省空串）时 Mac 壳没有软提醒依据，不拿 Windows 的版本去催", async () => {
  const artifacts = new ClientArtifacts({
    urls: { windows: "https://cdn.test/files/BakaGame-latest-x64.exe", macos: "" },
    fetcher: (async (url: string) =>
      String(url).endsWith(".version")
        ? ({ ok: true, text: async () => "2.5.0" } as unknown as Response)
        : ({ ok: true, headers: new Headers() } as unknown as Response)) as unknown as typeof fetch,
  });
  const app = clientChannelRoutes(
    new ClientChannel({ store: new InMemoryClientChannelStore(), minimumVersion: () => "" }),
    artifacts
  );

  expect(await check(app, "clientType=desktop&clientVersion=0.1.0&platform=macos")).toMatchObject({
    status: 200,
    body: { latestVersion: "", behindLatest: false },
  });
});

test("客户端类型不认识时拒绝，而不是当成够新放过", async () => {
  const result = await check(appAt("2.0.0"), "clientType=web&clientVersion=1.0.0");
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(result.status).toBeLessThan(500);
});

test("缺版本号时拒绝：没有版本就没有提醒的依据", async () => {
  const result = await check(appAt("2.0.0"), "clientType=desktop");
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(result.status).toBeLessThan(500);
});

/** 桌面壳自动更新清单：按更新器替换好的平台、架构与当前版本提问。 */
async function desktopUpdate(path: string, artifacts?: ClientArtifacts, userAgent?: string) {
  const ua = userAgent ?? (path.startsWith("darwin/") ? macShellUa("26.1") : undefined);
  const response = await clientChannelRoutes(undefined, artifacts).handle(
    new Request(`http://localhost/api/client/desktop-update/${path}`, {
      headers: ua ? { "user-agent": ua } : {},
    })
  );
  const text = await response.text();
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    vary: response.headers.get("vary"),
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
}

const UPDATE_SIGNATURE = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ==";

/** Windows 2.5.0、macOS 2.1.0 两个更新包，签名与版本旁文件都齐；记下所有被请求的地址。 */
const updaterArtifacts = () => {
  const fetched: string[] = [];
  const artifacts = new ClientArtifacts({
    urls: { windows: "https://cdn.test/files/BakaGame-latest-x64.exe" },
    updaterUrls: {
      windows: "https://cdn.test/files/BakaGame-latest-x64.exe",
      macos: "https://cdn.test/files/BakaGame-latest-universal.app.tar.gz",
    },
    fetcher: (async (url: string, init?: RequestInit) => {
      const text = String(url);
      fetched.push(`${init?.method ?? "GET"} ${text}`);
      if (text.endsWith(".version"))
        return {
          ok: true,
          text: async () => (text.includes("universal") ? "2.1.0" : "2.5.0"),
        } as unknown as Response;
      if (text.endsWith(".sig"))
        return { ok: true, text: async () => UPDATE_SIGNATURE } as unknown as Response;
      return {
        ok: true,
        headers: new Headers({ "last-modified": "Mon, 19 Oct 2026 09:12:33 GMT" }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  return { artifacts, fetched };
};

test("自动更新清单：落后于已发布版时按 Tauri 动态格式给出版本、地址与签名", async () => {
  const { artifacts } = updaterArtifacts();
  const result = await desktopUpdate("windows/x86_64/2.0.0", artifacts);
  expect(result.status).toBe(200);
  expect(result.cacheControl).toBe("public, max-age=60");
  expect(result.body).toEqual({
    version: "2.5.0",
    notes: "",
    pub_date: "2026-10-19T09:12:33.000Z",
    url: "https://cdn.test/files/BakaGame-latest-x64.exe",
    signature: UPDATE_SIGNATURE,
  });
});

test("自动更新清单：macOS 两种芯片都拿通用包，版本按 macOS 自己的发布比", async () => {
  const { artifacts } = updaterArtifacts();
  for (const arch of ["aarch64", "x86_64"]) {
    const result = await desktopUpdate(`darwin/${arch}/2.0.0`, artifacts);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      version: "2.1.0",
      url: "https://cdn.test/files/BakaGame-latest-universal.app.tar.gz",
    });
  }
  // Windows 已经发到 2.5.0 也不影响 Mac 壳：2.1.0 的 Mac 壳就是最新
  expect((await desktopUpdate("darwin/aarch64/2.1.0", artifacts)).status).toBe(204);
});

test("自动更新清单：系统低于新包最低版本、或读不出系统版本的 Mac 不给新包，答复只许端上缓存", async () => {
  const { artifacts } = updaterArtifacts();
  const [major] = DESKTOP_MACOS_MINIMUM_SYSTEM_VERSION.split(".");
  const below = `${Number(major) - 1}.6`;
  const allowed = await desktopUpdate("darwin/aarch64/2.0.0", artifacts, macShellUa(`${major}.0`));
  expect(allowed.status).toBe(200);
  expect(allowed.cacheControl).toBe("private, max-age=60");
  expect(allowed.vary).toBe("User-Agent");
  for (const ua of [
    macShellUa(below),
    macShellUa("unknown"),
    // 旧壳的更新请求只带插件自己的 UA，看不出系统版本
    "tauri-plugin-updater/2.14.1",
    "",
  ]) {
    const result = await desktopUpdate("darwin/aarch64/2.0.0", artifacts, ua);
    expect(result.status, ua).toBe(204);
    expect(result.cacheControl, ua).toBe("private, max-age=60");
  }
  // Windows 不看系统版本，照旧可以共享缓存
  const windows = await desktopUpdate("windows/x86_64/2.0.0", artifacts, macShellUa(below));
  expect(windows.status).toBe(200);
  expect(windows.cacheControl).toBe("public, max-age=60");
  expect(windows.vary).toBeNull();
});

test("自动更新清单：已是最新、平台没有发布或没配制品时回 204", async () => {
  const { artifacts } = updaterArtifacts();
  for (const path of [
    "windows/x86_64/2.5.0",
    "windows/x86_64/3.0.0",
    "windows/aarch64/1.0.0",
    "linux/x86_64/1.0.0",
  ]) {
    const result = await desktopUpdate(path, artifacts);
    expect(result.status, path).toBe(204);
    expect(result.body, path).toBeNull();
  }
  expect((await desktopUpdate("windows/x86_64/1.0.0")).status).toBe(204);
});

test("自动更新清单：版本段不合法时拒绝，不当成「有新版」", async () => {
  const { artifacts, fetched } = updaterArtifacts();
  const result = await desktopUpdate("windows/x86_64/not-a-version", artifacts);
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(result.status).toBeLessThan(500);
  expect(fetched).toEqual([]);
});

test("自动更新清单只转交地址，不经源站转发安装包：服务端只读版本、签名旁文件与 HEAD", async () => {
  const { artifacts, fetched } = updaterArtifacts();
  await desktopUpdate("windows/x86_64/2.0.0", artifacts);
  // 安装包本身只发 HEAD（读大小与修改时间），GET 的只有两个几百字节的旁文件
  expect(fetched.sort()).toEqual([
    "GET https://cdn.test/files/BakaGame-latest-x64.exe.sig",
    "GET https://cdn.test/files/BakaGame-latest-x64.exe.version",
    "HEAD https://cdn.test/files/BakaGame-latest-x64.exe",
  ]);
});

/** 下载弹窗读的那条：制品元数据来自 `ClientArtifacts`，与通道证明启没启用无关。 */
async function packages(artifacts?: ClientArtifacts) {
  const response = await clientChannelRoutes(undefined, artifacts).handle(
    new Request("http://localhost/api/client/packages")
  );
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.json().catch(() => null),
  };
}

const published = new ClientArtifacts({
  urls: { windows: "https://cdn.test/files/BakaGame-latest-x64.exe", android: "" },
  fetcher: (async () =>
    ({
      ok: true,
      headers: new Headers({
        "content-length": "84216320",
        "last-modified": "Mon, 19 Oct 2026 09:12:33 GMT",
      }),
    }) as unknown as Response) as unknown as typeof fetch,
});

test("下载弹窗读制品元数据：地址、架构、大小与构建时间一次给全", async () => {
  const result = await packages(published);
  expect(result.status).toBe(200);
  expect(result.body).toEqual({
    packages: [
      {
        platform: "windows",
        arch: "x64",
        url: "https://cdn.test/files/BakaGame-latest-x64.exe",
        available: true,
        sizeBytes: 84216320,
        builtAt: "2026-10-19T09:12:33.000Z",
      },
    ],
  });
});

test("通道没启用时下载信息照回：下载不该被准入相关的开关挡住", async () => {
  expect((await packages(undefined)).body).toEqual({ packages: [] });
});

test("下载信息可以被短时间缓存：它在发版前根本不会变", async () => {
  expect((await packages(published)).cacheControl).toBe("public, max-age=60");
});

/** Web 资源热更新清单：只服务移动壳，桌面壳加载远程站点、没有内嵌资源要换。 */
const webBundle = () =>
  new ClientWebBundle({
    manifestUrl: "https://cdn.test/files/BakaGame-web-latest.json",
    fetcher: (async () =>
      ({
        ok: true,
        json: async () => ({
          build: "newbuild",
          version: "1.9.5",
          file: "BakaGame-web-newbuild.zip",
          sha256: "b".repeat(64),
          sizeBytes: 34_000_000,
          minShellVersion: "0.1.2",
          publishedAt: "2026-10-26T08:00:00.000Z",
        }),
      }) as unknown as Response) as unknown as typeof fetch,
  });

async function webBundleCheck(search: string, bundle: ClientWebBundle | null = webBundle()) {
  const response = await clientChannelRoutes(undefined, undefined, bundle ?? undefined).handle(
    new Request(`http://localhost/api/client/web-bundle?${search}`)
  );
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.json().catch(() => null),
  };
}

test("移动壳有更新的资源包时给出下载地址与校验值", async () => {
  const result = await webBundleCheck("clientType=mobile&shellVersion=0.1.2&build=oldbuild");
  expect(result).toMatchObject({
    status: 200,
    cacheControl: "no-store",
    body: {
      available: true,
      build: "newbuild",
      version: "1.9.5",
      url: "https://cdn.test/files/BakaGame-web-newbuild.zip",
      sha256: "b".repeat(64),
      sizeBytes: 34_000_000,
    },
  });
});

test("构建标记相同即没有更新：每次启动都下载同一份资源包没有意义", async () => {
  expect(await webBundleCheck("clientType=mobile&shellVersion=0.1.2&build=newbuild")).toMatchObject(
    { body: { available: false } }
  );
});

test("壳低于清单要求的最低版本时不下发：旧壳可能没有新资源要用的桥接能力", async () => {
  expect(await webBundleCheck("clientType=mobile&shellVersion=0.1.1&build=oldbuild")).toMatchObject(
    { body: { available: false, reason: "SHELL_TOO_OLD" } }
  );
});

test("桌面壳与没有清单的实例都回没有更新：热更新只属于内嵌产物的移动壳", async () => {
  expect(
    await webBundleCheck("clientType=desktop&shellVersion=0.1.2&build=oldbuild")
  ).toMatchObject({ body: { available: false } });
  expect(
    await webBundleCheck("clientType=mobile&shellVersion=0.1.2&build=oldbuild", null)
  ).toMatchObject({ body: { available: false } });
});

test("构建标记只接受安全字符：路径分隔符不该出现在查询参数里", async () => {
  const result = await webBundleCheck("clientType=mobile&shellVersion=0.1.2&build=../evil");
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(result.status).toBeLessThan(500);
});

test("旧壳视角：按旧请求形状走完注册、领挑战、换票，只读 ticket、expiresAt、outdated 照常可用", async () => {
  const now = 5_000_000;
  const app = clientChannelRoutes(
    new ClientChannel({
      store: new InMemoryClientChannelStore(),
      now: () => now,
      minimumVersion: () => "",
    })
  );
  const post = async (path: string, body: unknown) => {
    const response = await app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.30" },
        body: JSON.stringify(body),
      })
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const selfCheck = { hardFail: [], softFail: [], keyProtection: "software" };
  const registered = await post("/api/client/register", {
    clientType: "desktop",
    platform: "windows",
    clientVersion: "0.1.1",
    keyAlgorithm: "ed25519",
    publicKey: raw,
    selfCheck,
  });
  expect(registered.status).toBe(200);
  const clientId = registered.body.clientId as string;
  const challenge = (await post("/api/client/challenge", { clientId })).body.challenge as string;
  const attested = await post("/api/client/attest", {
    clientId,
    challenge,
    signature: nodeSign(null, Buffer.from(challenge, "ascii"), privateKey).toString("base64"),
    clientType: "desktop",
    clientVersion: "0.1.1",
    selfCheck,
  });
  expect(attested.status).toBe(200);
  // 旧壳读的三个字段：形状与取值不变（expiresAt 仍是服务端时钟的绝对毫秒）。
  expect(typeof attested.body.ticket).toBe("string");
  expect(attested.body.expiresAt).toBe(now + CLIENT_TICKET_TTL_MS);
  expect(attested.body.outdated).toBe(false);
  // 新壳读的追加字段：相对有效期，不依赖两端时钟是否一致。
  expect(attested.body.ttlMs).toBe(CLIENT_TICKET_TTL_MS);
});

test("旧壳视角（移动）：按带证明链的移动壳请求形状走完注册、领挑战、换票，只读旧字段，票照常能用", async () => {
  const now = 6_000_000;
  const channel = new ClientChannel({
    store: new InMemoryClientChannelStore(),
    now: () => now,
    minimumVersion: () => "",
  });
  const app = clientChannelRoutes(channel);
  const post = async (path: string, body: unknown) => {
    const response = await app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.31" },
        body: JSON.stringify(body),
      })
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  // 旧移动壳的自检报告：带 attestationLevel、没有 keyProtection；注册必须带证明链，
  // 没配校验器的服务端不解析链，只透传并记降级，所以这里的占位 PEM 无需是真链。
  const selfCheck = { hardFail: [], softFail: [], attestationLevel: "trusted" };
  const attestation = {
    attestationChallenge: "AQIDBAUGBwg=",
    chain: [
      `-----BEGIN CERTIFICATE-----
${"A".repeat(80)}
-----END CERTIFICATE-----
`,
    ],
  };
  const registered = await post("/api/client/register", {
    clientType: "mobile",
    platform: "android",
    clientVersion: "0.1.1",
    keyAlgorithm: "ec-p256",
    publicKey: spki,
    selfCheck,
    attestation,
  });
  expect(registered.status).toBe(200);
  const clientId = registered.body.clientId as string;
  const challenge = (await post("/api/client/challenge", { clientId })).body.challenge as string;
  const attested = await post("/api/client/attest", {
    clientId,
    challenge,
    signature: nodeSign("sha256", Buffer.from(challenge, "ascii"), privateKey).toString("base64"),
    clientType: "mobile",
    clientVersion: "0.1.1",
    selfCheck,
  });
  expect(attested.status).toBe(200);
  // 旧移动壳只读 ticket 与 expiresAt：形状与取值不变。
  expect(typeof attested.body.ticket).toBe("string");
  expect(attested.body.expiresAt).toBe(now + CLIENT_TICKET_TTL_MS);
  expect(channel.consume(attested.body.ticket as string, "203.0.113.31")?.clientId).toBe(clientId);
});
