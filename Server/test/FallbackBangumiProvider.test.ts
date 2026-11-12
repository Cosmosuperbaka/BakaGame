import { describe, expect, test } from "bun:test";
import {
  BANGUMI_LOCAL_RETRY_COOLDOWN_MS,
  FallbackBangumiProvider,
} from "../src/infrastructure/FallbackBangumiProvider";
import type { BangumiDataProvider } from "../src/infrastructure/LocalBangumiProvider";
import { AppError } from "../src/domain/Errors";

const result = [{ id: "1", name: "远程", nameCn: "远程", tags: [], metaTags: [] }];

/** 构造一组计数用的本地/远程 provider；本地是否健康由 `healthy` 闭包控制。 */
const makeProviders = (healthy: () => boolean) => {
  const calls = { local: 0, remote: 0 };
  const unavailable = () => {
    throw new AppError("BANGUMI_DATA_UNAVAILABLE", "本地不可用");
  };
  const local: BangumiDataProvider = {
    searchSubjects: async () => {
      calls.local += 1;
      if (!healthy()) unavailable();
      return result;
    },
    getSubject: async () => {
      calls.local += 1;
      if (!healthy()) unavailable();
      return { ...result[0], locked: false, musicTracks: [] };
    },
    chooseRandomSubject: async () => {
      calls.local += 1;
      if (!healthy()) unavailable();
      return { ...result[0], locked: false, musicTracks: [] };
    },
    resolveCharacterImage: async () => {
      calls.local += 1;
      if (!healthy()) unavailable();
      return undefined;
    },
    resolveSubjectImage: async () => {
      calls.local += 1;
      if (!healthy()) unavailable();
      return undefined;
    },
  };
  const remote: BangumiDataProvider = {
    searchSubjects: async () => {
      calls.remote += 1;
      return result;
    },
    getSubject: async () => {
      calls.remote += 1;
      return { ...result[0], locked: false, musicTracks: [] };
    },
    chooseRandomSubject: async () => {
      calls.remote += 1;
      return { ...result[0], locked: false, musicTracks: [] };
    },
    resolveCharacterImage: async () => {
      calls.remote += 1;
      return undefined;
    },
    resolveSubjectImage: async () => {
      calls.remote += 1;
      return undefined;
    },
  };
  return { calls, local, remote };
};

describe("FallbackBangumiProvider", () => {
  test("本地数据不可用时切换到网络 API，并在冷却期内保持网络回源", async () => {
    let now = 1_000;
    const { calls, local, remote } = makeProviders(() => false);
    const warnings: string[] = [];
    const provider = new FallbackBangumiProvider({
      local,
      remote,
      logger: { warn: (message) => warnings.push(message) },
      now: () => now,
    });

    expect(await provider.searchSubjects("测试")).toEqual(result);
    now += BANGUMI_LOCAL_RETRY_COOLDOWN_MS - 1;
    expect(await provider.searchSubjects("测试")).toEqual(result);

    // 冷却期内只探测一次本地，之后直接走网络；且不重复告警。
    expect(calls.local).toBe(1);
    expect(calls.remote).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  test("冷却期结束后重新探测本地，本地恢复即改回本地查询", async () => {
    let now = 1_000;
    let localHealthy = false;
    const { calls, local, remote } = makeProviders(() => localHealthy);
    const warnings: string[] = [];
    const provider = new FallbackBangumiProvider({
      local,
      remote,
      logger: { warn: (message) => warnings.push(message) },
      now: () => now,
    });

    expect(await provider.searchSubjects("测试")).toEqual(result);
    expect(calls.local).toBe(1);
    expect(calls.remote).toBe(1);

    // 冷却期未到：仍然直接走网络，不打扰本地。
    now += BANGUMI_LOCAL_RETRY_COOLDOWN_MS - 1;
    await provider.searchSubjects("测试");
    expect(calls.local).toBe(1);
    expect(calls.remote).toBe(2);

    // 冷却期结束且本地已恢复：改回本地，并留下恢复告警。
    localHealthy = true;
    now += 1;
    await provider.searchSubjects("测试");
    expect(calls.local).toBe(2);
    expect(calls.remote).toBe(2);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("恢复");

    // 恢复后不再保留降级状态，后续请求稳定走本地。
    await provider.searchSubjects("测试");
    expect(calls.local).toBe(3);
    expect(calls.remote).toBe(2);
  });

  test("非降级类错误原样抛出，不触发网络回源", async () => {
    const { calls, remote } = makeProviders(() => true);
    const local: BangumiDataProvider = {
      searchSubjects: async () => {
        calls.local += 1;
        throw new AppError("BANGUMI_NO_SUBJECT", "查不到");
      },
      getSubject: async () => {
        throw new AppError("BANGUMI_NO_SUBJECT", "查不到");
      },
      chooseRandomSubject: async () => {
        throw new AppError("BANGUMI_NO_SUBJECT", "查不到");
      },
      resolveCharacterImage: async () => undefined,
      resolveSubjectImage: async () => undefined,
    };
    const provider = new FallbackBangumiProvider({ local, remote });

    await expect(provider.searchSubjects("测试")).rejects.toMatchObject({
      code: "BANGUMI_NO_SUBJECT",
    });
    expect(calls.local).toBe(1);
    expect(calls.remote).toBe(0);
  });

  describe("查询超时只算一次慢查询", () => {
    const timeoutLocal = (calls: { local: number }): BangumiDataProvider => ({
      searchSubjects: async () => {
        calls.local += 1;
        throw new AppError("BANGUMI_QUERY_TIMEOUT", "本地番剧查询超时");
      },
      getSubject: async () => {
        throw new AppError("BANGUMI_QUERY_TIMEOUT", "本地番剧查询超时");
      },
      chooseRandomSubject: async () => {
        throw new AppError("BANGUMI_QUERY_TIMEOUT", "本地番剧查询超时");
      },
      resolveCharacterImage: async () => undefined,
      resolveSubjectImage: async () => undefined,
    });

    test("单次超时本次请求走网络，但不把整个进程切到网络回源", async () => {
      const now = 1_000;
      const { calls, remote } = makeProviders(() => true);
      const provider = new FallbackBangumiProvider({
        local: timeoutLocal(calls),
        remote,
        now: () => now,
      });
      expect(await provider.searchSubjects("测试")).toEqual(result);
      expect(provider.status().mode).toBe("local");
      // 下一个请求仍然先探测本地。
      await provider.searchSubjects("测试");
      expect(calls.local).toBe(2);
    });

    test("窗口内连续超时才进入冷却，窗口外的零星超时不累计", async () => {
      let now = 1_000;
      const { calls, remote } = makeProviders(() => true);
      const provider = new FallbackBangumiProvider({
        local: timeoutLocal(calls),
        remote,
        now: () => now,
      });
      await provider.searchSubjects("测试");
      // 超出窗口：之前那次超时作废。
      now += 10 * 60_000;
      await provider.searchSubjects("测试");
      expect(provider.status().mode).toBe("local");
      // 窗口内第二次：进入冷却，之后直接走网络。
      now += 20_000;
      await provider.searchSubjects("测试");
      expect(provider.status().mode).toBe("remote");
      const before = calls.local;
      await provider.searchSubjects("测试");
      expect(calls.local).toBe(before);
    });

    test("数据不可用仍然一次就降级", async () => {
      const { calls, local, remote } = makeProviders(() => false);
      const provider = new FallbackBangumiProvider({ local, remote, now: () => 1_000 });
      await provider.searchSubjects("测试");
      expect(provider.status().mode).toBe("remote");
      expect(calls.local).toBe(1);
    });
  });
});
