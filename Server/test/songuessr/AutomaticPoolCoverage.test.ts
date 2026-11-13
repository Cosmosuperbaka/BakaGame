import { describe, expect, test } from "bun:test";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import {
  buildAutomaticCandidateTiers,
  collapseSameWorks,
  collectAutomaticCandidates,
} from "../../src/application/songuessr/AutomaticRounds";
import { installRound } from "../../src/application/songuessr/RoundInstall";
import { AppError } from "../../src/domain/Errors";
import type { MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import type { SongSearchResult, SonGuessrRoomSnapshot } from "../../src/shared/Index";
import { connection, createRoom, execute, lastEvent, makeSong, provider } from "./Fixtures";

/** 固定种子的伪随机，让统计性断言可复现。 */
const seeded = (seed: number) => {
  let state = seed >>> 0;
  return {
    nextInt: (maxExclusive: number) => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return Math.floor(unit * Math.max(1, maxExclusive));
    },
  };
};

const makePool = (size: number, prefix = "netease:"): SongSearchResult[] =>
  Array.from({ length: size }, (_, index) => ({
    id: `${prefix}${index}`,
    title: `曲目${index}`,
    artist: "测试歌手",
  }));

const startSoloService = async (
  musicProvider: MusicProvider,
  roomId: string,
  seed: number,
  poolSize: number
) => {
  const service = new SonGuessrService({ musicProvider, random: seeded(seed) });
  const solo = connection(service, `solo-${roomId}`);
  await createRoom(service, solo, {
    roomId,
    name: "覆盖",
    allowSpectators: false,
    userName: "独狼",
    solo: true,
  });
  await execute(service, solo, {
    id: "settings",
    type: "song.room.updateSettings",
    roomId,
    payload: {
      autoFilters: {
        playlist: { id: "42", name: "大池", songCount: poolSize },
        artists: [],
        minPopularity: 0,
      },
    },
  });
  /** 打一轮并返回结算后公开的答案 ID；开局失败时返回错误码。 */
  const playRound = async (round: number): Promise<{ id?: string; error?: string }> => {
    try {
      await execute(service, solo, {
        id: `start-${round}`,
        type: round === 1 ? "song.game.start" : "song.game.nextRound",
        roomId,
        payload: {},
      });
    } catch (error) {
      return { error: error instanceof AppError ? error.code : String(error) };
    }
    await execute(service, solo, {
      id: `giveup-${round}`,
      type: "song.game.giveUp",
      roomId,
      payload: {},
    });
    const settled = lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
    return { id: settled.roundSummary!.song.id };
  };
  return { service, playRound };
};

describe("自动出题的候选池覆盖与去重", () => {
  test("1000 首歌单：400 轮覆盖面铺满整池且窗口内零重复", async () => {
    const pool = makePool(1000);
    const picked: string[] = [];
    const music: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "大池", songCount: pool.length },
        songs: pool,
      }),
      getSong: async (id) => makeSong(id, `曲目${id}`, 2020),
    };
    const { playRound } = await startSoloService(music, "6001", 11, pool.length);
    for (let round = 1; round <= 400; round += 1) {
      const result = await playRound(round);
      expect(result.error).toBeUndefined();
      picked.push(result.id!);
    }
    // 窗口是 500，400 轮内任何重复都说明去重失效。
    expect(new Set(picked).size).toBe(400);
    // 抽样范围要铺满整个歌单，而不是集中在前面或某一段。
    const indices = picked.map((id) => Number(id.split(":")[1]));
    for (let bucket = 0; bucket < 10; bucket += 1) {
      const inBucket = indices.filter(
        (index) => index >= bucket * 100 && index < (bucket + 1) * 100
      );
      expect(inBucket.length).toBeGreaterThan(20);
      expect(inBucket.length).toBeLessThan(60);
    }
  });

  test("同一首歌的多个 ID 合并成一首：窗口内不会再听到同名版本", async () => {
    // 20 首作品，每首在歌单里出现两次：录音室版和现场版，ID 不同。
    const pool: SongSearchResult[] = Array.from({ length: 40 }, (_, index) => {
      const work = Math.floor(index / 2);
      return {
        id: `netease:${index}`,
        title: index % 2 === 0 ? `作品${work}` : `作品${work} (Live)`,
        artist: "测试歌手",
      };
    });
    const titleOf = new Map(pool.map((song) => [song.id, song.title.replace(" (Live)", "")]));
    const music: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "同名池", songCount: pool.length },
        songs: pool,
      }),
      getSong: async (id) => makeSong(id, titleOf.get(id)!, 2020),
    };
    const { playRound } = await startSoloService(music, "6009", 23, pool.length);
    const heard: string[] = [];
    for (let round = 1; round <= 30; round += 1) {
      const result = await playRound(round);
      expect(result.error).toBeUndefined();
      heard.push(titleOf.get(result.id!)!);
    }
    // 20 首作品的窗口是 10：任意连续 11 轮里同一作品只能出现一次。
    for (let start = 0; start + 11 <= heard.length; start += 1) {
      const slice = heard.slice(start, start + 11);
      expect(new Set(slice).size).toBe(slice.length);
    }
    expect(new Set(heard).size).toBeGreaterThan(10);
  });

  test("多数候选走跨平台兜底或取不到时，原候选仍被去重且失败轮数有限", async () => {
    const pool = makePool(1000);
    // 每 5 首：0 直接可播；1 兜底到另一平台（返回的 ID 与候选不同，且多个候选兜到同一首）；其余取不到。
    const music: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "大池", songCount: pool.length },
        songs: pool,
      }),
      getSong: async (id) => {
        const index = Number(id.split(":")[1]);
        if (index % 5 === 0) return makeSong(id, `曲目${index}`, 2020);
        if (index % 5 === 1) return makeSong(`qq:alt-${index % 7}`, `兜底${index % 7}`, 2020);
        throw new AppError("SONG_UNAVAILABLE", "该歌曲暂时没有可用播放地址");
      },
    };
    const { service, playRound } = await startSoloService(music, "6002", 23, pool.length);
    const picked: string[] = [];
    let failedRounds = 0;
    for (let round = 1; picked.length < 120 && round <= 400; round += 1) {
      const result = await playRound(round);
      if (result.error) {
        failedRounds += 1;
        continue;
      }
      picked.push(result.id!);
    }
    expect(picked).toHaveLength(120);
    const directPicks = picked.filter((id) => id.startsWith("netease:"));
    expect(new Set(directPicks).size).toBe(directPicks.length);
    // 兜底成功的歌：候选 ID 和实际播放的 ID 都进近期窗口，候选每轮恰好记一条。
    const recent = service.rooms.get("6002")!.recentSongIds!;
    expect(recent.filter((id) => id.startsWith("netease:"))).toHaveLength(120);
    expect(new Set(recent).size).toBe(recent.length);
    // 失败候选被记下后不再每轮占用尝试次数，失败轮数应远小于盲抽的期望。
    expect(failedRounds).toBeLessThan(40);
  });

  test("限流的平台本轮退场，改抽别的平台的候选", async () => {
    const qqPool = makePool(30, "qq:").map((song) => ({ ...song, artist: "另一位歌手" }));
    const pool = [...makePool(30, "netease:"), ...qqPool];
    const tried: string[] = [];
    const music: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "混合", songCount: pool.length },
        songs: pool,
      }),
      getSong: async (id) => {
        tried.push(id);
        if (id.startsWith("netease:")) {
          throw new AppError("MUSIC_API_RATE_LIMITED", "操作频繁，请稍候再试");
        }
        return makeSong(id, id, 2020);
      },
    };
    const { playRound } = await startSoloService(music, "6003", 5, pool.length);
    for (let round = 1; round <= 6; round += 1) {
      const result = await playRound(round);
      expect(result.error).toBeUndefined();
      expect(result.id!.startsWith("qq:")).toBe(true);
    }
    // 每轮至多撞两次网易云的限流（含账号回落重试），就该换平台，而不是把 5 次尝试全砸在同一条限流线上。
    expect(tried.filter((id) => id.startsWith("netease:")).length).toBeLessThanOrEqual(12);
  });

  test("所有候选所在平台都被限流时如实报限流，而不是说歌不能播", async () => {
    const pool = makePool(30);
    const music: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "网易云", songCount: pool.length },
        songs: pool,
      }),
      getSong: async () => {
        throw new AppError("MUSIC_API_RATE_LIMITED", "操作频繁，请稍候再试");
      },
    };
    const { playRound } = await startSoloService(music, "6004", 9, pool.length);
    expect((await playRound(1)).error).toBe("MUSIC_API_RATE_LIMITED");
  });
});

describe("自动出题的取曲提示与失败留痕", () => {
  test("取曲时带上题库里的标题与歌手，供原平台限流时跨平台兜底", async () => {
    const pool = makePool(5);
    const hints: unknown[] = [];
    const music: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "小池", songCount: pool.length },
        songs: pool,
      }),
      getSong: async (id, _cookie, options) => {
        hints.push(options?.hint);
        return makeSong(id, id, 2020);
      },
    };
    const { playRound } = await startSoloService(music, "6005", 3, pool.length);
    expect((await playRound(1)).error).toBeUndefined();
    expect(hints).toHaveLength(1);
    expect(hints[0]).toEqual(
      expect.objectContaining({ artist: "测试歌手", title: expect.stringMatching(/^曲目\d$/) })
    );
  });

  test("自动开局失败时留下带错误码的日志，并原样抛出", async () => {
    const written: Array<{ type: string; payload?: unknown }> = [];
    const music: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "空池", songCount: 0 },
        songs: [],
      }),
    };
    const service = new SonGuessrService({
      musicProvider: music,
      random: seeded(1),
      eventLogger: {
        write: (entry: { type: string; payload?: unknown }) => written.push(entry),
      } as never,
    });
    const solo = connection(service, "solo-log");
    await createRoom(service, solo, {
      roomId: "6006",
      name: "日志",
      allowSpectators: false,
      userName: "独狼",
      solo: true,
    });
    await expect(
      execute(service, solo, { id: "start", type: "song.game.start", roomId: "6006", payload: {} })
    ).rejects.toMatchObject({ code: "AUTO_NO_MATCH" });
    expect(written.find((entry) => entry.type === "song.auto.failed")?.payload).toEqual(
      expect.objectContaining({ code: "AUTO_NO_MATCH" })
    );
  });
});

describe("collapseSameWorks", () => {
  const song = (id: string, title: string, artist = "歌手甲"): SongSearchResult => ({
    id,
    title,
    artist,
  });
  const always = () => true;

  test("版本后缀不同算同一首，翻唱的不同歌手不合并", () => {
    const works = collapseSameWorks(
      [
        song("a", "晴天"),
        song("b", "晴天 (Live)"),
        song("c", "晴天 - 伴奏"),
        song("d", "晴天", "歌手乙"),
        song("e", "雨天"),
      ],
      [],
      always
    );
    expect(works.map((work) => work.id)).toEqual(["a", "d", "e"]);
  });

  test("合作歌手只看第一位", () => {
    const works = collapseSameWorks(
      [song("a", "晴天", "歌手甲"), song("b", "晴天", "歌手甲 / 歌手乙")],
      [],
      always
    );
    expect(works).toHaveLength(1);
  });

  test("优先留近期播过的 ID，否则窗口认不出它", () => {
    const works = collapseSameWorks([song("a", "晴天"), song("b", "晴天 (Live)")], ["b"], always);
    expect(works.map((work) => work.id)).toEqual(["b"]);
  });

  test("没有近期记录时优先留能播的", () => {
    const works = collapseSameWorks(
      [song("a", "晴天"), song("b", "晴天 (Live)")],
      [],
      (candidate) => candidate.id === "b"
    );
    expect(works.map((work) => work.id)).toEqual(["b"]);
  });

  test("曲名规范化后为空时按 ID 保留，不互相吞掉", () => {
    const works = collapseSameWorks([song("a", "!!!"), song("b", "???")], [], always);
    expect(works).toHaveLength(2);
  });
});

describe("buildAutomaticCandidateTiers", () => {
  test("近期窗口里的歌进回收层，按最久没播的先出", () => {
    const tiers = buildAutomaticCandidateTiers(
      makePool(5),
      ["netease:1", "netease:3", "netease:2"],
      new Set(),
      () => true
    );
    expect(tiers.fresh).toBe(2);
    const recycled = tiers.tiers.find((tier) => tier.name === "recycled")!;
    expect(recycled.songs.map((song) => song.id)).toEqual(["netease:2", "netease:3", "netease:1"]);
  });

  test("取不到的候选落在最后一层，不可播的候选排在可播之后", () => {
    const pool: SongSearchResult[] = [
      ...makePool(3),
      { id: "qq:vip", title: "会员曲", artist: "歌手", requiresVip: true },
    ];
    const tiers = buildAutomaticCandidateTiers(
      pool,
      [],
      new Set(["netease:0"]),
      (song) => !song.id.startsWith("qq:")
    );
    const byName = Object.fromEntries(
      tiers.tiers.map((tier) => [tier.name, tier.songs.map((song) => song.id)])
    );
    expect(byName["fresh-playable"]).toEqual(["netease:1", "netease:2"]);
    expect(byName["fresh-unplayable"]).toEqual(["qq:vip"]);
    expect(byName.unavailable).toEqual(["netease:0"]);
  });
});

describe("近期窗口的写入", () => {
  const prepare = async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: seeded(5) });
    const solo = connection(service, "solo-window");
    await createRoom(service, solo, {
      roomId: "7301",
      name: "窗口",
      allowSpectators: false,
      userName: "独狼",
      solo: true,
    });
    const room = service.rooms.get("7301")!;
    room.recentSongIds = Array.from({ length: 300 }, (_, index) => `netease:old-${index}`);
    return { service, room };
  };

  test("手动出题或猜番这类不带池子的回合不会把长窗口截短", async () => {
    const { service, room } = await prepare();
    installRound(service.ctx, room, makeSong("netease:manual", "手动", 2020), "");
    expect(room.recentSongIds).toHaveLength(301);
    expect(room.recentSongIds?.[0]).toBe("netease:manual");
    expect(room.recentSongIds).toContain("netease:old-299");
  });

  test("跨平台兜底时候选和实际播放的歌都进窗口", async () => {
    const { service, room } = await prepare();
    installRound(
      service.ctx,
      room,
      makeSong("qq:played", "兜底", 2020),
      "",
      undefined,
      undefined,
      undefined,
      "netease:candidate"
    );
    expect(room.recentSongIds?.slice(0, 2)).toEqual(["netease:candidate", "qq:played"]);
    expect(room.recentSongIds).toHaveLength(302);
  });
});

describe("热度筛选与 QQ 候选", () => {
  /** 聚合层对 QQ 没有热度来源，直接回空；网易云按表给值。 */
  const prepare = async (songs: SongSearchResult[], neteasePopularity: Record<string, number>) => {
    const lookups: string[] = [];
    const musicProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "歌单", songCount: songs.length },
        songs,
      }),
      getSongPopularity: async (songId) => {
        lookups.push(songId);
        return songId.startsWith("qq:") ? undefined : neteasePopularity[songId];
      },
    };
    const service = new SonGuessrService({ musicProvider, random: seeded(1) });
    const solo = connection(service, "heat-solo");
    await createRoom(service, solo, { roomId: "7401", name: "热度", solo: true });
    await execute(service, solo, {
      id: "heat-settings",
      type: "song.room.updateSettings",
      roomId: "7401",
      payload: {
        autoFilters: {
          playlist: { id: "42", name: "歌单", songCount: songs.length },
          artists: [],
          minPopularity: 1_000,
        },
      },
    });
    return { service, room: service.rooms.get("7401")!, lookups };
  };
  const song = (id: string, popularity?: number): SongSearchResult => ({
    id,
    title: id,
    artist: "歌手",
    ...(popularity === undefined ? {} : { popularity }),
  });

  test("开启热度筛选时 QQ 候选不因缺热度落选，也不回源查热度；网易云照常按热度筛", async () => {
    const { service, room, lookups } = await prepare(
      [song("netease:hot"), song("netease:cold"), song("qq:any")],
      { "netease:hot": 5_000, "netease:cold": 500 }
    );
    const result = await collectAutomaticCandidates(service.ctx, room, undefined);
    expect(result.map((item) => item.id).sort()).toEqual(["netease:hot", "qq:any"]);
    expect(lookups.some((id) => id.startsWith("qq:"))).toBe(false);
  });

  test("网易云候选已带热度时 QQ 候选照样保留", async () => {
    const { service, room, lookups } = await prepare(
      [song("netease:hot", 5_000), song("netease:cold", 10), song("qq:any")],
      {}
    );
    const result = await collectAutomaticCandidates(service.ctx, room, undefined);
    expect(result.map((item) => item.id).sort()).toEqual(["netease:hot", "qq:any"]);
    expect(lookups).toEqual([]);
  });

  test("音乐接口不支持查热度时，只剩没有热度来源的 QQ 候选", async () => {
    const { service, room } = await prepare([song("netease:any"), song("qq:any")], {});
    const musicProvider = service.options.musicProvider as { getSongPopularity?: unknown };
    delete musicProvider.getSongPopularity;
    const result = await collectAutomaticCandidates(service.ctx, room, undefined);
    expect(result.map((item) => item.id)).toEqual(["qq:any"]);
  });

  test("只有网易云候选且都不达标时仍然没有候选", async () => {
    const { service, room } = await prepare([song("netease:cold")], { "netease:cold": 500 });
    expect(await collectAutomaticCandidates(service.ctx, room, undefined)).toEqual([]);
  });
});
