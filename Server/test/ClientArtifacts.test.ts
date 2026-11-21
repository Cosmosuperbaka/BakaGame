import { expect, test } from "bun:test";
import { ClientArtifacts, type ClientPackagePlatform } from "../src/infrastructure/ClientArtifacts";

/**
 * 探测只用响应的 `ok` 与两个头，所以打桩给这两样即可：
 * 真实的 `Response` 构造器对 `content-length` 的处理各端不一致，不该让测试依赖它。
 */
const stub = (ok: boolean, headers: Record<string, string>) =>
  ({ ok, headers: new Headers(headers) }) as unknown as Response;

/** 版本旁文件只需要 `ok` 与 `text()`；缺省按 404 处理（旧发布流水线没写旁文件）。 */
const versionStub = (ok: boolean, body = "") =>
  ({ ok, text: async () => body }) as unknown as Response;

const harness = (
  responses: Partial<Record<ClientPackagePlatform, Response | Error>>,
  options?: {
    ttlMs?: number;
    clock?: { now: number };
    versions?: Partial<Record<ClientPackagePlatform, Response | Error>>;
    /** macOS 包缺省不配（与线上缺省空串一致），需要时由用例显式给出地址。 */
    macosUrl?: string;
  }
) => {
  const calls: { platform: ClientPackagePlatform; url: string; method?: string }[] = [];
  const urls: Partial<Record<ClientPackagePlatform, string>> = {
    windows: "https://cdn.test/files/BakaGame-latest-x64.exe",
    android: "https://cdn.test/files/BakaGame-latest-release.apk",
    ...(options?.macosUrl ? { macos: options.macosUrl } : {}),
  };
  const clock = options?.clock ?? { now: 0 };
  const artifacts = new ClientArtifacts({
    urls,
    ttlMs: options?.ttlMs ?? 60_000,
    now: () => clock.now,
    fetcher: ((url: string, init?: RequestInit) => {
      const isVersion = url.endsWith(".version");
      const base = isVersion ? url.slice(0, -".version".length) : url;
      const platform = (Object.keys(urls) as ClientPackagePlatform[]).find(
        (key) => urls[key] === base
      )!;
      calls.push({ platform, url, method: isVersion ? "GET" : init?.method });
      const next = isVersion ? options?.versions?.[platform] : responses[platform];
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next ?? (isVersion ? versionStub(false) : stub(false, {})));
    }) as unknown as typeof fetch,
  });
  return { artifacts, calls };
};

test("读到制品时把大小与最后修改时间标上，架构按发布约定给", async () => {
  const { artifacts, calls } = harness({
    windows: stub(true, {
      "content-length": "84216320",
      "last-modified": "Mon, 19 Oct 2026 09:12:33 GMT",
    }),
    android: stub(true, {
      "content-length": "7168400",
      "last-modified": "Sun, 18 Oct 2026 23:59:59 GMT",
    }),
  });

  expect(await artifacts.list()).toEqual([
    {
      platform: "windows",
      arch: "x64",
      url: "https://cdn.test/files/BakaGame-latest-x64.exe",
      available: true,
      sizeBytes: 84216320,
      builtAt: "2026-10-19T09:12:33.000Z",
    },
    {
      platform: "android",
      arch: "全架构通用",
      url: "https://cdn.test/files/BakaGame-latest-release.apk",
      available: true,
      sizeBytes: 7168400,
      builtAt: "2026-10-18T23:59:59.000Z",
    },
  ]);
  // 只问元数据与版本旁文件，不该把安装包本身拖回来。
  expect(calls.filter((call) => call.method === "HEAD")).toHaveLength(2);
  expect(calls.map((call) => call.method).sort()).toEqual(["GET", "GET", "HEAD", "HEAD"]);
});

test("读到版本旁文件时把已发布版本标上，软提醒才有依据", async () => {
  const { artifacts } = harness(
    { windows: stub(true, { "content-length": "10" }) },
    { versions: { windows: versionStub(true, "0.1.1\n") } }
  );

  const [windows] = await artifacts.list();
  expect(windows).toMatchObject({ platform: "windows", version: "0.1.1" });
  expect(await artifacts.latestVersion("windows")).toBe("0.1.1");
});

test("版本旁文件缺失、格式不对或读失败都只当作没有版本", async () => {
  const cases: Array<Response | Error | undefined> = [
    undefined,
    versionStub(false),
    versionStub(true, "latest"),
    versionStub(true, ""),
    new Error("offline"),
  ];
  for (const versionResponse of cases) {
    const { artifacts, calls } = harness(
      { windows: stub(true, { "content-length": "10" }) },
      { versions: { windows: versionResponse } }
    );
    const [windows] = await artifacts.list();
    expect(windows.version).toBeUndefined();
    expect(await artifacts.latestVersion("windows")).toBeUndefined();
    // 版本读不到不影响安装包本身可用。
    expect(windows.available).toBe(true);
    expect(calls.filter((call) => call.method === "HEAD")).toHaveLength(2);
  }
});

test("制品还没推上去（404）时标明未发布，平台本身照样进列表", async () => {
  // 错误响应也带 content-length（那是错误正文的长度），不能把它当安装包大小标出去。
  const { artifacts } = harness({
    windows: stub(false, { "content-length": "127" }),
    android: stub(true, { "content-length": "7168400" }),
  });

  const [windows, android] = await artifacts.list();
  expect(windows).toMatchObject({
    platform: "windows",
    available: false,
    sizeBytes: undefined,
    builtAt: undefined,
  });
  expect(android).toMatchObject({ platform: "android", available: true, sizeBytes: 7168400 });
});

test("探测超时归成未发布：这条只给页面贴标签，不该让接口报错", async () => {
  const { artifacts } = harness({ windows: new Error("timed out") });

  const [windows] = await artifacts.list();
  expect(windows).toMatchObject({ platform: "windows", available: false, sizeBytes: undefined });
});

test("TTL 内复用同一次探测：并发打开首页不该把边缘节点锤出成一串 HEAD", async () => {
  const { artifacts, calls } = harness({ windows: stub(true, { "content-length": "1" }) });

  await Promise.all([artifacts.list(), artifacts.list()]);
  // 两个平台各一次 HEAD + 一次版本旁文件；并发调用共用同一份在途结果。
  expect(calls).toHaveLength(4);

  // 404 一样进缓存：没发布的包更该少问，发布后最多等一个 TTL。
  const misses = harness({ windows: stub(false, {}) });
  await misses.artifacts.list();
  await misses.artifacts.list();
  expect(misses.calls.filter((call) => call.platform === "windows")).toHaveLength(2);
});

test("过 TTL 后重新探测：CI 刚推的新包不必等服务端重启", async () => {
  const clock = { now: 0 };
  const { artifacts, calls } = harness(
    { windows: stub(true, { "content-length": "10" }) },
    { clock }
  );
  await artifacts.list();
  clock.now = 61_000;
  await artifacts.list();
  expect(calls.filter((call) => call.platform === "windows")).toHaveLength(4);
});

test("地址配成空串的平台不进列表：没发布的平台不该在弹窗里留一枚死按钮", async () => {
  const artifacts = new ClientArtifacts({
    urls: { windows: "https://cdn.test/files/BakaGame-latest-x64.exe", android: "" },
    fetcher: (async () => stub(true, { "content-length": "10" })) as unknown as typeof fetch,
  });

  expect((await artifacts.list()).map((item) => item.platform)).toEqual(["windows"]);
});

test("配了 macOS 包时按 Windows、macOS、安卓的顺序列出，架构标通用包", async () => {
  const { artifacts } = harness(
    {
      windows: stub(true, { "content-length": "10" }),
      macos: stub(true, { "content-length": "20" }),
      android: stub(true, { "content-length": "30" }),
    },
    {
      macosUrl: "https://cdn.test/files/BakaGame-latest-universal.dmg",
      versions: { macos: versionStub(true, "0.2.0") },
    }
  );

  const list = await artifacts.list();
  expect(list.map((item) => item.platform)).toEqual(["windows", "macos", "android"]);
  expect(list[1]).toMatchObject({
    platform: "macos",
    arch: "通用（Apple 芯片与 Intel）",
    url: "https://cdn.test/files/BakaGame-latest-universal.dmg",
    available: true,
    sizeBytes: 20,
    version: "0.2.0",
  });
  expect(await artifacts.latestVersion("macos")).toBe("0.2.0");
});

test("macOS 地址为空串（缺省）时不进列表，也读不到它的最新版本", async () => {
  const fetched: string[] = [];
  const artifacts = new ClientArtifacts({
    urls: {
      windows: "https://cdn.test/files/BakaGame-latest-x64.exe",
      macos: "",
      android: "https://cdn.test/files/BakaGame-latest-release.apk",
    },
    fetcher: (async (url: string) => {
      fetched.push(url);
      return stub(true, { "content-length": "10" });
    }) as unknown as typeof fetch,
  });

  expect((await artifacts.list()).map((item) => item.platform)).toEqual(["windows", "android"]);
  expect(await artifacts.latestVersion("macos")).toBeUndefined();
  // 没配的平台连探测都不发
  expect(fetched.some((url) => url.includes("dmg"))).toBe(false);
});
