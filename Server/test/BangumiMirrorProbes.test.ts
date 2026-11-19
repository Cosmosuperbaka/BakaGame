import { expect, test } from "bun:test";
import type { Meilisearch } from "meilisearch";
import { BangumiSearchIndex } from "../src/infrastructure/BangumiSearchIndex";
import {
  BANGUMI_LOCAL_RETRY_COOLDOWN_MS,
  FallbackBangumiProvider,
} from "../src/infrastructure/FallbackBangumiProvider";
import type { BangumiDataProvider } from "../src/infrastructure/BangumiDataProvider";

const subjectProvider = (getSubject: () => Promise<unknown>) =>
  ({ getSubject }) as unknown as BangumiDataProvider;

test("回源状态反映降级、冷却与恢复，冷却内的重试不重复计数", async () => {
  let now = 1_000;
  let failing = true;
  const failure = Object.assign(new Error("超时"), { code: "BANGUMI_QUERY_TIMEOUT" });
  const provider = new FallbackBangumiProvider({
    local: subjectProvider(async () => {
      if (failing) throw failure;
      return {};
    }),
    remote: subjectProvider(async () => ({})),
    now: () => now,
  });

  expect(provider.status()).toEqual({
    mode: "local",
    retryAt: null,
    degradedCount: 0,
    lastDegradedAt: null,
    lastErrorCode: null,
  });

  await provider.getSubject("1");
  await provider.getSubject("1");
  expect(provider.status()).toEqual({
    mode: "remote",
    retryAt: 1_000 + BANGUMI_LOCAL_RETRY_COOLDOWN_MS,
    degradedCount: 1,
    lastDegradedAt: 1_000,
    lastErrorCode: "BANGUMI_QUERY_TIMEOUT",
  });

  failing = false;
  now += BANGUMI_LOCAL_RETRY_COOLDOWN_MS;
  await provider.getSubject("1");
  expect(provider.status()).toMatchObject({ mode: "local", retryAt: null, degradedCount: 1 });
});

test("搜索状态读文档数与索引中标记，服务不可达时如实抛出", async () => {
  const makeClient = (health: () => Promise<unknown>) =>
    ({
      health,
      index: (name: string) => ({
        getStats: async () => ({
          numberOfDocuments: name === "subjects" ? 3 : 5,
          isIndexing: name === "characters",
        }),
      }),
    }) as unknown as Meilisearch;

  const search = new BangumiSearchIndex({ client: makeClient(async () => ({})) });
  expect(await search.status()).toEqual({ subjects: 3, characters: 5, isIndexing: true });

  const down = new BangumiSearchIndex({
    client: makeClient(async () => {
      throw new Error("连接失败");
    }),
  });
  await expect(down.status()).rejects.toThrow("连接失败");
});
