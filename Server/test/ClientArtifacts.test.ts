import { expect, test } from "bun:test";
import { ClientArtifacts, type ClientPackagePlatform } from "../src/infrastructure/ClientArtifacts";

/**
 * 探测只用响应的 `ok` 与两个头，所以打桩给这两样即可：
 * 真实的 `Response` 构造器对 `content-length` 的处理各端不一致，不该让测试依赖它。
 */
const stub = (ok: boolean, headers: Record<string, string>) =>
  ({ ok, headers: new Headers(headers) }) as unknown as Response;

const harness = (
  responses: Partial<Record<ClientPackagePlatform, Response | Error>>,
  options?: { ttlMs?: number; clock?: { now: number } }
) => {
  const calls: { platform: ClientPackagePlatform; url: string; method?: string }[] = [];
  const urls: Record<ClientPackagePlatform, string> = {
    windows: "https://cdn.test/files/BakaGame-latest-x64.exe",
    android: "https://cdn.test/files/BakaGame-latest-release.apk",
  };
  const clock = options?.clock ?? { now: 0 };
  const artifacts = new ClientArtifacts({
    urls,
    ttlMs: options?.ttlMs ?? 60_000,
    now: () => clock.now,
    fetcher: ((url: string, init?: RequestInit) => {
      const platform = (Object.keys(urls) as ClientPackagePlatform[]).find(
        (key) => urls[key] === url
      )!;
      calls.push({ platform, url, method: init?.method });
      const next = responses[platform];
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next ?? stub(false, {}));
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
  // 只问元数据，不该把安装包本身拖回来。
  expect(calls.map((call) => call.method)).toEqual(["HEAD", "HEAD"]);
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
  expect(calls).toHaveLength(2);

  // 404 一样进缓存：没发布的包更该少问，发布后最多等一个 TTL。
  const misses = harness({ windows: stub(false, {}) });
  await misses.artifacts.list();
  await misses.artifacts.list();
  expect(misses.calls.filter((call) => call.platform === "windows")).toHaveLength(1);
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
  expect(calls.filter((call) => call.platform === "windows")).toHaveLength(2);
});

test("地址配成空串的平台不进列表：没发布的平台不该在弹窗里留一枚死按钮", async () => {
  const artifacts = new ClientArtifacts({
    urls: { windows: "https://cdn.test/files/BakaGame-latest-x64.exe", android: "" },
    fetcher: (async () => stub(true, { "content-length": "10" })) as unknown as typeof fetch,
  });

  expect((await artifacts.list()).map((item) => item.platform)).toEqual(["windows"]);
});
