import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { SonGuessrService } from "../../src/application/SonGuessrService";
import { tabSeatId } from "../../src/application/TabSeat";
import { DEFAULT_SETTINGS } from "../../src/application/songuessr/Records";
import type { BangumiDataProvider } from "../../src/infrastructure/BangumiDataProvider";
import { fakeBangumiProvider } from "../support/Providers";
import type { EventLogger } from "../../src/infrastructure/EventLogger";
import {
  SensitiveTextFilter,
  setSensitiveTextFilterForTest,
} from "../../src/infrastructure/SensitiveText";
import type { MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import type { SonGuessrRoomSnapshot } from "../../src/shared/Index";
import { TEST_ROOMS_ON } from "../TestRoomPolicy";
import {
  anime,
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  provider,
  songs,
  startRound,
} from "./Fixtures";
import type { TestConnection } from "./Fixtures";

/**
 * 回合流转（开局、选出题人、下一回合、结束）的边界用例：每条对着一处「await 之后的复核」
 * 「同步占位与回滚」「守卫式提前返回」或状态清理，行为通过命令入口驱动。
 */

const defer = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

/** 让已发出的命令走完同步段并停在第一个 await 上。 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("应当被拒绝");
};

const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
});

interface SetupOptions {
  guests?: number;
  settings?: Record<string, unknown>;
  solo?: boolean;
  /** 额外覆盖音乐接口。 */
  music?: Partial<MusicProvider>;
  ready?: boolean;
  testRoom?: boolean;
  hasher?: {
    hash(password: string): Promise<string>;
    verify(password: string, digest: string): Promise<boolean>;
  };
  allowSpectators?: boolean;
  bangumi?: BangumiDataProvider;
}

/** 登录状态校验可按 Cookie 卡住：开局复核停在 await 上时，用例在这段空档里改房间。 */
const setup = async (options: SetupOptions = {}) => {
  const gates = new Map<string, ReturnType<typeof defer<void>>>();
  const hold = (cookie: string) => {
    const gate = defer();
    gates.set(cookie, gate);
    releases.push(() => gate.resolve());
    return gate;
  };
  const musicProvider: MusicProvider = {
    ...provider,
    getLoginStatus: async (cookie, platform) => {
      const gate = gates.get(cookie);
      if (gate) await gate.promise;
      return {
        cookie,
        account: {
          platform: platform === "qq" ? "qq" : "netease",
          nickname: `账号-${platform ?? "netease"}`,
          vipStatus: "vip",
        },
      };
    },
    getPlaylistSongs: async () => ({
      info: { id: "42", name: "测试歌单", songCount: 1 },
      songs: [songs.answer],
    }),
    ...options.music,
  };
  // 每条命令前把时钟推过大厅合并窗，大厅变更都会立即下发，便于断言「发过大厅更新」。
  let now = 1_000_000;
  const logged: Array<{ type: string; roomId?: string }> = [];
  const warned: string[] = [];
  const service = new SonGuessrService({
    musicProvider,
    random: { nextInt: () => 0 },
    now: () => now,
    eventLogger: {
      write: (event: { type: string; roomId?: string }) => logged.push(event),
      warn: (message: string) => warned.push(message),
    } as unknown as EventLogger,
    ...(options.hasher ? { passwordHasher: options.hasher } : {}),
    ...(options.bangumi ? { bangumiProvider: options.bangumi } : {}),
    ...(options.testRoom ? { testRooms: TEST_ROOMS_ON } : {}),
  });
  const roomId = options.testRoom ? "Oblivionis" : "1234";
  const host = connection(service, "host");
  await createRoom(service, host, {
    roomId,
    ...(options.solo ? { solo: true } : {}),
    ...(options.allowSpectators === undefined ? {} : { allowSpectators: options.allowSpectators }),
  });
  const guests: Array<{ client: TestConnection; id: string }> = [];
  for (let index = 0; index < (options.guests ?? 1); index += 1) {
    if (options.solo) break;
    const client = connection(service, `guest-${index}`);
    const state = await joinRoom(service, client, `玩家${index}`, roomId);
    guests.push({ client, id: state.playerId });
  }
  const send = <T = unknown>(
    who: TestConnection,
    type: string,
    payload: Record<string, unknown> = {}
  ) => {
    now += 300;
    return execute<T>(service, who, {
      id: `${type}-${Math.random()}`,
      type,
      roomId,
      payload,
    } as never);
  };
  if (options.settings) await send(host, "song.room.updateSettings", options.settings);
  if (options.ready !== false) {
    for (const guest of guests) await send(guest.client, "song.player.setReady", { ready: true });
  }
  const room = () => service.rooms.get(roomId)!;
  const lobby = connection(service, "lobby");
  await execute(service, lobby, {
    id: "sub",
    type: "song.lobby.subscribeRooms",
    payload: {},
  } as never);
  const lobbyFrames = () => lobby.sent.filter((item) => item.event === "song.lobby.rooms").length;
  return {
    service,
    host,
    guests,
    send,
    room,
    hold,
    logged,
    warned,
    lobbyFrames,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    hostId: room().hostPlayerId,
    snapshot: () => lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot"),
  };
};

type Game = Awaited<ReturnType<typeof setup>>;

/** 开局复核卡在房主账号的登录状态上，返回「复核期间」的开局请求与放行函数。 */
const startHeld = async (game: Game) => {
  const gate = game.hold("MUSIC_U=test-host");
  const start = game.send(game.host, "song.game.start");
  const outcome = start.then(
    (value) => ({ value }),
    (error: { code: string; message: string }) => ({ error })
  );
  await settle();
  return { gate, outcome };
};

describe("开局：账号接口与跨 await 复核", () => {
  test("音乐接口没有登录状态校验时开局被拒为不可用", async () => {
    const game = await setup();
    game.service.options.musicProvider.getLoginStatus = undefined;
    const error = await rejection(game.send(game.host, "song.game.start"));
    expect(error.code).toBe("MUSIC_AUTH_UNAVAILABLE");
    expect(game.room().phase).toBe("waiting");
  });

  test("复核期间房主已换人：开局作废，会话变更而不是开出一局", async () => {
    const game = await setup();
    const { gate, outcome } = await startHeld(game);
    await game.send(game.host, "song.room.transferHost", { playerId: game.guests[0]!.id });
    gate.resolve();
    expect(await outcome).toMatchObject({
      error: { code: "MUSIC_SESSION_INVALID", message: "音乐会话已变更，请重新开始" },
    });
    expect(game.room().phase).toBe("waiting");
    expect(game.room().roundNumber).toBe(0);
  });

  test("复核期间房间已被关闭：以会话变更拒绝", async () => {
    const game = await setup();
    const { gate, outcome } = await startHeld(game);
    game.service.rooms.delete("1234");
    gate.resolve();
    expect(await outcome).toMatchObject({ error: { code: "MUSIC_SESSION_INVALID" } });
  });

  test("复核期间房主连接已离房：以会话变更拒绝", async () => {
    const game = await setup();
    const { gate, outcome } = await startHeld(game);
    game.host.record.roomId = undefined;
    gate.resolve();
    expect(await outcome).toMatchObject({ error: { code: "MUSIC_SESSION_INVALID" } });
    expect(game.room().phase).toBe("waiting");
  });

  test("复核期间连接已换到别的席位：以会话变更拒绝", async () => {
    const game = await setup();
    const { gate, outcome } = await startHeld(game);
    game.host.record.playerId = "other-seat";
    gate.resolve();
    expect(await outcome).toMatchObject({ error: { code: "MUSIC_SESSION_INVALID" } });
    expect(game.room().phase).toBe("waiting");
  });

  test("复核期间房主已离线：以会话变更拒绝", async () => {
    const game = await setup();
    const { gate, outcome } = await startHeld(game);
    game.room().players[game.hostId]!.online = false;
    gate.resolve();
    expect(await outcome).toMatchObject({ error: { code: "MUSIC_SESSION_INVALID" } });
    expect(game.room().phase).toBe("waiting");
  });

  test("复核期间房主清掉账号：开局作废并报网易云会话已变更", async () => {
    const game = await setup();
    const { gate, outcome } = await startHeld(game);
    await game.send(game.host, "song.auth.clear", { platform: "netease" });
    gate.resolve();
    expect(await outcome).toMatchObject({
      error: { code: "MUSIC_SESSION_INVALID", message: "网易云会话已变更，请重新开始" },
    });
    expect(game.room().phase).toBe("waiting");
  });

  test("复核期间同一人又发起一次登录：旧开局复核作废", async () => {
    const game = await setup();
    const { gate, outcome } = await startHeld(game);
    game.hold("MUSIC_U=second");
    void game.send(game.host, "song.auth.useCookie", {
      cookie: "MUSIC_U=second",
      platform: "netease",
    });
    await settle();
    gate.resolve();
    expect(await outcome).toMatchObject({
      error: { code: "MUSIC_SESSION_INVALID", message: "网易云会话已变更，请重新开始" },
    });
    expect(game.room().phase).toBe("waiting");
  });

  test("复核期间阶段被推走：开局作废，不覆盖现有阶段", async () => {
    const game = await setup();
    const { gate, outcome } = await startHeld(game);
    (game.room() as { phase: string }).phase = "roundResult";
    gate.resolve();
    expect(await outcome).toMatchObject({ error: { code: "ROUND_EXPIRED" } });
    expect(game.room().phase).toBe("roundResult");
  });

  test("两端都有号时只复核当前这一端：别端的账号变动不连累本端复核", async () => {
    const game = await setup();
    await game.send(game.host, "song.auth.useCookie", {
      cookie: "QQ_KEY=host-qq",
      platform: "qq",
    });
    const gate = game.hold("QQ_KEY=host-qq");
    const start = game.send(game.host, "song.game.start");
    await settle();
    // 网易云那一号已经复核完毕；它此刻被清掉不该让 QQ 那一号的复核失败。
    await game.send(game.host, "song.auth.clear", { platform: "netease" });
    gate.resolve();
    await expect(start).resolves.toEqual({ started: true });
    expect(game.room().phase).toBe("choosingSubmitter");
  });
});

/** 回合记录的最小替身：只够让快照构建不报错，流转用例不读其余字段。 */
const roundStub = { players: {}, observerIds: [], attempts: [], audioReady: {} };

/** 把房间改成「上一轮遗留」的样子：开局、重开与回等待都得把这些清干净。 */
const injectStale = (game: Game) => {
  const room = game.room() as unknown as Record<string, unknown>;
  room.pendingSubmitterPlayerId = game.guests[0]?.id ?? "stale";
  room.pendingSubmitterDeadlineAt = 1;
  room.pendingSubmitterAssignedAt = 1;
  room.submitterPrompt = "遗留提示";
  room.currentRound = { number: 9, ...roundStub };
  room.roundSummary = { number: 9 };
  room.finalScores = [{ playerId: "stale" }];
};

const staleLeft = (game: Game) => {
  const room = game.room();
  return {
    pending: room.pendingSubmitterPlayerId,
    deadline: room.pendingSubmitterDeadlineAt,
    assigned: room.pendingSubmitterAssignedAt,
    prompt: room.submitterPrompt,
    round: room.currentRound,
    summary: room.roundSummary,
    finals: room.finalScores,
  };
};

const allCleared = {
  pending: undefined,
  deadline: undefined,
  assigned: undefined,
  prompt: undefined,
  round: undefined,
  summary: undefined,
  finals: undefined,
};

describe("开局：状态清理、门槛与大厅", () => {
  test("手动开局清掉上一局遗留的出题人、提示、回合、摘要与最终得分", async () => {
    const game = await setup();
    injectStale(game);
    const before = game.lobbyFrames();
    await expect(game.send(game.host, "song.game.start")).resolves.toEqual({ started: true });
    expect(game.room().phase).toBe("choosingSubmitter");
    expect(staleLeft(game)).toEqual(allCleared);
    expect(game.lobbyFrames()).toBeGreaterThan(before);
    expect(game.logged.some((event) => event.type === "song.game.started")).toBe(true);
  });

  test("开局先结算席位预约再查人数：预约成旁观后人数不足被拒", async () => {
    const game = await setup();
    game.room().players[game.guests[0]!.id]!.nextRoundMembership = "spectator";
    const error = await rejection(game.send(game.host, "song.game.start"));
    expect(error.code).toBe("NOT_ENOUGH_PLAYERS");
    expect(game.room().phase).toBe("waiting");
  });

  test("只有房主一人的非单人房开局被拒为人数不足", async () => {
    const game = await setup({ guests: 0 });
    expect((await rejection(game.send(game.host, "song.game.start"))).code).toBe(
      "NOT_ENOUGH_PLAYERS"
    );
  });

  test("有人未准备时开局被拒", async () => {
    const game = await setup({ ready: false });
    expect((await rejection(game.send(game.host, "song.game.start"))).code).toBe(
      "PLAYERS_NOT_READY"
    );
  });

  const playlist = {
    info: { id: "42", name: "歌单", songCount: 1 },
    songs: [songs.answer],
  };

  test("自动开局的抽题复核：阶段被推走时作废", async () => {
    const pending = defer<typeof playlist>();
    let slow = false;
    const game = await setup({
      settings: { questionMode: "automatic", autoFilters: { artists: [], minPopularity: 0 } },
      music: { getPlaylistSongs: async () => (slow ? pending.promise : playlist) },
    });
    slow = true;
    releases.push(() => pending.resolve(playlist));
    const outcome = game.send(game.host, "song.game.start").then(
      (value) => ({ value }),
      (error: { code: string }) => ({ error })
    );
    await settle();
    (game.room() as { phase: string }).phase = "choosingSubmitter";
    pending.resolve(playlist);
    expect(await outcome).toMatchObject({ error: { code: "ROUND_EXPIRED" } });
  });

  test("自动开局的抽题复核：开局操作被换掉时作废", async () => {
    const pending = defer<typeof playlist>();
    let slow = false;
    const game = await setup({
      settings: { questionMode: "automatic", autoFilters: { artists: [], minPopularity: 0 } },
      music: { getPlaylistSongs: async () => (slow ? pending.promise : playlist) },
    });
    slow = true;
    releases.push(() => pending.resolve(playlist));
    const outcome = game.send(game.host, "song.game.start").then(
      (value) => ({ value }),
      (error: { code: string }) => ({ error })
    );
    await settle();
    game.room().runtime!.automaticRoundOperation = Symbol("other");
    pending.resolve(playlist);
    expect(await outcome).toMatchObject({ error: { code: "ROUND_EXPIRED" } });
    expect(game.room().phase).toBe("waiting");
  });

  test("开局期间手动标记置位，结束后清掉", async () => {
    const game = await setup();
    const { gate, outcome } = await startHeld(game);
    expect(game.room().runtime?.manualRoundStarting).toBe(true);
    gate.resolve();
    await outcome;
    expect(game.room().runtime?.manualRoundStarting).toBe(false);
  });

  test("自动开局的锁已被后来者接手时，前一次收尾不清掉后来者的锁", async () => {
    const game = await setup({
      settings: { questionMode: "automatic", autoFilters: { artists: [], minPopularity: 0 } },
    });
    const { gate, outcome } = await startHeld(game);
    const runtime = game.room().runtime!;
    expect(runtime.automaticRoundLoading).toBe(true);
    const other = Symbol("later");
    runtime.automaticRoundOperation = other;
    game.room().players[game.hostId]!.online = false;
    gate.resolve();
    await outcome;
    expect(runtime.automaticRoundOperation).toBe(other);
    expect(runtime.automaticRoundLoading).toBe(true);
  });

  test("自动开局完成后操作号与加载标记都清掉", async () => {
    const game = await setup({
      settings: { questionMode: "automatic", autoFilters: { artists: [], minPopularity: 0 } },
    });
    await game.send(game.host, "song.game.start");
    const runtime = game.room().runtime!;
    expect(runtime.automaticRoundOperation).toBeUndefined();
    expect(runtime.automaticRoundLoading).toBe(false);
  });
});

const begin = async (game: Game) => {
  await game.send(game.host, "song.game.start");
  expect(game.room().phase).toBe("choosingSubmitter");
};

/** 直接把房间摆到回合结算阶段：本组用例只关心「下一回合」与「结束」自身的流转。 */
const toRoundResult = (game: Game, submitterId?: string) => {
  const room = game.room() as unknown as Record<string, unknown>;
  room.phase = "roundResult";
  room.currentRound = {
    number: 1,
    ...roundStub,
    submitterPlayerId: submitterId ?? game.hostId,
  };
  room.roundSummary = { number: 1 };
};

describe("选出题人与顺延时限", () => {
  test("目标不存在时报必须是在线真人", async () => {
    const game = await setup();
    await begin(game);
    expect(
      await rejection(game.send(game.host, "song.game.chooseSubmitter", { playerId: "nobody" }))
    ).toMatchObject({ code: "INVALID_TARGET", message: "出题人必须是在线真人玩家" });
  });

  test("离线的玩家不能被指定为出题人", async () => {
    const game = await setup();
    await begin(game);
    await game.service.unregisterConnection("guest-0");
    expect(
      await rejection(
        game.send(game.host, "song.game.chooseSubmitter", { playerId: game.guests[0]!.id })
      )
    ).toMatchObject({ code: "INVALID_TARGET", message: "出题人必须是在线真人玩家" });
  });

  test("被踢的玩家不能被指定为出题人", async () => {
    const game = await setup();
    await begin(game);
    game.room().players[game.guests[0]!.id]!.membership = "kicked";
    expect(
      await rejection(
        game.send(game.host, "song.game.chooseSubmitter", { playerId: game.guests[0]!.id })
      )
    ).toMatchObject({ code: "INVALID_TARGET", message: "出题人必须是在线真人玩家" });
  });

  test("测试机器人不能被指定为出题人", async () => {
    const game = await setup({ testRoom: true });
    await game.send(game.host, "song.test.addBot", { count: 1 });
    const bot = Object.values(game.room().players).find((player) => player.isBot)!;
    await begin(game);
    expect(
      await rejection(game.send(game.host, "song.game.chooseSubmitter", { playerId: bot.id }))
    ).toMatchObject({ code: "INVALID_TARGET", message: "出题人必须是在线真人玩家" });
  });

  test("指定后留不下在线猜歌玩家时被拒", async () => {
    const game = await setup({ guests: 2 });
    await begin(game);
    const first = game.guests[0]!;
    await game.service.unregisterConnection("guest-1");
    const room = game.room();
    room.players[game.hostId]!.team = 1;
    room.players[first.id]!.team = 1;
    expect(
      await rejection(game.send(game.host, "song.game.chooseSubmitter", { playerId: first.id }))
    ).toMatchObject({
      code: "INVALID_TARGET",
      message: "指定后没有可以猜歌的玩家：出题人的队友会一起观战",
    });
  });

  test("指定出题人：记待出题人与起算时刻，时限从此刻起，清提示与旧摘要并换阶段", async () => {
    const game = await setup();
    await begin(game);
    const room = game.room();
    room.submitterPrompt = "旧提示";
    (room as unknown as Record<string, unknown>).roundSummary = { number: 7 };
    const before = game.lobbyFrames();
    await game.send(game.host, "song.game.chooseSubmitter", { playerId: game.guests[0]!.id });
    expect(room.pendingSubmitterPlayerId).toBe(game.guests[0]!.id);
    expect(room.pendingSubmitterAssignedAt).toBe(game.now());
    expect(room.pendingSubmitterDeadlineAt).toBe(game.now() + 180_000);
    expect(room.submitterPrompt).toBeUndefined();
    expect(room.roundSummary).toBeUndefined();
    expect(room.phase).toBe("submittingSong");
    expect(game.lobbyFrames()).toBeGreaterThan(before);
  });

  /** 出题人提交歌曲：取歌被卡住，只看提交一开始就顺延的时限。 */
  const submitting = async (options: { elapsedMs: number; clearAssigned?: boolean }) => {
    const gate = defer();
    releases.push(() => gate.resolve());
    let slow = false;
    const game = await setup({
      music: {
        getSong: async (id) => {
          if (slow) await gate.promise;
          return songs[id as keyof typeof songs]!;
        },
        getSongMetadata: async (id) => {
          if (slow) await gate.promise;
          return songs[id as keyof typeof songs]!;
        },
      },
    });
    await begin(game);
    await game.send(game.host, "song.game.chooseSubmitter", { playerId: game.hostId });
    const room = game.room();
    if (options.clearAssigned) room.pendingSubmitterAssignedAt = undefined;
    const assignedAt = room.pendingSubmitterAssignedAt;
    game.advance(options.elapsedMs);
    slow = true;
    const submit = game.send(game.host, "song.game.submitSong", { songId: "answer" });
    await settle();
    return { game, room, assignedAt, gate, submit };
  };

  test("提交歌曲时限顺延到此刻再加一个时限", async () => {
    const { game, room, gate, submit } = await submitting({ elapsedMs: 100_000 });
    expect(room.pendingSubmitterDeadlineAt).toBe(game.now() + 180_000);
    gate.resolve();
    await submit;
  });

  test("顺延以指定时刻起算的两个时限封顶", async () => {
    const { room, assignedAt, gate, submit } = await submitting({ elapsedMs: 300_000 });
    expect(room.pendingSubmitterDeadlineAt).toBe(assignedAt! + 360_000);
    gate.resolve();
    await submit;
  });

  test("缺指定时刻时按此刻回退，不会被封顶成过去的时间", async () => {
    const { game, room, gate, submit } = await submitting({ elapsedMs: 1000, clearAssigned: true });
    expect(room.pendingSubmitterDeadlineAt).toBe(game.now() + 180_000);
    gate.resolve();
    await submit;
  });
});

describe("出题人失效时的释放", () => {
  const pendingGame = async () => {
    const game = await setup({ guests: 2 });
    await begin(game);
    await game.send(game.host, "song.game.chooseSubmitter", { playerId: game.guests[0]!.id });
    return game;
  };

  test("待出题人断线：回到选出题人，清掉时限并写下提示与公告", async () => {
    const game = await pendingGame();
    await game.service.unregisterConnection("guest-0");
    const room = game.room();
    expect(room.phase).toBe("choosingSubmitter");
    expect(room.pendingSubmitterPlayerId).toBeUndefined();
    expect(room.pendingSubmitterDeadlineAt).toBeUndefined();
    expect(room.pendingSubmitterAssignedAt).toBeUndefined();
    expect(room.submitterPrompt).toContain("断线，出题已中止");
    expect(room.chat.at(-1)?.text).toBe(room.submitterPrompt);
  });

  test("别人的断线不会把选题中的出题人踢下来", async () => {
    const game = await pendingGame();
    await game.service.unregisterConnection("guest-1");
    const room = game.room();
    expect(room.phase).toBe("submittingSong");
    expect(room.pendingSubmitterPlayerId).toBe(game.guests[0]!.id);
  });

  test("不在选题阶段时，待出题人断线不改阶段", async () => {
    const game = await pendingGame();
    const room = game.room();
    room.phase = "roundResult";
    await game.service.unregisterConnection("guest-0");
    expect(room.phase).toBe("roundResult");
    expect(room.submitterPrompt).toBeUndefined();
  });
});

describe("下一回合：手动出题", () => {
  const roundResultGame = async (settings: Record<string, unknown> = {}, guests = 2) => {
    const game = await setup({ guests, settings });
    toRoundResult(game);
    return game;
  };

  test("轮换开启：从上一位出题人的下一位开始，清旧提示与摘要、上一轮标记并设时限", async () => {
    const game = await roundResultGame({ autoRotateSubmitter: true });
    const room = game.room();
    room.submitterPrompt = "旧提示";
    room.players[game.guests[0]!.id]!.roundMarks = [{ kind: "correct" }] as never;
    const before = game.lobbyFrames();
    await expect(game.send(game.host, "song.game.nextRound")).resolves.toEqual({ nextRound: 1 });
    expect(room.currentRound).toBeUndefined();
    expect(room.roundSummary).toBeUndefined();
    expect(room.pendingSubmitterPlayerId).toBe(game.guests[0]!.id);
    expect(room.pendingSubmitterDeadlineAt).toBe(game.now() + 180_000);
    expect(room.submitterPrompt).toBeUndefined();
    expect(room.phase).toBe("submittingSong");
    expect(room.players[game.guests[0]!.id]!.roundMarks).toEqual([]);
    expect(game.lobbyFrames()).toBeGreaterThan(before);
  });

  test("轮换关闭：回到选出题人阶段并清掉上一轮标记", async () => {
    const game = await roundResultGame({ autoRotateSubmitter: false });
    const room = game.room();
    room.players[game.guests[0]!.id]!.roundMarks = [{ kind: "correct" }] as never;
    await game.send(game.host, "song.game.nextRound");
    expect(room.phase).toBe("choosingSubmitter");
    expect(room.players[game.guests[0]!.id]!.roundMarks).toEqual([]);
    expect(room.currentRound).toBeUndefined();
  });

  test("先结算席位预约再判人数：预约成旁观的玩家不参与轮换", async () => {
    const game = await roundResultGame({ autoRotateSubmitter: true });
    const room = game.room();
    room.players[game.guests[0]!.id]!.nextRoundMembership = "spectator";
    await game.send(game.host, "song.game.nextRound");
    expect(room.players[game.guests[0]!.id]!.membership).toBe("spectator");
    expect(room.players[game.guests[0]!.id]!.nextRoundMembership).toBeUndefined();
    expect(room.pendingSubmitterPlayerId).toBe(game.guests[1]!.id);
  });

  test("在线正式玩家不足两人：退回等待并重置准备、清时限提示与标记", async () => {
    const game = await setup({ guests: 1 });
    const room = game.room();
    await game.service.unregisterConnection("guest-0");
    injectStale(game);
    toRoundResult(game);
    room.players[game.guests[0]!.id]!.roundMarks = [{ kind: "wrong" }] as never;
    const before = game.lobbyFrames();
    await expect(game.send(game.host, "song.game.nextRound")).resolves.toEqual({
      nextRound: 1,
      waiting: true,
    });
    expect(room.phase).toBe("waiting");
    expect(staleLeft(game)).toMatchObject({
      pending: undefined,
      deadline: undefined,
      assigned: undefined,
      prompt: undefined,
    });
    expect(room.currentRound).toBeUndefined();
    expect(room.roundSummary).toBeUndefined();
    expect(room.players[game.guests[0]!.id]!.roundMarks).toEqual([]);
    expect(room.players[game.hostId]!.isReady).toBe(true);
    expect(room.players[game.guests[0]!.id]!.isReady).toBe(false);
    expect(game.lobbyFrames()).toBeGreaterThan(before);
  });

  test("只剩一名在线正式玩家（其余是旁观者）也算人数不足", async () => {
    const game = await roundResultGame({}, 1);
    game.room().players[game.guests[0]!.id]!.membership = "spectator";
    await expect(game.send(game.host, "song.game.nextRound")).resolves.toMatchObject({
      waiting: true,
    });
  });
});

describe("结束游戏", () => {
  test("清空出题人、回合、摘要、最终得分与标记，结算预约并重置准备", async () => {
    const game = await setup({ guests: 2 });
    toRoundResult(game);
    injectStale(game);
    const room = game.room();
    room.phase = "roundResult";
    room.players[game.guests[0]!.id]!.nextRoundMembership = "spectator";
    room.players[game.guests[1]!.id]!.roundMarks = [{ kind: "correct" }] as never;
    const runtime = (room.runtime ??= {});
    runtime.automaticRoundOperation = Symbol("op");
    runtime.automaticRoundLoading = true;
    await expect(game.send(game.host, "song.game.finish")).resolves.toMatchObject({
      waiting: true,
    });
    expect(game.room().phase).toBe("waiting");
    expect(staleLeft(game)).toEqual(allCleared);
    expect(runtime.automaticRoundOperation).toBeUndefined();
    expect(runtime.automaticRoundLoading).toBe(false);
    expect(room.players[game.guests[0]!.id]!.membership).toBe("spectator");
    expect(room.players[game.guests[1]!.id]!.roundMarks).toEqual([]);
    expect(room.players[game.guests[1]!.id]!.isReady).toBe(false);
    expect(room.players[game.hostId]!.isReady).toBe(true);
  });
});

const startPlaying = async (game: Game) => {
  await startRound(game.service, game.host, game.guests[0]!.client, game.hostId);
  expect(game.room().phase).toBe("playing");
};

describe("选歌提交：跨 await 复核与收尾", () => {
  const submittingGame = async () => {
    const gate = defer();
    releases.push(() => gate.resolve());
    let slow = false;
    const game = await setup({
      music: {
        getSong: async (id) => {
          if (slow) await gate.promise;
          return songs[id as keyof typeof songs]!;
        },
        getSongMetadata: async (id) => {
          if (slow) await gate.promise;
          return songs[id as keyof typeof songs]!;
        },
      },
    });
    await begin(game);
    await game.send(game.host, "song.game.chooseSubmitter", { playerId: game.hostId });
    slow = true;
    return { game, gate };
  };

  const heldSubmit = async (change: (game: Game) => void) => {
    const { game, gate } = await submittingGame();
    const submit = game.send(game.host, "song.game.submitSong", { songId: "answer" });
    await settle();
    change(game);
    gate.resolve();
    return { game, result: await submit };
  };

  test("取歌期间待出题人被换掉：提交被忽略，不装回合", async () => {
    const { game, result } = await heldSubmit((g) => {
      g.room().pendingSubmitterPlayerId = g.guests[0]!.id;
    });
    expect(result).toEqual({ ignored: true });
    expect(game.room().currentRound).toBeUndefined();
    expect(game.room().phase).toBe("submittingSong");
  });

  test("取歌期间出题人席位被换成另一份记录：提交被忽略", async () => {
    const { game, result } = await heldSubmit((g) => {
      const room = g.room();
      room.players[g.hostId] = { ...room.players[g.hostId]! };
    });
    expect(result).toEqual({ ignored: true });
    expect(game.room().currentRound).toBeUndefined();
  });

  test("提交歌曲成功后发大厅更新，回合进入进行中", async () => {
    const { game, gate } = await submittingGame();
    gate.resolve();
    const before = game.lobbyFrames();
    await expect(
      game.send(game.host, "song.game.submitSong", { songId: "answer" })
    ).resolves.toMatchObject({ roundNumber: 1 });
    expect(game.room().phase).toBe("playing");
    expect(game.lobbyFrames()).toBeGreaterThan(before);
  });

  test("预览歌曲要扣音乐额度：超出每连接额度后被限流", async () => {
    const game = await setup();
    await begin(game);
    await game.send(game.host, "song.game.chooseSubmitter", { playerId: game.hostId });
    const preview = () =>
      execute(game.service, game.host, {
        id: "preview",
        type: "song.music.detail",
        roomId: "1234",
        payload: { songId: "answer" },
      } as never);
    for (let index = 0; index < 20; index += 1) await preview();
    expect((await rejection(preview())).code).toBe("RATE_LIMITED");
  });

  test("预览歌曲跨 await 复核：待出题人被换后拒绝", async () => {
    const { game, gate } = await submittingGame();
    const preview = game.send(game.host, "song.music.detail", { songId: "answer" });
    const outcome = preview.then(
      (value) => ({ value }),
      (error: { code: string }) => ({ error })
    );
    await settle();
    game.room().pendingSubmitterPlayerId = game.guests[0]!.id;
    gate.resolve();
    expect(await outcome).toMatchObject({ error: { code: "NOT_SUBMITTER" } });
  });

  test("预览歌曲跨 await 复核：席位换成另一份记录后拒绝", async () => {
    const { game, gate } = await submittingGame();
    const preview = game.send(game.host, "song.music.detail", { songId: "answer" });
    const outcome = preview.then(
      (value) => ({ value }),
      (error: { code: string }) => ({ error })
    );
    await settle();
    const room = game.room();
    room.players[game.hostId] = { ...room.players[game.hostId]! };
    gate.resolve();
    expect(await outcome).toMatchObject({ error: { code: "NOT_SUBMITTER" } });
  });
});

const BAD_WORD = "测试违禁词A";

/** 另开一间房（同一服务、另一条连接）。 */
const createOther = (game: Game, connectionId: string, payload: Record<string, unknown> = {}) => {
  const client = connection(game.service, connectionId);
  const result = execute(game.service, client, {
    id: "create-other",
    type: "song.room.create",
    payload: {
      roomId: "5678",
      name: "另一间房",
      visibility: "public",
      allowSpectators: true,
      userName: "新房主",
      ...payload,
    },
  } as never);
  return { client, result };
};

describe("成员：建房与入房", () => {
  beforeAll(() =>
    setSensitiveTextFilterForTest(new SensitiveTextFilter([BAD_WORD], [], { disabledWords: [] }))
  );
  afterAll(() => setSensitiveTextFilterForTest(undefined));

  test("房名与昵称过敏感词检测", async () => {
    const game = await setup({ guests: 0 });
    expect((await rejection(createOther(game, "bad-name", { name: BAD_WORD }).result)).code).toBe(
      "TEXT_SENSITIVE"
    );
    expect(
      (await rejection(createOther(game, "bad-user", { userName: BAD_WORD }).result)).code
    ).toBe("TEXT_SENSITIVE");
    expect(game.service.rooms.has("5678")).toBe(false);
  });

  test("改设置的房名过敏感词检测", async () => {
    const game = await setup({ guests: 0 });
    expect(
      (await rejection(game.send(game.host, "song.room.updateSettings", { name: BAD_WORD }))).code
    ).toBe("TEXT_SENSITIVE");
    expect(game.room().name).toBe("猜歌房");
  });

  test("Agent 连接建房：房主席位标记为 Agent", async () => {
    const game = await setup({ guests: 0 });
    const client = connection(game.service, "agent-host");
    client.record.isAgent = true;
    await execute(game.service, client, {
      id: "create-agent",
      type: "song.room.create",
      payload: {
        roomId: "5678",
        name: "Agent 房",
        visibility: "public",
        allowSpectators: true,
        userName: "机器房主",
      },
    } as never);
    const host = Object.values(game.service.rooms.get("5678")!.players)[0]!;
    expect(host.isAgent).toBe(true);
  });

  test("单人房强制关闭旁观，建房记日志并发大厅更新", async () => {
    const game = await setup({ guests: 0 });
    const before = game.lobbyFrames();
    game.advance(500);
    await createOther(game, "solo-host", { solo: true, allowSpectators: true }).result;
    expect(game.service.rooms.get("5678")!.allowSpectators).toBe(false);
    expect(game.logged.some((event) => event.type === "song.room.created")).toBe(true);
    expect(game.lobbyFrames()).toBeGreaterThan(before);
  });

  test("入房：昵称重名被拒，成功后更新房间活动时间", async () => {
    const game = await setup({ guests: 1 });
    const second = connection(game.service, "second");
    expect((await rejection(game.send(second, "song.room.join", { userName: "玩家0" }))).code).toBe(
      "NAME_CONFLICT"
    );
    game.room().lastActivityAt = 0;
    await game.send(second, "song.room.join", { userName: "新来的" });
    expect(game.room().lastActivityAt).toBe(game.now());
  });

  test("入房不是易主：开局操作号不被误作废", async () => {
    const game = await setup({ guests: 1 });
    const op = Symbol("loading");
    const runtime = (game.room().runtime ??= {});
    runtime.automaticRoundOperation = op;
    const third = connection(game.service, "third");
    await game.send(third, "song.room.join", { userName: "路人" });
    expect(runtime.automaticRoundOperation).toBe(op);
  });

  test("连接所在房间已不存在时，用同一连接再建房仍能成功", async () => {
    const game = await setup({ guests: 0 });
    game.service.rooms.delete("1234");
    await expect(
      execute(game.service, game.host, {
        id: "again",
        type: "song.room.create",
        payload: {
          roomId: "5678",
          name: "重建",
          visibility: "public",
          allowSpectators: true,
          userName: "房主",
        },
      } as never)
    ).resolves.toMatchObject({ roomId: "5678" });
    expect(game.host.record.roomId).toBe("5678");
  });

  test("Agent 连接按口令重连被禁止 Agent 的房间时被拒", async () => {
    const game = await setup({ guests: 1 });
    const agent = connection(game.service, "agent-guest");
    agent.record.isAgent = true;
    const error = await rejection(
      execute(game.service, agent, {
        id: "reconnect-agent",
        type: "song.room.reconnect",
        payload: { roomId: "1234", sessionToken: "whatever" },
      } as never)
    );
    expect(error.code).toBe("AGENTS_NOT_ALLOWED");
  });
});

describe("成员：回座与刷新播放地址", () => {
  const playingGame = async () => {
    const gate = defer();
    releases.push(() => gate.resolve());
    const state = { slow: false, fail: false, calls: 0, refreshed: false };
    const game = await setup({
      music: {
        getSong: async (id) => {
          state.calls += 1;
          if (state.slow) await gate.promise;
          if (state.fail) throw new Error("上游失败");
          const song = songs[id as keyof typeof songs]!;
          return state.refreshed ? { ...song, audioUrl: "https://audio/refreshed.mp3" } : song;
        },
      },
    });
    await startPlaying(game);
    const guest = game.guests[0]!;
    const token = game.room().players[guest.id]!.sessionToken;
    const reconnect = () => {
      const client = connection(game.service, `guest-new-${Math.random()}`);
      return execute(game.service, client, {
        id: "reconnect",
        type: "song.room.reconnect",
        payload: { roomId: "1234", sessionToken: token },
      } as never);
    };
    return { game, state, gate, reconnect, guest };
  };

  test("回座：刷新当前回合的播放地址，更新活动时间并发布大厅", async () => {
    const { game, state, reconnect } = await playingGame();
    state.refreshed = true;
    game.room().lastActivityAt = 0;
    const before = game.lobbyFrames();
    game.advance(500);
    await reconnect();
    expect(game.room().currentRound!.song.audioUrl).toBe("https://audio/refreshed.mp3");
    expect(game.room().lastActivityAt).toBe(game.now());
    expect(game.lobbyFrames()).toBeGreaterThan(before);
  });

  test("非进行中阶段回座不取新地址", async () => {
    const { game, state, reconnect } = await playingGame();
    game.room().phase = "roundResult";
    const calls = state.calls;
    await reconnect();
    expect(state.calls).toBe(calls);
  });

  test("刷新地址期间阶段已变：不再改回合里的地址", async () => {
    const { game, state, gate, reconnect } = await playingGame();
    state.refreshed = true;
    state.slow = true;
    const pending = reconnect();
    await settle();
    game.room().phase = "roundResult";
    gate.resolve();
    await pending;
    expect(game.room().currentRound!.song.audioUrl).not.toBe("https://audio/refreshed.mp3");
  });

  test("刷新地址期间回合已换成另一份：旧回合不被改，新回合也不被改", async () => {
    const { game, state, gate, reconnect } = await playingGame();
    state.refreshed = true;
    state.slow = true;
    const pending = reconnect();
    await settle();
    const room = game.room();
    const oldRound = room.currentRound!;
    const replacement = { ...oldRound, song: { ...oldRound.song } };
    room.currentRound = replacement;
    const oldUrl = oldRound.song.audioUrl;
    gate.resolve();
    await pending;
    expect(replacement.song.audioUrl).toBe(oldUrl);
    expect(oldRound.song.audioUrl).toBe(oldUrl);
  });

  test("刷新地址失败不阻止回座，并记 warning", async () => {
    const { game, state, reconnect } = await playingGame();
    state.fail = true;
    await expect(reconnect()).resolves.toMatchObject({ roomId: "1234" });
    expect(game.warned).toContain("重连刷新歌曲播放地址失败");
  });

  test("同一条连接用自己的口令重连：座位不被先删后找", async () => {
    const { game } = await playingGame();
    const guest = game.guests[0]!;
    const token = game.room().players[guest.id]!.sessionToken;
    await expect(
      execute(game.service, guest.client, {
        id: "self-reconnect",
        type: "song.room.reconnect",
        payload: { roomId: "1234", sessionToken: token },
      } as never)
    ).resolves.toMatchObject({ playerId: guest.id });
    expect(game.room().players[guest.id]).toBeDefined();
    expect(guest.client.record.playerId).toBe(guest.id);
  });
});

describe("成员：离开、踢人与断线", () => {
  test("离开房间发大厅更新", async () => {
    const game = await setup({ guests: 2 });
    const before = game.lobbyFrames();
    await game.send(game.guests[0]!.client, "song.room.leave");
    expect(game.lobbyFrames()).toBeGreaterThan(before);
  });

  test("踢人：被踢者置离线、断开连接，重复踢同一人被拒，更新活动时间", async () => {
    const game = await setup({ guests: 2 });
    const target = game.guests[0]!;
    const closed: Array<[number | undefined, string | undefined]> = [];
    target.client.record.close = ((code?: number, reason?: string) => {
      closed.push([code, reason]);
    }) as never;
    game.room().lastActivityAt = 0;
    await game.send(game.host, "song.room.kick", { playerId: target.id });
    expect(game.room().players[target.id]!.online).toBe(false);
    expect(game.room().players[target.id]!.membership).toBe("kicked");
    expect(closed).toEqual([[4003, "kicked"]]);
    expect(game.room().lastActivityAt).toBe(game.now());
    expect(
      (await rejection(game.send(game.host, "song.room.kick", { playerId: target.id }))).code
    ).toBe("PLAYER_NOT_FOUND");
  });

  test("断线：解绑连接、记日志、发大厅更新；房间已不在时不抛错", async () => {
    const game = await setup({ guests: 2 });
    const before = game.lobbyFrames();
    game.advance(500);
    await game.service.unregisterConnection("guest-0");
    expect(game.guests[0]!.client.record.roomId).toBeUndefined();
    expect(game.logged.some((event) => event.type === "song.player.disconnected")).toBe(true);
    expect(game.lobbyFrames()).toBeGreaterThan(before);
    game.service.rooms.delete("1234");
    await expect(game.service.unregisterConnection("host")).resolves.toBeUndefined();
  });
});

describe("席位命令", () => {
  test("房主取消准备仍是已准备", async () => {
    const game = await setup({ guests: 1 });
    await expect(game.send(game.host, "song.player.setReady", { ready: false })).resolves.toEqual({
      ready: true,
    });
  });

  test("等待阶段切旁观：转旁观清准备，身份未变不动准备，并清旧预约", async () => {
    const game = await setup({ guests: 2 });
    const guest = game.guests[0]!;
    const seat = game.room().players[guest.id]!;
    await game.send(guest.client, "song.player.setSpectator", { spectator: false });
    expect(seat.isReady).toBe(true);
    seat.nextRoundMembership = "spectator";
    await expect(
      game.send(guest.client, "song.player.setSpectator", { spectator: false })
    ).resolves.toEqual({ spectator: false, queued: false });
    expect(seat.nextRoundMembership).toBeUndefined();
    await game.send(guest.client, "song.player.setSpectator", { spectator: true });
    expect(seat.membership).toBe("spectator");
    expect(seat.isReady).toBe(false);
  });

  test("房间不允许旁观时，对局中不能预约旁观", async () => {
    const game = await setup({ guests: 2, allowSpectators: false });
    await begin(game);
    expect(
      (
        await rejection(
          game.send(game.guests[0]!.client, "song.player.setSpectator", { spectator: true })
        )
      ).code
    ).toBe("SPECTATORS_DISABLED");
  });

  test("选队：非整数、小于 1、超上限被拒，退出队伍合法", async () => {
    const game = await setup({ guests: 1 });
    const guest = game.guests[0]!.client;
    for (const team of [1.5, 0, -1, 9, 99]) {
      expect((await rejection(game.send(guest, "song.player.setTeam", { team }))).code).toBe(
        "INVALID_TEAM"
      );
    }
    // 两个端点都选得上：上限那一队不能被误拒
    for (const team of [1, 8]) {
      await expect(game.send(guest, "song.player.setTeam", { team })).resolves.toEqual({ team });
    }
    await game.send(guest, "song.player.setTeam", { team: 2 });
    await expect(game.send(guest, "song.player.setTeam", { team: null })).resolves.toEqual({
      team: null,
    });
  });
});

describe("改设置", () => {
  const hasher = (gate: ReturnType<typeof defer<void>>) => ({
    hash: async (password: string) => {
      await gate.promise;
      return `hash:${password}`;
    },
    verify: async (password: string, digest: string) => digest === `hash:${password}`,
  });

  const pendingUpdate = async () => {
    const gate = defer();
    releases.push(() => gate.resolve());
    const game = await setup({ hasher: hasher(gate) });
    const update = game
      .send(game.host, "song.room.updateSettings", { visibility: "private", password: "pw-1" })
      .then(
        (value) => ({ value }),
        (error: { code: string }) => ({ error })
      );
    await settle();
    return { game, gate, update };
  };

  test("摘要计算期间房间被关闭：设置更新被拒", async () => {
    const { game, gate, update } = await pendingUpdate();
    game.service.rooms.delete("1234");
    gate.resolve();
    expect(await update).toMatchObject({ error: { code: "ROOM_NOT_FOUND" } });
  });

  test("摘要计算期间阶段已变：设置更新被拒且不覆盖", async () => {
    const { game, gate, update } = await pendingUpdate();
    game.room().phase = "choosingSubmitter";
    gate.resolve();
    expect(await update).toMatchObject({ error: { code: "INVALID_PHASE" } });
    expect(game.room().visibility).toBe("public");
  });

  test("房名、旁观开关与歌词行数写入；空房名保留原名", async () => {
    const game = await setup({ guests: 1 });
    await game.send(game.host, "song.room.updateSettings", {
      name: "新房名",
      allowSpectators: false,
      lyricsLineCount: 5,
    });
    expect(game.room().name).toBe("新房名");
    expect(game.room().allowSpectators).toBe(false);
    expect(game.room().settings.lyricsLineCount).toBe(5);
    await game.send(game.host, "song.room.updateSettings", { name: "   " });
    expect(game.room().name).toBe("新房名");
  });

  test("单人房不能改轮流出题", async () => {
    const game = await setup({ solo: true });
    const before = game.room().settings.autoRotateSubmitter;
    await game.send(game.host, "song.room.updateSettings", { autoRotateSubmitter: !before });
    expect(game.room().settings.autoRotateSubmitter).toBe(before);
  });
});

describe("巡检：测试房的空房豁免", () => {
  test("测试房没人在线时多次巡检也不被当作空房回收", async () => {
    const game = await setup({ guests: 0, testRoom: true });
    await game.service.unregisterConnection("host");
    await game.service.runHousekeeping();
    game.advance(100_000);
    await game.service.runHousekeeping();
    expect(game.service.rooms.has("Oblivionis")).toBe(true);
  });
});

describe("巡检：到期与回收的可见结果", () => {
  test("出题时限到点：退回选出题人、写公告、更新活动时间", async () => {
    const game = await setup({ guests: 2 });
    await begin(game);
    await game.send(game.host, "song.game.chooseSubmitter", { playerId: game.guests[0]!.id });
    game.advance(190_000);
    await game.service.runHousekeeping();
    const room = game.room();
    expect(room.phase).toBe("choosingSubmitter");
    expect(room.submitterPrompt).toContain("没有在时限内选好歌曲");
    expect(room.lastActivityAt).toBe(game.now());
  });

  test("没有出题截止的待出题人不会被巡检释放", async () => {
    const game = await setup({ guests: 2 });
    await begin(game);
    await game.send(game.host, "song.game.chooseSubmitter", { playerId: game.guests[0]!.id });
    game.room().pendingSubmitterDeadlineAt = undefined;
    game.advance(190_000);
    await game.service.runHousekeeping();
    expect(game.room().phase).toBe("submittingSong");
  });

  test("离线超过保留时长的玩家被清掉：更新活动时间并发大厅更新", async () => {
    const game = await setup({ guests: 2 });
    await game.service.unregisterConnection("guest-0");
    game.advance(200_000);
    const before = game.lobbyFrames();
    await game.service.runHousekeeping();
    expect(game.room().players[game.guests[0]!.id]).toBeUndefined();
    expect(game.room().lastActivityAt).toBe(game.now());
    expect(game.lobbyFrames()).toBeGreaterThan(before);
  });

  test("房主离线超过宽限：巡检改选房主并更新活动时间", async () => {
    const game = await setup({ guests: 2 });
    await game.service.unregisterConnection("host");
    game.advance(70_000);
    await game.service.runHousekeeping();
    const room = game.room();
    expect(room.hostPlayerId).not.toBe(game.hostId);
    expect(room.lastActivityAt).toBe(game.now());
  });

  test("每次巡检给在线玩家补发校准快照", async () => {
    const game = await setup({ guests: 1 });
    const calibrations: unknown[] = [];
    game.host.record.sendStateSyncCalibration = ((packet: unknown) => {
      calibrations.push(packet);
    }) as never;
    game.advance(1000);
    await game.service.runHousekeeping();
    expect(calibrations.length).toBeGreaterThan(0);
  });
});

describe("自动出题的下一回合", () => {
  const playlist = {
    info: { id: "42", name: "歌单", songCount: 1 },
    songs: [songs.answer],
  };

  const autoGame = async (options: { guests?: number } = {}) => {
    const gate = defer();
    releases.push(() => gate.resolve());
    const state = { slow: false, fail: false };
    const game = await setup({
      guests: options.guests ?? 1,
      settings: { questionMode: "automatic", autoFilters: { artists: [], minPopularity: 0 } },
      music: {
        getPlaylistSongs: async () => {
          if (state.slow) await gate.promise;
          if (state.fail) throw new Error("上游失败");
          return playlist;
        },
      },
    });
    toRoundResult(game);
    const previous = game.room().currentRound;
    const summary = game.room().roundSummary;
    return { game, state, gate, previous, summary };
  };

  const heldNext = async (change: (game: Game) => void) => {
    const { game, state, gate, previous } = await autoGame();
    state.slow = true;
    const next = game.send(game.host, "song.game.nextRound");
    const outcome = next.then(
      (value) => ({ value }),
      (error: { code: string }) => ({ error })
    );
    await settle();
    change(game);
    gate.resolve();
    return { game, outcome: await outcome, previous };
  };

  const changes: Array<[string, (game: Game) => void]> = [
    ["房间已不在登记", (g) => g.service.rooms.delete("1234")],
    ["阶段已变", (g) => ((g.room() as { phase: string }).phase = "waiting")],
    ["回合已换", (g) => ((g.room() as { currentRound: unknown }).currentRound = { ...roundStub })],
    ["房主已换", (g) => (g.room().hostPlayerId = g.guests[0]!.id)],
    ["房主已离线", (g) => (g.room().players[g.hostId]!.online = false)],
    ["连接已离房", (g) => (g.host.record.roomId = undefined)],
    ["连接已换席", (g) => (g.host.record.playerId = "other-seat")],
  ];
  for (const [label, change] of changes) {
    test(`抽题期间${label}：下一回合作废`, async () => {
      const { outcome } = await heldNext(change);
      expect(outcome).toMatchObject({ error: { code: "ROUND_EXPIRED" } });
    });
  }

  test("重复点击下一回合：加载中被拒为忙碌", async () => {
    const { game } = await autoGame();
    (game.room().runtime ??= {}).automaticRoundLoading = true;
    expect((await rejection(game.send(game.host, "song.game.nextRound"))).code).toBe("ROUND_BUSY");
  });

  test("加载期间标记置位，成功后清掉并发大厅更新", async () => {
    const { game, state, gate } = await autoGame();
    state.slow = true;
    const before = game.lobbyFrames();
    const next = game.send(game.host, "song.game.nextRound");
    await settle();
    expect(game.room().runtime?.automaticRoundLoading).toBe(true);
    gate.resolve();
    await next;
    expect(game.room().runtime?.automaticRoundLoading).toBe(false);
    expect(game.room().runtime?.automaticRoundOperation).toBeUndefined();
    expect(game.lobbyFrames()).toBeGreaterThan(before);
  });

  test("抽题失败：保留上一回合与摘要并回到结算阶段，错误照常抛出", async () => {
    const { game, state, previous, summary } = await autoGame();
    state.fail = true;
    await rejection(game.send(game.host, "song.game.nextRound"));
    const room = game.room();
    expect(room.phase).toBe("roundResult");
    expect(room.currentRound).toBe(previous);
    expect(room.roundSummary).toBe(summary);
    expect(room.runtime?.automaticRoundLoading).toBe(false);
  });

  test("人数不足：清掉旧回合与摘要后退回等待", async () => {
    const game = await setup({
      guests: 1,
      settings: { questionMode: "automatic", autoFilters: { artists: [], minPopularity: 0 } },
    });
    await game.service.unregisterConnection("guest-0");
    toRoundResult(game);
    await expect(game.send(game.host, "song.game.nextRound")).resolves.toMatchObject({
      waiting: true,
    });
    expect(game.room().currentRound).toBeUndefined();
    expect(game.room().roundSummary).toBeUndefined();
    expect(game.room().phase).toBe("waiting");
  });
});

describe("席位预约与准备重置", () => {
  const finish = async (game: Game) => {
    toRoundResult(game);
    await game.send(game.host, "song.game.finish");
  };

  test("房间不允许旁观时，转旁观的预约不生效且保留", async () => {
    const game = await setup({ guests: 2 });
    const seat = game.room().players[game.guests[0]!.id]!;
    game.room().allowSpectators = false;
    seat.nextRoundMembership = "spectator";
    await finish(game);
    expect(seat.membership).toBe("active");
    expect(seat.nextRoundMembership).toBe("spectator");
  });

  test("转旁观的预约生效时清掉队伍与准备", async () => {
    const game = await setup({ guests: 2 });
    const seat = game.room().players[game.guests[0]!.id]!;
    seat.team = 2;
    seat.nextRoundMembership = "spectator";
    await finish(game);
    expect(seat.membership).toBe("spectator");
    expect(seat.team).toBeNull();
    expect(seat.isReady).toBe(false);
  });

  test("房主预约回到正式席位后恒为已准备；预约转旁观的房主不准备", async () => {
    const game = await setup({ guests: 2 });
    const host = game.room().players[game.hostId]!;
    host.membership = "spectator";
    host.nextRoundMembership = "active";
    await finish(game);
    expect(game.room().players[game.hostId]!.membership).toBe("active");
    expect(host.isReady).toBe(true);

    const other = await setup({ guests: 2 });
    const otherHost = other.room().players[other.hostId]!;
    otherHost.nextRoundMembership = "spectator";
    await finish(other);
    expect(otherHost.membership).toBe("spectator");
    expect(otherHost.isReady).toBe(false);
  });

  test("回到等待后：旁观身份的房主不算已准备，机器人自动准备", async () => {
    const game = await setup({ guests: 1, testRoom: true });
    await game.send(game.host, "song.test.addBot", { count: 1 });
    const bot = Object.values(game.room().players).find((player) => player.isBot)!;
    bot.isReady = false;
    game.room().players[game.hostId]!.membership = "spectator";
    await finish(game);
    expect(bot.isReady).toBe(true);
    expect(game.room().players[game.hostId]!.isReady).toBe(false);
  });
});

describe("轮流出题的挑选", () => {
  const rotate = async (arrange: (game: Game) => void) => {
    const game = await setup({ guests: 2, settings: { autoRotateSubmitter: true } });
    arrange(game);
    toRoundResult(game);
    await game.send(game.host, "song.game.nextRound");
    return game;
  };

  test("轮到正式成员：旁观者被跳过", async () => {
    const game = await rotate((g) => {
      g.room().players[g.guests[0]!.id]!.membership = "spectator";
    });
    expect(game.room().pendingSubmitterPlayerId).toBe(game.guests[1]!.id);
  });

  test("按入房先后排序，而不是登记顺序", async () => {
    const game = await rotate((g) => {
      const room = g.room();
      room.players[g.hostId]!.joinedAt = 1;
      room.players[g.guests[0]!.id]!.joinedAt = 30;
      room.players[g.guests[1]!.id]!.joinedAt = 20;
    });
    expect(game.room().pendingSubmitterPlayerId).toBe(game.guests[1]!.id);
  });
});

describe("提交番剧：跨 await 复核与收尾", () => {
  const animeGame = async () => {
    const gate = defer();
    releases.push(() => gate.resolve());
    const state = { slow: false };
    const bangumi = fakeBangumiProvider({
      getSubject: async () => {
        if (state.slow) await gate.promise;
        return anime;
      },
      searchSubjects: async () => [anime],
    });
    const game = await setup({ bangumi, settings: { questionType: "anime" } });
    await begin(game);
    await game.send(game.host, "song.game.chooseSubmitter", { playerId: game.hostId });
    return { game, state, gate };
  };

  const changes: Array<[string, (game: Game) => void]> = [
    ["阶段已变", (g) => ((g.room() as { phase: string }).phase = "choosingSubmitter")],
    ["待出题人已换", (g) => (g.room().pendingSubmitterPlayerId = g.guests[0]!.id)],
    ["出题人已被踢", (g) => (g.room().players[g.hostId]!.membership = "kicked")],
    ["出题人已离线", (g) => (g.room().players[g.hostId]!.online = false)],
  ];
  for (const [label, change] of changes) {
    test(`取番剧期间${label}：提交被忽略，不装回合`, async () => {
      const { game, state, gate } = await animeGame();
      state.slow = true;
      const submit = game.send(game.host, "song.game.submitAnime", { subjectId: anime.id });
      await settle();
      change(game);
      gate.resolve();
      await expect(submit).resolves.toEqual({ ignored: true });
      expect(game.room().currentRound).toBeUndefined();
    });
  }

  test("提交番剧成功后发大厅更新并进入进行中", async () => {
    const { game } = await animeGame();
    const before = game.lobbyFrames();
    await expect(
      game.send(game.host, "song.game.submitAnime", { subjectId: anime.id })
    ).resolves.toMatchObject({ roundNumber: 1 });
    expect(game.room().phase).toBe("playing");
    expect(game.lobbyFrames()).toBeGreaterThan(before);
  });
});

describe("补充：提交、成员、巡检的剩余边界", () => {
  const submitChanges: Array<[string, (game: Game) => void]> = [
    ["阶段已变", (g) => ((g.room() as { phase: string }).phase = "choosingSubmitter")],
    ["出题人已被踢", (g) => (g.room().players[g.hostId]!.membership = "kicked")],
    ["出题人已离线", (g) => (g.room().players[g.hostId]!.online = false)],
  ];

  const heldSong = async (change: (game: Game) => void) => {
    const gate = defer();
    releases.push(() => gate.resolve());
    let slow = false;
    const game = await setup({
      music: {
        getSong: async (id) => {
          if (slow) await gate.promise;
          return songs[id as keyof typeof songs]!;
        },
        getSongMetadata: async (id) => {
          if (slow) await gate.promise;
          return songs[id as keyof typeof songs]!;
        },
      },
    });
    await begin(game);
    await game.send(game.host, "song.game.chooseSubmitter", { playerId: game.hostId });
    slow = true;
    const submit = game.send(game.host, "song.game.submitSong", { songId: "answer" });
    await settle();
    change(game);
    gate.resolve();
    return { game, result: await submit };
  };

  for (const [label, change] of submitChanges) {
    test(`取歌期间${label}：提交歌曲被忽略`, async () => {
      const { game, result } = await heldSong(change);
      expect(result).toEqual({ ignored: true });
      expect(game.room().currentRound).toBeUndefined();
    });
  }

  test("预览歌曲跨 await 复核：阶段已变后拒绝", async () => {
    const gate = defer();
    releases.push(() => gate.resolve());
    let slow = false;
    const game = await setup({
      music: {
        getSong: async (id) => {
          if (slow) await gate.promise;
          return songs[id as keyof typeof songs]!;
        },
        getSongMetadata: async (id) => {
          if (slow) await gate.promise;
          return songs[id as keyof typeof songs]!;
        },
      },
    });
    await begin(game);
    await game.send(game.host, "song.game.chooseSubmitter", { playerId: game.hostId });
    slow = true;
    const outcome = game.send(game.host, "song.music.detail", { songId: "answer" }).then(
      (value) => ({ value }),
      (error: { code: string }) => ({ error })
    );
    await settle();
    (game.room() as { phase: string }).phase = "choosingSubmitter";
    gate.resolve();
    expect(await outcome).toMatchObject({ error: { code: "NOT_SUBMITTER" } });
  });

  test("提交番剧：席位被换成另一份记录时被忽略，且先顺延了出题时限", async () => {
    const gate = defer();
    releases.push(() => gate.resolve());
    let slow = false;
    const bangumi = fakeBangumiProvider({
      getSubject: async () => {
        if (slow) await gate.promise;
        return anime;
      },
      searchSubjects: async () => [anime],
    });
    const game = await setup({ bangumi, settings: { questionType: "anime" } });
    await begin(game);
    await game.send(game.host, "song.game.chooseSubmitter", { playerId: game.hostId });
    game.advance(100_000);
    slow = true;
    const submit = game.send(game.host, "song.game.submitAnime", { subjectId: anime.id });
    await settle();
    expect(game.room().pendingSubmitterDeadlineAt).toBe(game.now() + 180_000);
    const room = game.room();
    room.players[game.hostId] = { ...room.players[game.hostId]! };
    gate.resolve();
    await expect(submit).resolves.toEqual({ ignored: true });
  });

  test("建房：连接带标签页密钥时，房主席位号由标签页决定", async () => {
    const game = await setup({ guests: 0 });
    const client = connection(game.service, "tab-host");
    client.record.tabKey = "tab-key-1";
    await execute(game.service, client, {
      id: "create-tab",
      type: "song.room.create",
      payload: {
        roomId: "5678",
        name: "标签页房",
        visibility: "public",
        allowSpectators: true,
        userName: "标签房主",
      },
    } as never);
    expect(game.service.rooms.get("5678")!.hostPlayerId).toBe(
      tabSeatId({ tabKey: "tab-key-1" }, "song", "5678")!
    );
  });

  test("Agent 驱动的连接建房：房间默认允许 Agent", async () => {
    const game = await setup({ guests: 0 });
    const client = connection(game.service, "driven-host");
    client.record.agentDriven = () => true;
    await execute(game.service, client, {
      id: "create-driven",
      type: "song.room.create",
      payload: {
        roomId: "5678",
        name: "驱动房",
        visibility: "public",
        allowSpectators: true,
        userName: "驱动房主",
      },
    } as never);
    expect(game.service.rooms.get("5678")!.settings.allowAgents).toBe(true);
  });

  test("建房向房主发布房间快照事件，并发大厅更新", async () => {
    const game = await setup({ guests: 0 });
    const before = game.lobbyFrames();
    game.advance(500);
    const { client, result } = createOther(game, "snap-host");
    await result;
    expect(client.sent.some((item) => item.event === "song.room.snapshot")).toBe(true);
    expect(game.lobbyFrames()).toBeGreaterThan(before);
  });

  test("口令入房：比对摘要期间房间被关闭，入房被拒", async () => {
    const verifyGate = defer<void>();
    let holdVerify = false;
    releases.push(() => verifyGate.resolve());
    const game = await setup({
      guests: 0,
      hasher: {
        hash: async (password) => `h:${password}`,
        verify: async (password, digest) => {
          if (holdVerify) await verifyGate.promise;
          return digest === `h:${password}`;
        },
      },
    });
    await game.send(game.host, "song.room.updateSettings", {
      visibility: "private",
      password: "pw-1",
    });
    holdVerify = true;
    const joiner = connection(game.service, "late-joiner");
    const join = game.send(joiner, "song.room.join", { userName: "晚到", password: "pw-1" }).then(
      (value) => ({ value }),
      (error: { code: string }) => ({ error })
    );
    await settle();
    game.service.rooms.delete("1234");
    verifyGate.resolve();
    expect(await join).toMatchObject({ error: { code: "ROOM_NOT_FOUND" } });
  });

  test("对局中入房：房间不允许旁观时被拒；允许时以旁观者身份加入并发大厅更新", async () => {
    const closed = await setup({ guests: 1, allowSpectators: false });
    await begin(closed);
    expect(
      (
        await rejection(
          closed.send(connection(closed.service, "late-a"), "song.room.join", { userName: "晚到A" })
        )
      ).code
    ).toBe("SPECTATORS_DISABLED");

    const open = await setup({ guests: 1 });
    await begin(open);
    const before = open.lobbyFrames();
    await open.send(connection(open.service, "late-b"), "song.room.join", { userName: "晚到B" });
    const late = Object.values(open.room().players).find((player) => player.name === "晚到B")!;
    expect(late.membership).toBe("spectator");
    expect(open.lobbyFrames()).toBeGreaterThan(before);
    // 三个数字是分别下发的字段，只断言在线总数会让玩家栏与旁观栏悄悄互换。
    expect(open.service.getRoomSummaries()[0]).toMatchObject({
      playerCount: 2,
      spectatorCount: 1,
      onlineCount: 3,
    });
  });

  test("离开房间：写公告并更新活动时间；最后一人离开时关房并发大厅更新", async () => {
    const game = await setup({ guests: 1 });
    game.room().lastActivityAt = 0;
    await game.send(game.guests[0]!.client, "song.room.leave");
    expect(game.room().chat.at(-1)?.text).toContain("离开了房间");
    expect(game.room().lastActivityAt).toBe(game.now());

    const solo = await setup({ guests: 0 });
    const before = solo.lobbyFrames();
    await solo.send(solo.host, "song.room.leave");
    expect(solo.service.rooms.has("1234")).toBe(false);
    expect(solo.lobbyFrames()).toBeGreaterThan(before);
  });

  test("测试房里最后一人离开：房间不回收", async () => {
    const game = await setup({ guests: 0, testRoom: true });
    await game.send(game.host, "song.room.leave");
    expect(game.service.rooms.has("Oblivionis")).toBe(true);
  });

  test("旧连接的记录仍指着座位但座位已属于别的连接：断开不把座位标成离线", async () => {
    const game = await setup({ guests: 1 });
    const guest = game.guests[0]!;
    const token = game.room().players[guest.id]!.sessionToken;
    await execute(game.service, connection(game.service, "guest-fresh"), {
      id: "take-over",
      type: "song.room.reconnect",
      payload: { roomId: "1234", sessionToken: token },
    } as never);
    guest.client.record.roomId = "1234";
    guest.client.record.playerId = guest.id;
    await game.service.unregisterConnection("guest-0");
    expect(game.room().players[guest.id]!.online).toBe(true);
  });

  test("断线：测试房不起空房计时，普通房起；更新活动时间", async () => {
    const test = await setup({ guests: 0, testRoom: true });
    await test.service.unregisterConnection("host");
    expect(test.room().emptySinceAt).toBeUndefined();
    const normal = await setup({ guests: 0 });
    normal.room().lastActivityAt = 0;
    await normal.service.unregisterConnection("host");
    expect(normal.room().emptySinceAt).toBeDefined();
    expect(normal.room().lastActivityAt).toBe(normal.now());
  });

  test("未登记的连接断开不抛错", async () => {
    const game = await setup({ guests: 0 });
    await expect(game.service.unregisterConnection("never-registered")).resolves.toBeUndefined();
  });

  test("座位已被新连接接手后，旧连接断开不把座位标成离线", async () => {
    const game = await setup({ guests: 1 });
    const guest = game.guests[0]!;
    const token = game.room().players[guest.id]!.sessionToken;
    const fresh = connection(game.service, "guest-fresh");
    await execute(game.service, fresh, {
      id: "take-over",
      type: "song.room.reconnect",
      payload: { roomId: "1234", sessionToken: token },
    } as never);
    await game.service.unregisterConnection("guest-0");
    expect(game.room().players[guest.id]!.online).toBe(true);
  });

  test("房主离线过宽限后，回座的玩家当场接任房主且为已准备", async () => {
    const game = await setup({ guests: 1 });
    const guest = game.guests[0]!;
    const token = game.room().players[guest.id]!.sessionToken;
    await game.service.unregisterConnection("host");
    await game.service.unregisterConnection("guest-0");
    game.room().players[guest.id]!.isReady = false;
    game.advance(70_000);
    await execute(game.service, connection(game.service, "guest-back"), {
      id: "back",
      type: "song.room.reconnect",
      payload: { roomId: "1234", sessionToken: token },
    } as never);
    expect(game.room().hostPlayerId).toBe(guest.id);
    expect(game.room().players[guest.id]!.isReady).toBe(true);
  });

  test("Agent 连接不能接手人类座位", async () => {
    const game = await setup({ guests: 1, settings: { allowAgents: true } });
    const guest = game.guests[0]!;
    const token = game.room().players[guest.id]!.sessionToken;
    const agent = connection(game.service, "agent-take");
    agent.record.isAgent = true;
    const error = await rejection(
      execute(game.service, agent, {
        id: "agent-take",
        type: "song.room.reconnect",
        payload: { roomId: "1234", sessionToken: token },
      } as never)
    );
    expect(error.code).toBe("AGENT_SEAT_FORBIDDEN");
  });

  test("回座刷新播放地址时，QQ 会员专享曲不用非会员号", async () => {
    const cookies: unknown[] = [];
    const gate = defer();
    releases.push(() => gate.resolve());
    const game = await setup({
      music: {
        getLoginStatus: async (cookie, platform) => ({
          cookie,
          account: {
            platform: platform === "qq" ? "qq" : "netease",
            nickname: "账号",
            vipStatus: cookie.includes("nonvip") ? "nonVip" : "vip",
          },
        }),
        getSong: async (id, cookie) => {
          cookies.push(cookie);
          return songs[id as keyof typeof songs]!;
        },
      },
    });
    await game.send(game.host, "song.auth.useCookie", {
      cookie: "QQ_KEY=nonvip",
      platform: "qq",
    });
    await startPlaying(game);
    const round = game.room().currentRound!;
    round.song = { ...round.song, id: "qq:1", requiresVip: true };
    cookies.length = 0;
    const guest = game.guests[0]!;
    await execute(game.service, connection(game.service, "guest-vip"), {
      id: "vip",
      type: "song.room.reconnect",
      payload: { roomId: "1234", sessionToken: game.room().players[guest.id]!.sessionToken },
    } as never);
    expect(cookies).toEqual([undefined]);
  });
});

describe("补充：准备、旁观、设置与同步", () => {
  test("准备更新活动时间；同步请求重置该连接的状态同步", async () => {
    const game = await setup({ guests: 1 });
    const guest = game.guests[0]!;
    game.room().lastActivityAt = 0;
    await game.send(guest.client, "song.player.setReady", { ready: true });
    expect(game.room().lastActivityAt).toBe(game.now());
    let reset = 0;
    guest.client.record.resetStateSync = () => {
      reset += 1;
    };
    await game.send(guest.client, "song.room.requestSync");
    expect(reset).toBe(1);
  });

  test("等待阶段房间不允许旁观时不能转旁观；旁观的房主转回正式后为已准备", async () => {
    const closed = await setup({ guests: 1, allowSpectators: false });
    expect(
      (
        await rejection(
          closed.send(closed.guests[0]!.client, "song.player.setSpectator", { spectator: true })
        )
      ).code
    ).toBe("SPECTATORS_DISABLED");

    const game = await setup({ guests: 1 });
    await game.send(game.host, "song.player.setSpectator", { spectator: true });
    expect(game.room().players[game.hostId]!.isReady).toBe(false);
    await game.send(game.host, "song.player.setSpectator", { spectator: false });
    expect(game.room().players[game.hostId]!.membership).toBe("active");
    expect(game.room().players[game.hostId]!.isReady).toBe(true);
  });

  test("改设置：可见性写入、更新活动时间并发大厅更新；房名过敏感词检测", async () => {
    const game = await setup({ guests: 1 });
    game.room().lastActivityAt = 0;
    const before = game.lobbyFrames();
    await game.send(game.host, "song.room.updateSettings", {
      visibility: "private",
      password: "pw-2",
    });
    expect(game.room().visibility).toBe("private");
    expect(game.room().lastActivityAt).toBe(game.now());
    expect(game.lobbyFrames()).toBeGreaterThan(before);
  });

  test("歌词行数写入；单人房不能改自选片段", async () => {
    const game = await setup({ guests: 1 });
    const target = DEFAULT_SETTINGS.lyricsLineCount === 3 ? 4 : 3;
    await game.send(game.host, "song.room.updateSettings", { lyricsLineCount: target });
    expect(game.room().settings.lyricsLineCount).toBe(target);

    const solo = await setup({ solo: true });
    const before = solo.room().settings.allowCustomClip;
    await solo.send(solo.host, "song.room.updateSettings", { allowCustomClip: !before });
    expect(solo.room().settings.allowCustomClip).toBe(before);
  });

  test("转让房主更新活动时间；踢人清掉被踢者贡献的账号并发大厅更新", async () => {
    const game = await setup({ guests: 2 });
    const target = game.guests[0]!;
    await game.send(target.client, "song.auth.useCookie", { cookie: "MUSIC_U=guest-cookie" });
    expect((game.room().musicPool ?? []).some((entry) => entry.playerId === target.id)).toBe(true);
    const before = game.lobbyFrames();
    await game.send(game.host, "song.room.kick", { playerId: target.id });
    expect((game.room().musicPool ?? []).some((entry) => entry.playerId === target.id)).toBe(false);
    expect(game.lobbyFrames()).toBeGreaterThan(before);
    game.room().lastActivityAt = 0;
    await game.send(game.host, "song.room.transferHost", { playerId: game.guests[1]!.id });
    expect(game.room().lastActivityAt).toBe(game.now());
  });
});

describe("补充：席位预约与轮换在手动下一回合里的口径", () => {
  const nextWith = async (arrange: (game: Game) => void) => {
    const game = await setup({ guests: 3 });
    arrange(game);
    toRoundResult(game);
    await game.send(game.host, "song.game.nextRound");
    return game;
  };

  test("被踢者的预约不生效；预约转旁观的房主不算已准备；预约转正式的房主算已准备", async () => {
    const kicked = await nextWith((g) => {
      const seat = g.room().players[g.guests[0]!.id]!;
      seat.membership = "kicked";
      seat.nextRoundMembership = "spectator";
    });
    expect(kicked.room().players[kicked.guests[0]!.id]!.membership).toBe("kicked");

    const toSpectator = await nextWith((g) => {
      g.room().players[g.hostId]!.nextRoundMembership = "spectator";
    });
    expect(toSpectator.room().players[toSpectator.hostId]!.isReady).toBe(false);

    const toActive = await nextWith((g) => {
      const host = g.room().players[g.hostId]!;
      host.membership = "spectator";
      host.nextRoundMembership = "active";
    });
    expect(toActive.room().players[toActive.hostId]!.isReady).toBe(true);
  });

  test("预约转正式的机器人自动准备", async () => {
    const bot = await setup({ guests: 2, testRoom: true });
    await bot.send(bot.host, "song.test.addBot", { count: 1 });
    const seat = Object.values(bot.room().players).find((player) => player.isBot)!;
    seat.membership = "spectator";
    seat.isReady = false;
    seat.nextRoundMembership = "active";
    toRoundResult(bot);
    await bot.send(bot.host, "song.game.nextRound");
    expect(bot.room().players[seat.id]!.membership).toBe("active");
    expect(seat.isReady).toBe(true);
  });

  test("轮流出题不会轮到离线的玩家", async () => {
    const game = await setup({ guests: 2, settings: { autoRotateSubmitter: true } });
    await game.service.unregisterConnection("guest-1");
    toRoundResult(game, game.guests[0]!.id);
    await game.send(game.host, "song.game.nextRound");
    expect(game.room().pendingSubmitterPlayerId).toBe(game.hostId);
  });
});

describe("补充：巡检的释放口径", () => {
  test("不在选题阶段，或没有待出题人时，到点也不释放", async () => {
    const stale = await setup({ guests: 2 });
    await begin(stale);
    await stale.send(stale.host, "song.game.chooseSubmitter", { playerId: stale.guests[0]!.id });
    stale.room().phase = "roundResult";
    stale.advance(190_000);
    const activityBefore = stale.room().lastActivityAt;
    await stale.service.runHousekeeping();
    expect(stale.room().phase).toBe("roundResult");
    expect(stale.room().submitterPrompt).toBeUndefined();
    expect(stale.room().lastActivityAt).toBe(activityBefore);

    const none = await setup({ guests: 2 });
    await begin(none);
    await none.send(none.host, "song.game.chooseSubmitter", { playerId: none.guests[0]!.id });
    none.room().pendingSubmitterPlayerId = undefined;
    none.advance(190_000);
    await none.service.runHousekeeping();
    expect(none.room().phase).toBe("submittingSong");
  });

  test("番剧题的出题超时公告写番剧", async () => {
    const game = await setup({ guests: 2 });
    await begin(game);
    await game.send(game.host, "song.game.chooseSubmitter", { playerId: game.guests[0]!.id });
    game.room().settings.questionType = "anime";
    game.advance(190_000);
    await game.service.runHousekeeping();
    expect(game.room().submitterPrompt).toContain("没有在时限内选好番剧");
  });

  test("房主改选：新房主为已准备并发大厅更新", async () => {
    const game = await setup({ guests: 2 });
    await game.service.unregisterConnection("host");
    const guest = game.room().players[game.guests[0]!.id]!;
    guest.isReady = false;
    game.advance(70_000);
    const before = game.lobbyFrames();
    await game.service.runHousekeeping();
    expect(game.room().hostPlayerId).not.toBe(game.hostId);
    expect(game.room().players[game.room().hostPlayerId]!.isReady).toBe(true);
    expect(game.lobbyFrames()).toBeGreaterThan(before);
  });

  test("空房宽限期内整间跳过后续巡检：离线旁观者不被提前清掉", async () => {
    const game = await setup({ guests: 1 });
    const guest = game.room().players[game.guests[0]!.id]!;
    guest.membership = "spectator";
    await game.service.unregisterConnection("host");
    await game.service.unregisterConnection("guest-0");
    await game.service.runHousekeeping();
    game.advance(40_000);
    await game.service.runHousekeeping();
    expect(game.room().players[guest.id]).toBeDefined();
  });
});
