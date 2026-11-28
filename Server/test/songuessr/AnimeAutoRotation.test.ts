import { describe, expect, test } from "bun:test";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import { AppError } from "../../src/domain/Errors";
import type { MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import type { BangumiSubjectDetails, SonGuessrRoomSnapshot } from "../../src/shared/Index";
import { fakeBangumiProvider } from "../support/Providers";
import { anime, connection, createRoom, execute, lastEvent, makeSong, provider } from "./Fixtures";

/** 固定种子的伪随机（mulberry32），让抽取顺序可复现。 */
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

/** 第 index 部番剧：一首同名关联曲；`withMusic` 为假时没有关联曲，出不了题。 */
const subject = (index: number, withMusic = true): BangumiSubjectDetails => ({
  ...anime,
  id: `subject-${index}`,
  name: `Anime ${index}`,
  nameCn: `番剧${index}`,
  musicTracks: withMusic ? [{ title: `主题曲${index}`, artist: "测试歌手", kind: "opening" }] : [],
});

/**
 * 单人猜番房：题库是给定的番剧列表，每部番的关联曲都能在音乐平台搜到、能播。
 * 按真人节奏推进注入时钟（每轮一秒），每连接的命令总额度才不会被循环打满。
 */
const startAnimeRotation = async (
  subjects: BangumiSubjectDetails[],
  seed: number,
  options: { missingIds?: string[] } = {}
) => {
  const { missingIds = [] } = options;
  const byId = new Map(subjects.map((item) => [item.id, item]));
  const musicProvider: MusicProvider = {
    ...provider,
    search: async (keyword) => {
      const title = keyword.split(" ")[0];
      return [makeSong(`netease:${title}`, title, 2024)];
    },
    getSong: async (id) => makeSong(id, id.replace("netease:", ""), 2024),
  };
  const bangumiProvider = fakeBangumiProvider({
    searchSubjects: async () => subjects,
    // 搜索结果里有、取详情却查不到：索引与库不同步时会这样。
    getSubject: async (id) => {
      if (missingIds.includes(id))
        throw new AppError("BANGUMI_SUBJECT_NOT_FOUND", "番剧条目不存在");
      return byId.get(id)!;
    },
  });
  let clock = Date.now();
  const service = new SonGuessrService({
    musicProvider,
    bangumiProvider,
    random: seeded(seed),
    now: () => clock,
  });
  const roomId = "8101";
  const solo = connection(service, `anime-rotation-${seed}`);
  await createRoom(service, solo, { roomId, name: "猜番轮换", userName: "独狼", solo: true });
  await execute(service, solo, {
    id: "settings",
    type: "song.room.updateSettings",
    roomId,
    payload: { questionType: "anime" },
  });
  let started = false;
  /** 打一轮并返回结算后公开的番剧 ID；开局失败时返回错误码。 */
  const playRound = async (round: number): Promise<{ id?: string; error?: string }> => {
    clock += 1_000;
    try {
      await execute(service, solo, {
        id: `round-${round}`,
        type: started ? "song.game.nextRound" : "song.game.start",
        roomId,
        payload: {},
      });
    } catch (error) {
      return { error: error instanceof AppError ? error.code : String(error) };
    }
    started = true;
    await execute(service, solo, {
      id: `giveup-${round}`,
      type: "song.game.giveUp",
      roomId,
      payload: {},
    });
    const settled = lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
    return { id: settled.roundSummary!.anime!.id };
  };
  return { service, roomId, playRound };
};

describe("自动猜番的番剧轮换", () => {
  test("筛选池里的番剧出完一遍之前不重复，第二遍也不按第一遍的顺序重放", async () => {
    const subjects = Array.from({ length: 30 }, (_, index) => subject(index));
    const { playRound } = await startAnimeRotation(subjects, 7);
    const picked: string[] = [];
    for (let round = 1; round <= 60; round += 1) {
      const result = await playRound(round);
      expect(result.error).toBeUndefined();
      picked.push(result.id!);
    }
    expect(new Set(picked.slice(0, 30)).size).toBe(30);
    // 30 部的回收窗口是 24：任意连续 25 轮不重复。
    for (let start = 0; start + 25 <= picked.length; start += 1) {
      expect(new Set(picked.slice(start, start + 25)).size).toBe(25);
    }
    expect(picked.slice(30, 60)).not.toEqual(picked.slice(0, 30));
  });

  test("出不了题的番剧记下后排到最后，不再每轮耗尽尝试次数", async () => {
    // 10 部里只有 2 部有关联曲。没出过的番剧优先抽，出不了题的若不单独记下，
    // 能出题的两部都出过之后，每轮都会先撞上它们、把尝试次数耗光。
    const subjects = Array.from({ length: 10 }, (_, index) => subject(index, index < 2));
    const { service, roomId, playRound } = await startAnimeRotation(subjects, 3);
    const picked: string[] = [];
    let failedRounds = 0;
    for (let round = 1; picked.length < 12 && round <= 40; round += 1) {
      const result = await playRound(round);
      if (result.error) {
        expect(result.error).toBe("BANGUMI_NO_MUSIC");
        failedRounds += 1;
        continue;
      }
      picked.push(result.id!);
    }
    expect(picked).toHaveLength(12);
    expect(new Set(picked)).toEqual(new Set(["subject-0", "subject-1"]));
    // 8 部出不了题的番剧，每轮最多试 5 部：至多两轮之后它们全被记下。
    expect(failedRounds).toBeLessThanOrEqual(2);
    expect(Object.keys(service.rooms.get(roomId)!.unavailableSubjectIds ?? {})).toHaveLength(8);
  });

  test("取详情查不到的番剧跳过并记下，不让整轮开局失败", async () => {
    const subjects = Array.from({ length: 5 }, (_, index) => subject(index));
    const missingIds = ["subject-1", "subject-2", "subject-3", "subject-4"];
    const { service, roomId, playRound } = await startAnimeRotation(subjects, 5, { missingIds });
    // 四部查不到、只有一部能出：每轮最多试五部，先撞上查不到的也要接着试下去。
    for (let round = 1; round <= 3; round += 1) {
      const result = await playRound(round);
      expect(result.error).toBeUndefined();
      expect(result.id).toBe("subject-0");
    }
    expect(Object.keys(service.rooms.get(roomId)!.unavailableSubjectIds ?? {}).sort()).toEqual(
      missingIds
    );
  });
});
