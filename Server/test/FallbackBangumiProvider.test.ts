import { describe, expect, test } from "bun:test";
import { FallbackBangumiProvider } from "../src/infrastructure/FallbackBangumiProvider";
import type { BangumiDataProvider } from "../src/infrastructure/LocalBangumiProvider";
import { AppError } from "../src/domain/Errors";

describe("FallbackBangumiProvider", () => {
  test("switches to API after local data becomes unavailable", async () => {
    let localCalls = 0;
    let remoteCalls = 0;
    const result = [{ id: "1", name: "远程", nameCn: "远程", tags: [], metaTags: [] }];
    const local: BangumiDataProvider = {
      searchSubjects: async () => { localCalls++; throw new AppError("BANGUMI_DATA_UNAVAILABLE", "本地不可用"); },
      getSubject: async () => { throw new AppError("BANGUMI_DATA_UNAVAILABLE", "本地不可用"); },
      chooseRandomSubject: async () => { throw new AppError("BANGUMI_DATA_UNAVAILABLE", "本地不可用"); },
    };
    const remote: BangumiDataProvider = {
      searchSubjects: async () => { remoteCalls++; return result; },
      getSubject: async () => ({ ...result[0], locked: false, musicTracks: [] }),
      chooseRandomSubject: async () => ({ ...result[0], locked: false, musicTracks: [] }),
    };
    const provider = new FallbackBangumiProvider(local, remote);
    expect(await provider.searchSubjects("测试")).toEqual(result);
    expect(await provider.searchSubjects("测试")).toEqual(result);
    expect(localCalls).toBe(1);
    expect(remoteCalls).toBe(2);
  });
});
