import { expect, test } from "bun:test";
import { ClientArtifacts } from "../src/infrastructure/ClientArtifacts";
import { ClientChannel, InMemoryClientChannelStore } from "../src/infrastructure/ClientChannel";
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

async function check(app: ReturnType<typeof appAt>, search: string) {
  const response = await app.handle(
    new Request(`http://localhost/api/client/update-check?${search}`)
  );
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.json().catch(() => null),
  };
}

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
  for (let index = 0; index < 30; index += 1)
    expect((await challenge("203.0.113.9")).status).toBe(200);
  const refused = await challenge("203.0.113.9");
  expect(refused.status).toBe(429);
  expect(refused.headers.get("retry-after")).not.toBeNull();
  expect(await refused.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
  expect((await challenge("203.0.113.10")).status).toBe(200);
  expect((await check(app, "clientType=desktop&clientVersion=2.0.0")).status).toBe(200);
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
