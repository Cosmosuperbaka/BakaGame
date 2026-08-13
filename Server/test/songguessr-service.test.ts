import { describe, expect, test } from "bun:test";

import { SongGuessrService } from "../src/application/songguessr-service";
import { AppError } from "../src/domain/errors";
import { ROOM_EMPTY_GRACE_PERIOD_MS, HOST_RECONNECT_TIMEOUT_MS } from "../src/config/constants";
import type { ConnectionRecord } from "../src/domain/model";
import type { MusicProvider } from "../src/infrastructure/netease-music-provider";
import type {
  SongDetails,
  SongGuessrClientMessage,
  SongGuessrPrivateState,
  SongGuessrRoomSnapshot,
} from "../src/shared";

const makeSong = (id: string, title: string, year: number): SongDetails => ({
  id,
  title,
  artist: "测试歌手",
  album: "测试专辑",
  pictureUrl: `https://img/${id}.jpg`,
  durationMs: 180_000,
  audioUrl: `https://audio/${id}.mp3`,
  lyrics: Array.from({ length: 8 }, (_, index) => ({
    time: (index + 1) * 1_000,
    endTime: (index + 2) * 1_000,
    text: `歌词${index + 1}`,
  })),
  releaseYear: year,
  popularity: id === "answer" ? 90 : 60,
  language: "国语",
  encyclopedia: { summary: "百科", tags: ["流行", id] },
});

const songs = {
  answer: makeSong("answer", "答案歌", 2022),
  wrong: makeSong("wrong", "错误歌", 2018),
};

const provider: MusicProvider = {
  search: async () => [songs.answer, songs.wrong],
  getSong: async (id) => songs[id as keyof typeof songs],
  getSongMetadata: async (id) => songs[id as keyof typeof songs],
  getLoginStatus: async (cookie) => ({
    cookie,
    account: { nickname: "测试账号", vipStatus: "vip" },
  }),
};

interface TestConnection {
  record: ConnectionRecord;
  sent: Array<{ type?: string; event?: string; payload?: unknown }>;
}

const connection = (service: SongGuessrService, id: string): TestConnection => {
  const sent: TestConnection["sent"] = [];
  const record: ConnectionRecord = {
    id,
    lobbySubscribed: false,
    send: (payload) => sent.push(payload as TestConnection["sent"][number]),
    close: () => {},
  };
  service.registerConnection(record);
  return { record, sent };
};

const execute = (
  service: SongGuessrService,
  client: TestConnection,
  message: SongGuessrClientMessage,
) => service.execute(client.record.id, message);

const lastEvent = <T>(client: TestConnection, event: string): T =>
  client.sent.filter((item) => item.type === "event" && item.event === event).at(-1)!.payload as T;

const createRoom = async (
  service: SongGuessrService,
  host: TestConnection,
  overrides: Partial<Extract<SongGuessrClientMessage, { type: "song.room.create" }>["payload"]> = {},
) => {
  const created = await execute(service, host, {
    id: "create",
    type: "song.room.create",
    payload: {
      roomId: "1234",
      name: "猜歌房",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
      ...overrides,
    },
  });
  await execute(service, host, {
    id: "host-account",
    type: "song.auth.useCookie",
    roomId: overrides.roomId ?? "1234",
    payload: { cookie: "MUSIC_U=test-host" },
  });
  return created;
};

const joinRoom = async (
  service: SongGuessrService,
  client: TestConnection,
  userName: string,
  roomId = "1234",
  password?: string,
) => {
  await execute(service, client, {
    id: `join-${client.record.id}`,
    type: "song.room.join",
    roomId,
    payload: password ? { userName, password } : { userName },
  });
  return lastEvent<SongGuessrPrivateState>(client, "song.game.privateState");
};

const startRound = async (
  service: SongGuessrService,
  host: TestConnection,
  guest: TestConnection,
  submitterPlayerId: string,
) => {
  await execute(service, guest, {
    id: "ready",
    type: "song.player.setReady",
    roomId: "1234",
    payload: { ready: true },
  });
  await execute(service, host, {
    id: "start",
    type: "song.game.start",
    roomId: "1234",
    payload: {},
  });
  await execute(service, host, {
    id: "choose",
    type: "song.game.chooseSubmitter",
    roomId: "1234",
    payload: { playerId: submitterPlayerId },
  });
  await execute(service, host, {
    id: "submit",
    type: "song.game.submitSong",
    roomId: "1234",
    payload: { songId: "answer" },
  });
};

describe("SongGuessrService", () => {

  test("房间最多容纳十六个在线席位", async () => {
    const service = new SongGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    await createRoom(service, host);

    for (let index = 1; index < 16; index += 1) {
      const player = connection(service, `player-${index}`);
      await joinRoom(service, player, `玩家${index}`);
    }

    const overflow = connection(service, "player-overflow");
    await expect(execute(service, overflow, {
      id: "join-overflow",
      type: "song.room.join",
      roomId: "1234",
      payload: { userName: "第十七人" },
    })).rejects.toMatchObject({ code: "ROOM_FULL" });
  });

  test("房主可以踢人且被踢连接立即收到事件", async () => {
    const service = new SongGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const guestState = await joinRoom(service, guest, "玩家");

    await execute(service, host, {
      id: "kick",
      type: "song.room.kick",
      roomId: "1234",
      payload: { playerId: guestState.playerId },
    });

    expect(lastEvent<{ roomId: string }>(guest, "song.room.kicked")).toEqual({ roomId: "1234" });
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").players)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: guestState.playerId })]));
    await expect(execute(service, guest, {
      id: "chat-after-kick",
      type: "song.chat.send",
      payload: { text: "还在吗" },
    })).rejects.toMatchObject({ code: "PLAYER_NOT_IN_ROOM" });
  });

  test("等待阶段房主也可以按 Whoisfaker 规则切换旁观和玩家席位", async () => {
    const service = new SongGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    await createRoom(service, host);
    const hostState = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState");

    await execute(service, host, {
      id: "host-watch",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    });
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").players)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: hostState.playerId, membership: "spectator", isHost: true }),
      ]));

    await execute(service, host, {
      id: "host-play",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: false },
    });
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").players)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: hostState.playerId, membership: "active", isHost: true }),
      ]));
  });

  test("断线后的空房间在宽限期后由 housekeeping 自动清理", async () => {
    let now = 0;
    const service = new SongGuessrService({ musicProvider: provider, now: () => now });
    const host = connection(service, "host");
    await createRoom(service, host);

    await service.unregisterConnection(host.record.id);
    expect(service.getRoomSummaries()).toHaveLength(1);
    await service.runHousekeeping();
    expect(service.getRoomSummaries()).toHaveLength(1);
    now += ROOM_EMPTY_GRACE_PERIOD_MS + 1;
    await service.runHousekeeping();
    expect(service.getRoomSummaries()).toHaveLength(0);
  });

  test("房主显式离开才立即清理音乐会话，房主转移保留房间会话", async () => {
    const service = new SongGuessrService({ musicProvider: provider });
    const host = connection(service, "session-host");
    const guest = connection(service, "session-guest");
    await createRoom(service, host);
    const guestState = await joinRoom(service, guest, "玩家");
    await execute(service, host, {
      id: "session-transfer",
      type: "song.room.transferHost",
      roomId: "1234",
      payload: { playerId: guestState.playerId },
    });
    expect(lastEvent<SongGuessrRoomSnapshot>(guest, "song.room.snapshot").musicAccountReady).toBe(true);
    await execute(service, guest, { id: "session-clear", type: "song.auth.clear", roomId: "1234", payload: {} });
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").musicAccountReady).toBe(false);
  });

  test("私密房间保留在大厅列表并要求密码加入", async () => {
    const service = new SongGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host, {
      visibility: "private",
      password: "secret",
      name: "私密猜歌房",
    });

    expect(service.getRoomSummaries()).toEqual([
      expect.objectContaining({ roomId: "1234", visibility: "private", hasPassword: true }),
    ]);
    await expect(joinRoom(service, guest, "玩家")).rejects.toMatchObject({ code: "PASSWORD_INCORRECT" });
    await joinRoom(service, guest, "玩家", "1234", "secret");
  });

  test("房主 Cookie 只存在房间内存、供全房请求使用并在房主离开时销毁", async () => {
    const usedCookies: Array<string | undefined> = [];
    const authProvider: MusicProvider = {
      ...provider,
      search: async (_keyword, _limit, cookie) => {
        usedCookies.push(cookie);
        return [];
      },
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { userId: "guest-account", nickname: "新房主账号" },
      }),
    };
    const service = new SongGuessrService({ musicProvider: authProvider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const hostState = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "玩家");

    await expect(execute(service, guest, {
      id: "guest-cannot-load-cookie",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=forbidden" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const login = await execute(service, host, {
      id: "cookie-login",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=host-cookie" },
    }) as {
      cookie: string;
      account: { userId?: string; nickname: string; avatarUrl?: string };
    };
    expect(login).toHaveProperty("account");
    const readySnapshot = lastEvent<SongGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(readySnapshot.musicAccountReady).toBe(true);
    expect(JSON.stringify(readySnapshot)).not.toContain("MUSIC_U=host-cookie");
    expect(JSON.stringify(guest.sent)).not.toContain("MUSIC_U=host-cookie");

    await execute(service, guest, {
      id: "search-with-host-cookie",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "测试" },
    });
    expect(usedCookies.at(-1)).toBe("MUSIC_U=host-cookie");

    await execute(service, host, {
      id: "transfer-host",
      type: "song.room.transferHost",
      roomId: "1234",
      payload: { playerId: guestState.playerId },
    });
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").musicAccountReady).toBe(true);

    await execute(service, guest, {
      id: "load-new-host-cookie",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=guest-cookie" },
    });
    await execute(service, host, {
      id: "search-with-guest-cookie",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "测试" },
    });
    expect(usedCookies.at(-1)).toBe("MUSIC_U=guest-cookie");

    await execute(service, guest, {
      id: "owner-leaves",
      type: "song.room.leave",
      roomId: "1234",
      payload: {},
    });
    const afterLeave = lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(afterLeave.hostPlayerId).toBe(hostState.playerId);
    expect(afterLeave.musicAccountReady).toBe(false);
    await execute(service, host, {
      id: "search-after-owner-left",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "测试" },
    });
    expect(usedCookies.at(-1)).toBeUndefined();
  });

  test("房主连接断开时保留 Cookie，宽限期后转移房主", async () => {
    const authProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { nickname: "断线账号" },
      }),
    };
    let now = 0;
    const service = new SongGuessrService({ musicProvider: authProvider, now: () => now });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const guestState = await joinRoom(service, guest, "玩家");
    await execute(service, host, {
      id: "load-cookie-before-disconnect",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=disconnect-cookie" },
    });

    await service.unregisterConnection(host.record.id);
    const snapshot = lastEvent<SongGuessrRoomSnapshot>(guest, "song.room.snapshot");
    const hostState = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState");
    expect(snapshot.hostPlayerId).toBe(hostState.playerId);
    expect(snapshot.musicAccountReady).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("disconnect-cookie");
    now += HOST_RECONNECT_TIMEOUT_MS + 1;
    await service.runHousekeeping();
    const transferred = lastEvent<SongGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(transferred.hostPlayerId).toBe(guestState.playerId);
    expect(transferred.musicAccountReady).toBe(true);
  });

  test("房主断线宽限期内新玩家加入不会接管房主或音乐会话", async () => {
    let now = 0;
    const service = new SongGuessrService({ musicProvider: provider, now: () => now });
    const host = connection(service, "grace-host");
    const guest = connection(service, "grace-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState");

    await service.unregisterConnection(host.record.id);
    now += HOST_RECONNECT_TIMEOUT_MS - 1;
    await joinRoom(service, guest, "宽限期玩家");

    const snapshot = lastEvent<SongGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(snapshot.hostPlayerId).toBe(hostState.playerId);
    expect(snapshot.musicAccountReady).toBe(true);
  });

  test("未登录网易云账号时不能开始游戏", async () => {
    const service = new SongGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    await execute(service, host, {
      id: "clear-account-before-start",
      type: "song.auth.clear",
      roomId: "1234",
      payload: {},
    });
    await joinRoom(service, guest, "玩家");
    await execute(service, guest, {
      id: "ready-before-login-check",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });

    await expect(execute(service, host, {
      id: "start-without-login",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    })).rejects.toMatchObject({
      code: "MUSIC_LOGIN_REQUIRED",
    });
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("waiting");
  });

  test("开始游戏前会重新校验 Cookie，失效后清除房间账号状态", async () => {
    let statusCalls = 0;
    const expiringProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => {
        statusCalls += 1;
        if (statusCalls > 1) throw new AppError("MUSIC_SESSION_INVALID", "登录状态已失效");
        return { cookie, account: { nickname: "即将失效", vipStatus: "vip" } };
      },
    };
    const service = new SongGuessrService({ musicProvider: expiringProvider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "玩家");
    await execute(service, guest, {
      id: "ready-before-expiry",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });

    await expect(execute(service, host, {
      id: "start-after-expiry",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    })).rejects.toMatchObject({ code: "MUSIC_SESSION_INVALID" });
    expect(statusCalls).toBe(2);
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").musicAccountReady).toBe(false);
  });

  test("非会员不能提交会员专享歌曲", async () => {
    const nonVipProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { nickname: "普通账号", vipStatus: "nonVip" },
      }),
      getSong: async (id) => ({ ...songs[id as keyof typeof songs], requiresVip: true }),
    };
    const service = new SongGuessrService({ musicProvider: nonVipProvider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "玩家");
    const hostState = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState");
    await execute(service, guest, {
      id: "ready-before-vip-check",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "start-before-vip-check",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "choose-before-vip-check",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });

    await expect(execute(service, host, {
      id: "submit-vip-song-without-vip",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    })).rejects.toMatchObject({
      code: "MUSIC_VIP_REQUIRED",
    });
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").phase)
      .toBe("submittingSong");
  });

  test("异步取歌期间出题人离开后不会安装无归属回合", async () => {
    let resolveSong!: (song: SongDetails) => void;
    const pendingSong = new Promise<SongDetails>((resolve) => {
      resolveSong = resolve;
    });
    const delayedProvider: MusicProvider = {
      ...provider,
      getSong: async () => pendingSong,
    };
    const service = new SongGuessrService({ musicProvider: delayedProvider });
    const host = connection(service, "pending-host");
    const guest = connection(service, "pending-submitter");
    await createRoom(service, host);
    const guestState = await joinRoom(service, guest, "出题人");
    await execute(service, guest, {
      id: "pending-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "pending-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "pending-choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: guestState.playerId },
    });

    const submitPromise = execute(service, guest, {
      id: "pending-submit",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    await execute(service, guest, {
      id: "pending-leave",
      type: "song.room.leave",
      roomId: "1234",
      payload: {},
    });
    resolveSong(songs.answer);

    await expect(submitPromise).resolves.toEqual({ ignored: true });
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot")).toMatchObject({
      phase: "choosingSubmitter",
      roundNumber: 0,
    });
  });

  test("Oblivionis 测试房支持人机并不会进入大厅或被空房清理", async () => {
    const service = new SongGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    await createRoom(service, host, { roomId: "Oblivionis", name: "测试房" });

    await execute(service, host, {
      id: "add-bots",
      type: "song.test.addBot",
      roomId: "Oblivionis",
      payload: { count: 2 },
    });
    const withBots = lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(withBots.testMode).toBe(true);
    expect(withBots.players.filter((player) => player.isBot)).toHaveLength(2);
    expect(service.getRoomSummaries()).toHaveLength(0);

    await service.unregisterConnection(host.record.id);
    await service.runHousekeeping();
    const replacement = connection(service, "replacement");
    const replacementState = await joinRoom(service, replacement, "新房主", "Oblivionis");
    expect(lastEvent<SongGuessrRoomSnapshot>(replacement, "song.room.snapshot").hostPlayerId)
      .toBe(replacementState.playerId);

    await execute(service, replacement, {
      id: "remove-bot",
      type: "song.test.removeBot",
      roomId: "Oblivionis",
      payload: { count: 1 },
    });
    expect(lastEvent<SongGuessrRoomSnapshot>(replacement, "song.room.snapshot").players
      .filter((player) => player.isBot)).toHaveLength(1);
  });

  test("Oblivionis 测试房刷新重连后保留房主权限", async () => {
    const service = new SongGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    await createRoom(service, host, { roomId: "Oblivionis", name: "测试房" });
    const hostState = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState");
    await execute(service, host, {
      id: "add-bot-before-refresh",
      type: "song.test.addBot",
      roomId: "Oblivionis",
      payload: { count: 1 },
    });
    const botId = lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").players
      .find((player) => player.isBot)!.id;

    await service.unregisterConnection(host.record.id);
    const refreshed = connection(service, "host-refreshed");
    await execute(service, refreshed, {
      id: "reconnect-after-refresh",
      type: "song.room.reconnect",
      payload: { roomId: "Oblivionis", sessionToken: hostState.sessionToken },
    });

    expect(lastEvent<SongGuessrRoomSnapshot>(refreshed, "song.room.snapshot").hostPlayerId)
      .toBe(hostState.playerId);
    await expect(execute(service, refreshed, {
      id: "kick-after-refresh",
      type: "song.room.kick",
      roomId: "Oblivionis",
      payload: { playerId: botId },
    })).resolves.toEqual({ kicked: true });
  });

  test("Oblivionis 测试房允许出题人自己猜且提交歌曲不会被误判为猜对", async () => {
    const service = new SongGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "host");
    await createRoom(service, host, { roomId: "Oblivionis", name: "测试房" });
    const hostState = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState");

    await execute(service, host, {
      id: "add-bot",
      type: "song.test.addBot",
      roomId: "Oblivionis",
      payload: { count: 1 },
    });
    await execute(service, host, {
      id: "start",
      type: "song.game.start",
      roomId: "Oblivionis",
      payload: {},
    });
    await execute(service, host, {
      id: "choose-self",
      type: "song.game.chooseSubmitter",
      roomId: "Oblivionis",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "submit-answer",
      type: "song.game.submitSong",
      roomId: "Oblivionis",
      payload: { songId: "answer" },
    });

    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");
    expect(lastEvent<SongGuessrPrivateState>(host, "song.game.privateState")).toMatchObject({
      isSubmitter: true,
      canGuess: false,
      canGiveUp: true,
      visibleAttempts: [],
    });

    await execute(service, host, {
      id: "self-audio-ready",
      type: "song.game.audioReady",
      roomId: "Oblivionis",
      payload: { roundNumber: 1 },
    });
    expect(lastEvent<SongGuessrPrivateState>(host, "song.game.privateState").canGuess).toBe(true);

    const wrong = await execute(service, host, {
      id: "self-wrong-guess",
      type: "song.game.guess",
      roomId: "Oblivionis",
      payload: { songId: "wrong" },
    }) as { attempt: { result: string } };
    expect(wrong.attempt.result).toBe("wrong");
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");

    const correct = await execute(service, host, {
      id: "self-correct-guess",
      type: "song.game.guess",
      roomId: "Oblivionis",
      payload: { songId: "answer" },
    }) as { attempt: { result: string } };
    expect(correct.attempt.result).toBe("correct");
    const result = lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(result.phase).toBe("roundResult");
    expect(result.roundSummary?.correctPlayerIds).toContain(hostState.playerId);
  });

  test("完整迁移出题、逐次猜测、反馈、计分与结算流程", async () => {
    const service = new SongGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      now: () => 1_000,
    });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const hostState = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState");

    await execute(service, guest, {
      id: "join",
      type: "song.room.join",
      roomId: "1234",
      payload: { userName: "玩家" },
    });
    await execute(service, guest, {
      id: "ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "submit",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });

    const playing = lastEvent<SongGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(playing.phase).toBe("playing");
    expect(playing.currentRound?.audioUrl).toBe("https://audio/answer.mp3");
    expect(playing.currentRound).not.toHaveProperty("attempts");
    expect(JSON.stringify(playing)).not.toContain("答案歌");
    await expect(execute(service, host, {
      id: "normal-submitter-cannot-guess",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "wrong" },
    })).rejects.toMatchObject({ code: "SUBMITTER_CANNOT_GUESS" });

    await execute(service, guest, {
      id: "audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    const wrong = await execute(service, guest, {
      id: "wrong",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "wrong" },
    }) as { attempt: { feedback: { releaseYearDirection: string } } };
    expect(wrong.attempt.feedback.releaseYearDirection).toBe("higher");
    expect(lastEvent<SongGuessrPrivateState>(guest, "song.game.privateState").visibleAttempts)
      .toEqual([
        expect.objectContaining({
          playerName: "玩家",
          guessedSong: expect.objectContaining({ title: "错误歌" }),
        }),
      ]);
    expect(lastEvent<SongGuessrPrivateState>(host, "song.game.privateState").visibleAttempts)
      .toEqual([
        expect.objectContaining({
          playerName: "玩家",
          guessedSong: expect.objectContaining({ title: "错误歌" }),
        }),
      ]);

    await execute(service, guest, {
      id: "correct",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    const result = lastEvent<SongGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(result.phase).toBe("roundResult");
    expect(result.roundSummary?.song.title).toBe("答案歌");
    expect(result.roundSummary?.scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerName: "玩家", score: 1, delta: 1 }),
        expect.objectContaining({ playerName: "房主", score: 3, delta: 3 }),
      ]),
    );
  });

  test("猜歌玩家刷新时保持当前回合并刷新播放地址", async () => {
    let songLoads = 0;
    const refreshProvider: MusicProvider = {
      ...provider,
      getSong: async (id) => ({
        ...songs[id as keyof typeof songs],
        audioUrl: `https://audio/refresh-${++songLoads}.mp3`,
      }),
    };
    const service = new SongGuessrService({ musicProvider: refreshProvider, random: { nextInt: () => 0 } });
    const host = connection(service, "refresh-host");
    const guest = connection(service, "refresh-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "刷新玩家");
    await startRound(service, host, guest, hostState.playerId);
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound?.audioUrl)
      .toBe("https://audio/refresh-1.mp3");

    await service.unregisterConnection(guest.record.id);
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");

    const refreshed = connection(service, "refresh-guest-new");
    await execute(service, refreshed, {
      id: "refresh-reconnect",
      type: "song.room.reconnect",
      payload: { roomId: "1234", sessionToken: guestState.sessionToken },
    });
    const snapshot = lastEvent<SongGuessrRoomSnapshot>(refreshed, "song.room.snapshot");
    expect(snapshot).toMatchObject({
      phase: "playing",
      currentRound: {
        roundNumber: 1,
        audioUrl: "https://audio/refresh-2.mp3",
      },
    });
    expect(lastEvent<SongGuessrPrivateState>(refreshed, "song.game.privateState").canGiveUp).toBe(true);
  });

  test("结算后补发旧 audioReady 会被幂等忽略", async () => {
    const service = new SongGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "stale-ready-host");
    const guest = connection(service, "stale-ready-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);
    await execute(service, guest, {
      id: "stale-ready-give-up",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });

    await expect(execute(service, guest, {
      id: "stale-ready-after-result",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    })).resolves.toEqual({ ignored: true });
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("roundResult");
  });

  test("自动出题按歌单与歌手交集随机选择歌曲且所有正式玩家都可猜", async () => {
    const autoProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "测试歌单", songCount: 2 },
        songs: [songs.answer, songs.wrong],
      }),
      getArtistSongs: async () => [songs.answer],
      getSongPopularity: async (songId) => songId === "answer" ? 12_345 : 999,
    };
    const service = new SongGuessrService({
      musicProvider: autoProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "auto-host");
    const guest = connection(service, "auto-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "自动玩家");
    await execute(service, host, {
      id: "auto-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionMode: "automatic",
        autoFilters: {
          playlist: { id: "42", name: "测试歌单", songCount: 2 },
          artists: [{ id: "7", name: "测试歌手" }],
          minPopularity: 1_000,
        },
      },
    });
    await execute(service, guest, {
      id: "auto-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "auto-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    const snapshot = lastEvent<SongGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(snapshot.phase).toBe("playing");
    expect(snapshot.currentRound?.submitterPlayerId).toBe("");
    expect(snapshot.settings.questionMode).toBe("automatic");
    await execute(service, guest, {
      id: "auto-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    expect(lastEvent<SongGuessrPrivateState>(guest, "song.game.privateState").canGuess).toBe(true);
  });

  test("自动出题只配置歌单时也可以开始", async () => {
    const playlistOnlyProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "测试歌单", songCount: 1 },
        songs: [songs.answer],
      }),
    };
    const service = new SongGuessrService({
      musicProvider: playlistOnlyProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "playlist-host");
    const guest = connection(service, "playlist-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "歌单玩家");
    await execute(service, host, {
      id: "playlist-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionMode: "automatic",
        autoFilters: {
          playlist: { id: "42", name: "测试歌单", songCount: 1 },
          artists: [],
          minPopularity: 0,
        },
      },
    });
    await execute(service, guest, {
      id: "playlist-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await expect(execute(service, host, {
      id: "playlist-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    })).resolves.toMatchObject({ started: true });
  });

  test("自动出题不配置筛选时使用默认热歌榜题库", async () => {
    let sourceId = "";
    const defaultProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async (playlistId) => {
        sourceId = playlistId;
        return { info: { id: playlistId, name: "默认题库", songCount: 1 }, songs: [songs.answer] };
      },
    };
    const service = new SongGuessrService({ musicProvider: defaultProvider, random: { nextInt: () => 0 } });
    const host = connection(service, "default-host");
    const guest = connection(service, "default-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "默认题库玩家");
    await execute(service, host, {
      id: "default-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { questionMode: "automatic", autoFilters: { artists: [], minPopularity: 0 } },
    });
    await execute(service, guest, {
      id: "default-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, { id: "default-start", type: "song.game.start", roomId: "1234", payload: {} });
    expect(sourceId).toBe("3778678");
  });

  test("自动开局的重复请求会被加载锁拦截", async () => {
    let delayStatus = false;
    let releaseStatus!: () => void;
    const pendingStatus = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const autoProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => {
        if (delayStatus) await pendingStatus;
        return { cookie, account: { nickname: "测试账号", vipStatus: "vip" } };
      },
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "测试歌单", songCount: 1 },
        songs: [songs.answer],
      }),
    };
    const service = new SongGuessrService({ musicProvider: autoProvider, random: { nextInt: () => 0 } });
    const host = connection(service, "double-start-host");
    const guest = connection(service, "double-start-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "重复开局玩家");
    await execute(service, host, {
      id: "double-start-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { questionMode: "automatic", autoFilters: { artists: [], minPopularity: 0 } },
    });
    await execute(service, guest, {
      id: "double-start-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });

    delayStatus = true;
    const firstStart = execute(service, host, {
      id: "double-start-first",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await expect(execute(service, host, {
      id: "double-start-second",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    })).rejects.toMatchObject({ code: "INVALID_PHASE" });

    releaseStatus();
    await expect(firstStart).resolves.toEqual({ started: true });
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");
  });

  test("自动模式全员超时结算后可以正常进入第二轮", async () => {
    let now = 10_000;
    const autoProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "测试歌单", songCount: 1 },
        songs: [songs.answer],
      }),
    };
    const service = new SongGuessrService({
      musicProvider: autoProvider,
      random: { nextInt: () => 0 },
      now: () => now,
    });
    const host = connection(service, "timeout-auto-host");
    const guest = connection(service, "timeout-auto-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "自动玩家");
    await execute(service, host, {
      id: "timeout-auto-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionMode: "automatic",
        maxGuessesPerRound: 1,
        guessDurationSeconds: 10,
        autoFilters: {
          playlist: { id: "42", name: "测试歌单", songCount: 1 },
          artists: [],
          minPopularity: 0,
        },
      },
    });
    await execute(service, guest, {
      id: "timeout-auto-ready-guest",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "timeout-auto-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    for (const [client, id] of [[host, "host"], [guest, "guest"]] as const) {
      await execute(service, client, {
        id: `timeout-auto-audio-${id}`,
        type: "song.game.audioReady",
        roomId: "1234",
        payload: { roundNumber: 1 },
      });
    }

    now += 10_001;
    await service.runHousekeeping();
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot")).toMatchObject({
      phase: "roundResult",
      roundNumber: 1,
    });

    await execute(service, host, {
      id: "timeout-auto-next",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot")).toMatchObject({
      phase: "playing",
      roundNumber: 2,
      currentRound: { roundNumber: 2 },
    });
  });

  test("自动下一轮取题失败时保留上一轮答案页", async () => {
    let playlistCalls = 0;
    const failingNextProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => {
        playlistCalls += 1;
        if (playlistCalls > 1) throw new AppError("MUSIC_API_FAILED", "题库暂时不可用");
        return { info: { id: "42", name: "测试歌单", songCount: 1 }, songs: [songs.answer] };
      },
    };
    const service = new SongGuessrService({ musicProvider: failingNextProvider, random: { nextInt: () => 0 } });
    const host = connection(service, "failed-next-host");
    const guest = connection(service, "failed-next-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "玩家");
    await execute(service, host, {
      id: "failed-next-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionMode: "automatic",
        autoFilters: {
          playlist: { id: "42", name: "测试歌单", songCount: 1 },
          artists: [],
          minPopularity: 0,
        },
      },
    });
    await execute(service, guest, {
      id: "failed-next-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, { id: "failed-next-start", type: "song.game.start", roomId: "1234", payload: {} });
    for (const [client, id] of [[host, "host"], [guest, "guest"]] as const) {
      await execute(service, client, {
        id: `failed-next-audio-${id}`,
        type: "song.game.audioReady",
        roomId: "1234",
        payload: { roundNumber: 1 },
      });
      await execute(service, client, {
        id: `failed-next-give-up-${id}`,
        type: "song.game.giveUp",
        roomId: "1234",
        payload: {},
      });
    }
    const summary = lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").roundSummary;

    await expect(execute(service, host, {
      id: "failed-next-command",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    })).rejects.toMatchObject({ code: "MUSIC_API_FAILED" });
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot")).toMatchObject({
      phase: "roundResult",
      roundNumber: 1,
      roundSummary: summary,
    });
  });

  test("血战模式首位按正式玩家数计分且不会在首位答对后提前结算", async () => {
    const service = new SongGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "blood-host");
    const first = connection(service, "blood-first");
    const second = connection(service, "blood-second");
    const third = connection(service, "blood-third");
    const spectator = connection(service, "blood-spectator");
    await createRoom(service, host);
    const hostState = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState");
    const firstState = await joinRoom(service, first, "第一名");
    const secondState = await joinRoom(service, second, "第二名");
    const thirdState = await joinRoom(service, third, "第三名");
    await joinRoom(service, spectator, "旁观者");
    await execute(service, spectator, {
      id: "spectate",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    });
    await execute(service, host, {
      id: "blood-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { bloodMode: true },
    });
    for (const [client, id] of [[first, "first"], [second, "second"], [third, "third"]] as const) {
      await execute(service, client, {
        id: `ready-${id}`,
        type: "song.player.setReady",
        roomId: "1234",
        payload: { ready: true },
      });
    }
    await execute(service, host, {
      id: "blood-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "blood-choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "blood-submit",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    for (const [client, id] of [[first, "first"], [second, "second"], [third, "third"]] as const) {
      await execute(service, client, {
        id: `audio-${id}`,
        type: "song.game.audioReady",
        roomId: "1234",
        payload: { roundNumber: 1 },
      });
    }

    await execute(service, first, {
      id: "guess-first",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    let snapshot = lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.phase).toBe("playing");
    expect(snapshot.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstState.playerId, score: 4 }),
    ]));

    await execute(service, second, {
      id: "guess-second",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");
    await execute(service, third, {
      id: "guess-third",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    snapshot = lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.phase).toBe("roundResult");
    expect(snapshot.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstState.playerId, score: 4 }),
      expect.objectContaining({ id: secondState.playerId, score: 3 }),
      expect.objectContaining({ id: thirdState.playerId, score: 2 }),
      expect.objectContaining({ name: "旁观者", score: 0, membership: "spectator" }),
    ]));
  });

  test("关闭歌词和猜测时限后不公开歌词且不创建截止时间", async () => {
    const service = new SongGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      now: () => 10_000,
    });
    const host = connection(service, "settings-host");
    const guest = connection(service, "settings-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");
    await execute(service, host, {
      id: "hidden-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { showLyrics: false, showGuessTimer: false },
    });
    await startRound(service, host, guest, hostState.playerId);

    const playing = lastEvent<SongGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(playing.settings).toMatchObject({ showLyrics: false, showGuessTimer: false });
    expect(playing.currentRound?.lyricClip.lines).toEqual([]);
    const ready = await execute(service, guest, {
      id: "no-timer-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    }) as { deadlineAt?: number };
    expect(ready.deadlineAt).toBeUndefined();
    expect(lastEvent<SongGuessrPrivateState>(guest, "song.game.privateState").guessDeadlineAt)
      .toBeUndefined();
  });

  test("回合结算后返回等待阶段保留轮数和累计分数", async () => {
    const service = new SongGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const hostState = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);
    await execute(service, guest, {
      id: "audio-ready-first-round",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    await execute(service, guest, {
      id: "correct-first-round",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "answer" },
    });

    await execute(service, host, {
      id: "return-to-waiting",
      type: "song.game.finish",
      roomId: "1234",
      payload: {},
    });
    const waiting = lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(waiting).toMatchObject({ phase: "waiting", roundNumber: 1 });
    expect(waiting.roundSummary).toBeUndefined();
    expect(waiting.finalScores).toBeUndefined();
    expect(waiting.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "房主", score: 3, isReady: true }),
      expect.objectContaining({ name: "玩家", score: 1, isReady: false }),
    ]));

    await execute(service, guest, {
      id: "ready-again",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "start-again",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    const restarted = lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(restarted).toMatchObject({ phase: "choosingSubmitter", roundNumber: 1 });
    expect(restarted.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "房主", score: 3 }),
      expect.objectContaining({ name: "玩家", score: 1 }),
    ]));
  });

  test("中途加入者只能在等待阶段切换席位，旁观真人也可以担任出题人", async () => {
    const service = new SongGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    const lateJoiner = connection(service, "late");
    const observer = connection(service, "observer");
    await createRoom(service, host);
    const hostState = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);

    const lateState = await joinRoom(service, lateJoiner, "中途加入");
    expect(lastEvent<SongGuessrRoomSnapshot>(lateJoiner, "song.room.snapshot").players)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: lateState.playerId, membership: "spectator" }),
      ]));
    await expect(execute(service, lateJoiner, {
      id: "join-next-round",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: false },
    })).rejects.toMatchObject({ code: "INVALID_PHASE" });
    expect(lastEvent<SongGuessrPrivateState>(lateJoiner, "song.game.privateState").canGuess).toBe(false);
    const observerState = await joinRoom(service, observer, "旁观出题人");

    await execute(service, guest, {
      id: "give-up-first-round",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "next-round",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "choose-observer",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: observerState.playerId },
    });
    expect(lastEvent<SongGuessrPrivateState>(observer, "song.game.privateState").canSubmitSong).toBe(true);
    await execute(service, observer, {
      id: "observer-submits",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    expect(lastEvent<SongGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound)
      .toMatchObject({ submitterPlayerId: observerState.playerId });
    expect(lastEvent<SongGuessrPrivateState>(lateJoiner, "song.game.privateState").canGiveUp).toBe(false);
  });

  test("进行中禁止修改房间设置且回合继续使用开局快照", async () => {
    let now = 20_000;
    const service = new SongGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      now: () => now,
    });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const hostState = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);
    await execute(service, guest, {
      id: "audio-first-round",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    const firstDeadline = lastEvent<SongGuessrPrivateState>(guest, "song.game.privateState").guessDeadlineAt;
    expect(firstDeadline).toBe(now + 60_000);

    await expect(execute(service, host, {
      id: "settings-during-round",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { maxGuessesPerRound: 1, guessDurationSeconds: 10, lyricsLineCount: 3 },
    })).rejects.toMatchObject({ code: "INVALID_PHASE" });
    const currentPrivate = lastEvent<SongGuessrPrivateState>(guest, "song.game.privateState");
    expect(currentPrivate.remainingGuesses).toBe(3);
    expect(currentPrivate.guessDeadlineAt).toBe(firstDeadline);

    await execute(service, guest, {
      id: "give-up-current",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "next-round-settings",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "choose-next",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "submit-next",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    expect(lastEvent<SongGuessrRoomSnapshot>(guest, "song.room.snapshot").currentRound?.lyricClip.lines)
      .toHaveLength(5);
    now += 1_000;
    await execute(service, guest, {
      id: "audio-next-round",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 2 },
    });
    const nextPrivate = lastEvent<SongGuessrPrivateState>(guest, "song.game.privateState");
    expect(nextPrivate.remainingGuesses).toBe(3);
    expect(nextPrivate.guessDeadlineAt).toBe(now + 60_000);
  });

  test("禁止用展示中的歌词原词搜索但允许普通关键词", async () => {
    const service = new SongGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const hostState = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);

    await expect(execute(service, guest, {
      id: "search-lyric",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "歌词1" },
    })).rejects.toMatchObject({ code: "LYRIC_SEARCH_FORBIDDEN" });
    await expect(execute(service, guest, {
      id: "search-normal",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "测试歌手" },
    })).resolves.toMatchObject({ results: expect.any(Array) });
  });

  test("玩家可以主动放弃并且只记录一个放弃结果", async () => {
    const service = new SongGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const hostState = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);

    expect(lastEvent<SongGuessrPrivateState>(guest, "song.game.privateState").canGiveUp).toBe(true);
    await execute(service, guest, {
      id: "give-up",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    const result = lastEvent<SongGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(result.phase).toBe("roundResult");
    expect(result.roundSummary?.attempts).toEqual([
      expect.objectContaining({ playerName: "玩家", result: "gaveUp" }),
    ]);
    expect(result.roundSummary?.attempts[0]).not.toHaveProperty("guessedSong");
  });

  test("housekeeping 将过期猜测记为超时并在次数耗尽后结算", async () => {
    let now = 10_000;
    const service = new SongGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      now: () => now,
    });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const hostPlayerId = lastEvent<SongGuessrPrivateState>(host, "song.game.privateState").playerId;
    await execute(service, guest, {
      id: "join",
      type: "song.room.join",
      roomId: "1234",
      payload: { userName: "玩家" },
    });
    await execute(service, guest, { id: "ready", type: "song.player.setReady", roomId: "1234", payload: { ready: true } });
    await execute(service, host, {
      id: "settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { maxGuessesPerRound: 1, guessDurationSeconds: 10 },
    });
    await execute(service, host, { id: "start", type: "song.game.start", roomId: "1234", payload: {} });
    await execute(service, host, { id: "choose", type: "song.game.chooseSubmitter", roomId: "1234", payload: { playerId: hostPlayerId } });
    await execute(service, host, { id: "song", type: "song.game.submitSong", roomId: "1234", payload: { songId: "answer" } });
    await execute(service, guest, { id: "audio", type: "song.game.audioReady", roomId: "1234", payload: { roundNumber: 1 } });
    const originalDeadline = lastEvent<SongGuessrPrivateState>(guest, "song.game.privateState").guessDeadlineAt;
    now += 5_000;
    await execute(service, guest, { id: "audio-again", type: "song.game.audioReady", roomId: "1234", payload: { roundNumber: 1 } });
    expect(lastEvent<SongGuessrPrivateState>(guest, "song.game.privateState").guessDeadlineAt)
      .toBe(originalDeadline);

    now += 5_000;
    await service.runHousekeeping();
    const result = lastEvent<SongGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(result.phase).toBe("roundResult");
    expect(result.roundSummary?.attempts[0]).toMatchObject({ result: "timeout", playerName: "玩家" });
    expect(result.roundSummary?.scores).toEqual(
      expect.arrayContaining([expect.objectContaining({ playerName: "房主", score: 5 })]),
    );
  });
});
