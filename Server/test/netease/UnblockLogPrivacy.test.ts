import { afterEach, describe, expect, test } from "bun:test";
import { NeteaseMusicProvider } from "../../src/infrastructure/music/netease/NeteaseMusicProvider";

type LogEntry = { level: string; message: string; context?: Record<string, unknown> };

const createLogger = () => {
  const entries: LogEntry[] = [];
  const record = (level: string) => (message: string, context?: Record<string, unknown>) => {
    entries.push({ level, message, context });
  };
  return {
    entries,
    logger: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
  };
};

const restrictedApi = (unblockedUrl: string) => async () => ({
  song_detail: async () => ({
    body: { songs: [{ id: 88, name: "版权受限曲", ar: [{ name: "歌手" }] }] },
  }),
  song_url: async () => ({ body: { data: [{ id: 88, url: null, code: 404 }] } }),
  song_url_match: async () => ({ body: { code: 200, data: unblockedUrl } }),
  lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]测试歌词" } } }),
});

describe("解灰日志脱敏", () => {
  test("解灰成功日志只带直链的主机，不带完整地址与查询串里的令牌", async () => {
    const { entries, logger } = createLogger();
    const secretUrl = "https://unblock.example.com/path/88.mp3?token=SECRET_TOKEN_123&expire=999";
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      logger: logger as never,
      loadApi: restrictedApi(secretUrl),
    });

    const song = await provider.getSong("88");
    expect(song.audioUrl).toBe(secretUrl);

    const success = entries.find((entry) => entry.message === "网易云歌曲解灰成功");
    expect(success).toBeDefined();
    expect(success?.context).toMatchObject({ songId: "88", audioHost: "unblock.example.com" });
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("SECRET_TOKEN_123");
    expect(serialized).not.toContain(secretUrl);
    expect(serialized).not.toContain("/path/88.mp3");
  });
});

describe("解灰开关同步到接口包的环境变量", () => {
  const original = process.env.ENABLE_GENERAL_UNBLOCK;
  afterEach(() => {
    if (original === undefined) delete process.env.ENABLE_GENERAL_UNBLOCK;
    else process.env.ENABLE_GENERAL_UNBLOCK = original;
  });

  test("构造时同步一次；受限歌曲触发解灰判定时按当时的开关值再同步", async () => {
    let enabled = true;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      enableGeneralUnblock: () => enabled,
      loadApi: restrictedApi("https://unblock.example.com/88.mp3"),
    });
    expect(process.env.ENABLE_GENERAL_UNBLOCK).toBe("true");

    enabled = false;
    // 构造之后运行期改开关：不受限的请求路径不碰环境变量，受限歌曲判定时才同步。
    expect(process.env.ENABLE_GENERAL_UNBLOCK).toBe("true");
    await expect(provider.getSong("88")).rejects.toMatchObject({ code: "SONG_UNAVAILABLE" });
    expect(process.env.ENABLE_GENERAL_UNBLOCK).toBe("false");

    enabled = true;
    await expect(provider.refreshSongAudio("88")).resolves.toBe(
      "https://unblock.example.com/88.mp3"
    );
    expect(process.env.ENABLE_GENERAL_UNBLOCK).toBe("true");
  });
});
