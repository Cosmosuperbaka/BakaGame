import { describe, expect, test } from "bun:test";

import { CCBService } from "../src/application/CCBService";
import {
  HOST_RECONNECT_TIMEOUT_MS,
  PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS,
  ROOM_EMPTY_GRACE_PERIOD_MS,
  ROOM_IDLE_TIMEOUT_MS,
} from "../src/config/Constants";
import type { ConnectionRecord } from "../src/domain/Model";
import type {
  CCBClientMessage,
  CCBPrivateState,
  CCBRoomSnapshot,
  CCBRoomSummary,
} from "../src/shared/Index";

interface TestConnection {
  record: ConnectionRecord;
  sent: Array<{ type?: string; event?: string; payload?: unknown }>;
  closed: Array<{ code?: number; reason?: string }>;
  stateResets: number;
}

const createService = () => {
  let currentTime = Date.UTC(2026, 8, 16, 0, 0, 0);
  const service = new CCBService({ now: () => currentTime });
  return {
    service,
    advanceTime: (milliseconds: number) => {
      currentTime += milliseconds;
    },
  };
};

const connection = (service: CCBService, id: string): TestConnection => {
  const state: TestConnection = {
    record: undefined as unknown as ConnectionRecord,
    sent: [],
    closed: [],
    stateResets: 0,
  };
  const record: ConnectionRecord = {
    id,
    lobbySubscribed: false,
    send: (payload) => state.sent.push(payload as TestConnection["sent"][number]),
    sendPacket: (payload) => state.sent.push(payload as TestConnection["sent"][number]),
    resetStateSync: () => {
      state.stateResets += 1;
    },
    sendStateSyncCalibration: (payload) =>
      state.sent.push(payload as TestConnection["sent"][number]),
    close: (code?: number, reason?: string) => {
      state.closed.push({ code, reason });
    },
  };
  state.record = record;
  service.registerConnection(record);
  return state;
};

const execute = (
  service: CCBService,
  client: TestConnection,
  message: CCBClientMessage,
) => service.execute(client.record.id, message);

const eventsOf = <T>(client: TestConnection, event: string): T[] =>
  client.sent
    .filter((item) => item.type === "event" && item.event === event)
    .map((item) => item.payload as T);

const lastEvent = <T>(client: TestConnection, event: string): T =>
  eventsOf<T>(client, event).at(-1) as T;

const createRoom = (
  service: CCBService,
  host: TestConnection,
  overrides: Partial<Extract<CCBClientMessage, { type: "ccb.room.create" }>["payload"]> = {},
) =>
  execute(service, host, {
    id: `create-${host.record.id}`,
    type: "ccb.room.create",
    payload: {
      roomId: "1234",
      name: "猜角色房",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
      ...overrides,
    },
  });

const joinRoom = (
  service: CCBService,
  client: TestConnection,
  overrides: Partial<Extract<CCBClientMessage, { type: "ccb.room.join" }>["payload"]> = {},
  roomId = "1234",
) =>
  execute(service, client, {
    id: `join-${client.record.id}`,
    type: "ccb.room.join",
    roomId,
    payload: { userName: client.record.id, ...overrides },
  });

/** 断言业务错误码：裸露的 toThrow 无法区分「失败原因」，这里要求精确到码。 */
const errorCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? "NO_CODE";
  }
  return "NO_ERROR";
};

describe("CCB 房间生命周期", () => {
  test("建房返回会话并广播房间快照，房主默认已准备", async () => {
    const { service } = createService();
    const host = connection(service, "host");

    const created = (await createRoom(service, host)) as {
      roomId: string;
      playerId: string;
      sessionToken: string;
      snapshot: CCBRoomSnapshot;
      privateState: CCBPrivateState;
    };

    expect(created.roomId).toBe("1234");
    expect(created.sessionToken).toContain("ccb_session_");
    expect(created.snapshot).toMatchObject({
      roomId: "1234",
      name: "猜角色房",
      hostPlayerId: created.playerId,
      phase: "waiting",
      roundNumber: 0,
      testMode: false,
      hasPassword: false,
      settings: { mode: "normal", guessLimit: 10, subjectTypes: [2] },
    });
    expect(created.snapshot.players).toHaveLength(1);
    expect(created.snapshot.players[0]).toMatchObject({
      id: created.playerId,
      name: "房主",
      isHost: true,
      isReady: true,
      membership: "active",
      score: 0,
      marks: "",
      guessCount: 0,
      finished: false,
      team: null,
      message: "",
    });
    expect(created.privateState).toMatchObject({
      playerId: created.playerId,
      canStartRound: false,
      canGuess: false,
      canSetAnswer: false,
      canSurrender: false,
      remainingGuesses: 10,
      ownGuesses: [],
      hints: [],
    });
    // 房内连接收到的是状态通道事件，不会收到大厅列表
    expect(lastEvent<CCBRoomSnapshot>(host, "ccb.room.snapshot").players).toHaveLength(1);
    expect(eventsOf(host, "ccb.lobby.rooms")).toHaveLength(0);
  });

  test("建房时自定义设置生效，年份区间反序被拒绝", async () => {
    const { service } = createService();
    const host = connection(service, "host");

    const created = (await createRoom(service, host, {
      settings: { mode: "sync", topNSubjects: 100, guessLimit: 6, timeLimitMs: 60_000 },
    })) as { snapshot: CCBRoomSnapshot };

    expect(created.snapshot.settings).toMatchObject({
      mode: "sync",
      topNSubjects: 100,
      guessLimit: 6,
      timeLimitMs: 60_000,
    });

    const other = connection(service, "other");
    expect(
      await errorCode(
        createRoom(service, other, {
          roomId: "4321",
          settings: { startYear: 2020, endYear: 2010 },
        }),
      ),
    ).toBe("INVALID_SETTINGS");
    expect(service.getRoomSummaries().map((summary) => summary.roomId)).toEqual(["1234"]);
  });

  test("房间号重复、非法房间号与重复用户名都会失败", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    await createRoom(service, host);

    const second = connection(service, "second");
    expect(await errorCode(createRoom(service, second))).toBe("ROOM_EXISTS");

    const third = connection(service, "third");
    expect(await errorCode(createRoom(service, third, { roomId: "12" }))).toBe("INVALID_ROOM_ID");

    const guest = connection(service, "guest");
    await joinRoom(service, guest);
    const another = connection(service, "another");
    expect(await errorCode(joinRoom(service, another, { userName: "guest" }))).toBe("NAME_CONFLICT");
    expect(await errorCode(joinRoom(service, another, { userName: "另一个" }, "9999"))).toBe(
      "ROOM_NOT_FOUND",
    );
  });

  test("私密房间需要密码，密码错误无法加入", async () => {
    const { service } = createService();
    const noPassword = connection(service, "no-password");
    expect(
      await errorCode(createRoom(service, noPassword, { visibility: "private" })),
    ).toBe("PASSWORD_REQUIRED");

    const host = connection(service, "host");
    await createRoom(service, host, { visibility: "private", password: "secret" });
    const guest = connection(service, "guest");
    expect(await errorCode(joinRoom(service, guest, { password: "wrong" }))).toBe(
      "PASSWORD_INCORRECT",
    );
    await joinRoom(service, guest, { password: "secret" });
    expect(lastEvent<CCBRoomSnapshot>(guest, "ccb.room.snapshot").players).toHaveLength(2);
  });

  test("加入后系统消息入聊天流，加入者收到完整快照", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    await createRoom(service, host);

    const guest = connection(service, "guest");
    const joined = (await joinRoom(service, guest)) as { playerId: string };

    const snapshot = lastEvent<CCBRoomSnapshot>(guest, "ccb.room.snapshot");
    expect(snapshot.players.map((player) => player.name)).toEqual(["房主", "guest"]);
    expect(snapshot.chat.map((message) => message.text)).toEqual([
      "房主 创建了房间",
      "guest 加入了房间",
    ]);
    expect(snapshot.chat.every((message) => message.system)).toBe(true);
    expect(snapshot.players.find((player) => player.id === joined.playerId)?.isReady).toBe(false);
  });

  test("重连用会话令牌恢复席位，令牌无效则拒绝", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    const created = (await createRoom(service, host)) as { sessionToken: string };

    const revived = connection(service, "revived");
    expect(
      await errorCode(
        execute(service, revived, {
          id: "reconnect-bad",
          type: "ccb.room.reconnect",
          payload: { roomId: "1234", sessionToken: "ccb_session_unknown" },
        }),
      ),
    ).toBe("SESSION_INVALID");

    await execute(service, revived, {
      id: "reconnect",
      type: "ccb.room.reconnect",
      payload: { roomId: "1234", sessionToken: created.sessionToken },
    });
    expect(lastEvent<CCBRoomSnapshot>(revived, "ccb.room.snapshot").players).toHaveLength(1);
    // 旧连接必须收到 session.replaced 并被断开，避免同一玩家双开
    expect(eventsOf(host, "session.replaced")).toEqual([{ roomId: "1234" }]);
    expect(host.closed).toEqual([{ code: 4001, reason: "session_replaced" }]);
  });

  test("离开房间移交房主并广播系统消息", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    await createRoom(service, host);
    const guest = connection(service, "guest");
    const joined = (await joinRoom(service, guest)) as { playerId: string };

    expect(
      await execute(service, host, { id: "leave", type: "ccb.room.leave", payload: {} }),
    ).toEqual({ left: true, roomClosed: false });

    const snapshot = lastEvent<CCBRoomSnapshot>(guest, "ccb.room.snapshot");
    expect(snapshot.players).toHaveLength(1);
    expect(snapshot.hostPlayerId).toBe(joined.playerId);
    expect(snapshot.players[0].isReady).toBe(true);
    expect(snapshot.chat.at(-1)?.text).toBe("房主 离开了房间");
  });

  test("最后一人离开会关闭房间", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    await createRoom(service, host);

    // 离开者自己已在 closeRoom 之前脱离房间索引，因此靠 ACK 与房间表判断结果
    expect(
      await execute(service, host, { id: "leave", type: "ccb.room.leave", payload: {} }),
    ).toEqual({ left: true, roomClosed: true });
    expect(service.getRoomSummaries()).toEqual([]);
    expect(service.getHealthSnapshot().roomCount).toBe(0);
  });
});

describe("CCB 成员与聊天", () => {
  test("准备状态受房主与身份约束", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    await createRoom(service, host);
    const guest = connection(service, "guest");
    await joinRoom(service, guest);

    expect(
      await execute(service, guest, {
        id: "ready",
        type: "ccb.player.setReady",
        payload: { ready: true },
      }),
    ).toEqual({ ready: true });
    expect(
      lastEvent<CCBRoomSnapshot>(host, "ccb.room.snapshot").players.map((player) => player.isReady),
    ).toEqual([true, true]);

    // 房主无法自降准备状态
    expect(
      await execute(service, host, {
        id: "host-ready",
        type: "ccb.player.setReady",
        payload: { ready: false },
      }),
    ).toEqual({ ready: true });

    await execute(service, guest, {
      id: "spectate",
      type: "ccb.player.setSpectator",
      payload: { spectator: true },
    });
    expect(
      await errorCode(
        execute(service, guest, {
          id: "ready-as-spectator",
          type: "ccb.player.setReady",
          payload: { ready: true },
        }),
      ),
    ).toBe("SPECTATOR_FORBIDDEN");
  });

  test("切换观战受房间开关限制并同步大厅计数", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    await createRoom(service, host, { allowSpectators: false });
    const guest = connection(service, "guest");
    await joinRoom(service, guest);

    expect(
      await errorCode(
        execute(service, guest, {
          id: "spectate",
          type: "ccb.player.setSpectator",
          payload: { spectator: true },
        }),
      ),
    ).toBe("SPECTATORS_DISABLED");

    await execute(service, host, {
      id: "open-spectators",
      type: "ccb.room.updateSettings",
      payload: { allowSpectators: true },
    });
    expect(
      await execute(service, guest, {
        id: "spectate-again",
        type: "ccb.player.setSpectator",
        payload: { spectator: true },
      }),
    ).toEqual({ spectator: true, changed: true });
    expect(service.getRoomSummaries()[0]).toMatchObject({ playerCount: 1, spectatorCount: 1 });

    const lobby = connection(service, "lobby");
    await execute(service, lobby, {
      id: "subscribe",
      type: "ccb.lobby.subscribeRooms",
      payload: {},
    });
    await execute(service, guest, {
      id: "back-to-active",
      type: "ccb.player.setSpectator",
      payload: { spectator: false },
    });
    expect(lastEvent<CCBRoomSummary[]>(lobby, "ccb.lobby.rooms")[0]).toMatchObject({
      playerCount: 2,
      spectatorCount: 0,
      onlineCount: 2,
    });
  });

  test("自定义短消息截断到契约上限", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    await createRoom(service, host);

    const result = (await execute(service, host, {
      id: "message",
      type: "ccb.player.setMessage",
      payload: { message: "一".repeat(80) },
    })) as { message: string };

    expect(result.message).toHaveLength(32);
    expect(lastEvent<CCBRoomSnapshot>(host, "ccb.room.snapshot").players[0].message).toHaveLength(32);
  });

  test("聊天消息广播并裁剪到上限，空消息被拒绝", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    await createRoom(service, host);

    for (let index = 0; index < 25; index += 1) {
      await execute(service, host, {
        id: `chat-${index}`,
        type: "ccb.chat.send",
        payload: { text: `消息 ${index}` },
      });
    }

    const snapshot = lastEvent<CCBRoomSnapshot>(host, "ccb.room.snapshot");
    expect(snapshot.chat).toHaveLength(20);
    expect(snapshot.chat.at(-1)?.text).toBe("消息 24");

    expect(
      await errorCode(
        execute(service, host, { id: "blank", type: "ccb.chat.send", payload: { text: "   " } }),
      ),
    ).toBe("INVALID_MESSAGE");
  });

  test("踢人只能由房主执行，被踢者收到通知并被断开", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    await createRoom(service, host);
    const guest = connection(service, "guest");
    const joined = (await joinRoom(service, guest)) as { playerId: string };

    expect(
      await errorCode(
        execute(service, guest, {
          id: "kick-as-guest",
          type: "ccb.room.kick",
          payload: { playerId: joined.playerId },
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await errorCode(
        execute(service, host, {
          id: "kick-missing",
          type: "ccb.room.kick",
          payload: { playerId: "ccb_player_missing" },
        }),
      ),
    ).toBe("PLAYER_NOT_FOUND");

    expect(
      await execute(service, host, {
        id: "kick",
        type: "ccb.room.kick",
        payload: { playerId: joined.playerId },
      }),
    ).toEqual({ kicked: true });

    expect(eventsOf(guest, "ccb.room.kicked")).toEqual([{ roomId: "1234" }]);
    expect(guest.closed).toEqual([{ code: 4003, reason: "kicked" }]);
    expect(lastEvent<CCBRoomSnapshot>(host, "ccb.room.snapshot").players).toHaveLength(1);
    expect(
      await errorCode(
        execute(service, host, {
          id: "kick-again",
          type: "ccb.room.kick",
          payload: { playerId: joined.playerId },
        }),
      ),
    ).toBe("PLAYER_NOT_FOUND");
  });

  test("转让房主只接受在线的正式玩家", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    await createRoom(service, host);
    const guest = connection(service, "guest");
    const joined = (await joinRoom(service, guest)) as { playerId: string };
    const watcher = connection(service, "watcher");
    const watcherJoined = (await joinRoom(service, watcher)) as { playerId: string };
    await execute(service, watcher, {
      id: "spectate",
      type: "ccb.player.setSpectator",
      payload: { spectator: true },
    });

    expect(
      await errorCode(
        execute(service, host, {
          id: "transfer-spectator",
          type: "ccb.room.transferHost",
          payload: { playerId: watcherJoined.playerId },
        }),
      ),
    ).toBe("INVALID_TARGET");
    expect(
      await errorCode(
        execute(service, host, {
          id: "transfer-missing",
          type: "ccb.room.transferHost",
          payload: { playerId: "ccb_player_missing" },
        }),
      ),
    ).toBe("INVALID_TARGET");

    expect(
      await execute(service, host, {
        id: "transfer",
        type: "ccb.room.transferHost",
        payload: { playerId: joined.playerId },
      }),
    ).toEqual({ hostPlayerId: joined.playerId });

    const snapshot = lastEvent<CCBRoomSnapshot>(host, "ccb.room.snapshot");
    expect(snapshot.hostPlayerId).toBe(joined.playerId);
    expect(snapshot.players.filter((player) => player.isHost).map((player) => player.name)).toEqual([
      "guest",
    ]);
  });

  test("人机增减只允许房主，且名字按后缀递增", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    await createRoom(service, host);
    const guest = connection(service, "guest");
    await joinRoom(service, guest);

    expect(
      await errorCode(execute(service, guest, { id: "add", type: "ccb.test.addBot", payload: {} })),
    ).toBe("FORBIDDEN");

    const added = (await execute(service, host, {
      id: "add",
      type: "ccb.test.addBot",
      payload: { count: 2 },
    })) as { added: string[] };
    expect(added.added).toHaveLength(2);
    expect(
      lastEvent<CCBRoomSnapshot>(host, "ccb.room.snapshot").players.map((player) => player.name),
    ).toEqual(["房主", "guest", "测试人机 A", "测试人机 B"]);

    const removed = (await execute(service, host, {
      id: "remove",
      type: "ccb.test.removeBot",
      payload: {},
    })) as { removed: string[] };
    expect(removed.removed).toHaveLength(1);
    expect(
      lastEvent<CCBRoomSnapshot>(host, "ccb.room.snapshot").players.filter(
        (player) => player.isBot,
      ),
    ).toHaveLength(1);
  });
});

describe("CCB 房间设置", () => {
  test("非房主不能改设置，房主可改且切公开后清空密码", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    await createRoom(service, host, { visibility: "private", password: "secret" });
    const guest = connection(service, "guest");
    await joinRoom(service, guest, { password: "secret" });

    expect(
      await errorCode(
        execute(service, guest, {
          id: "settings",
          type: "ccb.room.updateSettings",
          payload: { mode: "sync" },
        }),
      ),
    ).toBe("FORBIDDEN");

    const updated = (await execute(service, host, {
      id: "settings",
      type: "ccb.room.updateSettings",
      payload: { name: "改名了", visibility: "public", mode: "bloodbath", guessLimit: 4 },
    })) as { settings: { mode: string; guessLimit: number } };
    expect(updated.settings).toMatchObject({ mode: "bloodbath", guessLimit: 4 });

    expect(lastEvent<CCBRoomSnapshot>(host, "ccb.room.snapshot")).toMatchObject({
      name: "改名了",
      visibility: "public",
      hasPassword: false,
      settings: { mode: "bloodbath", guessLimit: 4 },
    });
  });

  test("私密房间不能把密码清空，公开房不能无密码转私密", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    await createRoom(service, host, { visibility: "private", password: "secret" });

    // 空白密码视为「不改」，而不是把房间变成无密码的私密房
    await execute(service, host, {
      id: "blank-password",
      type: "ccb.room.updateSettings",
      payload: { password: "   " },
    });
    expect(lastEvent<CCBRoomSnapshot>(host, "ccb.room.snapshot").hasPassword).toBe(true);

    await execute(service, host, {
      id: "make-public",
      type: "ccb.room.updateSettings",
      payload: { visibility: "public" },
    });
    expect(
      await errorCode(
        execute(service, host, {
          id: "make-private",
          type: "ccb.room.updateSettings",
          payload: { visibility: "private" },
        }),
      ),
    ).toBe("PASSWORD_REQUIRED");

    const guest = connection(service, "guest");
    await joinRoom(service, guest);
    expect(service.getRoomSummaries()[0]).toMatchObject({ hasPassword: false, onlineCount: 2 });
  });

  test("年份反序被拒绝且不污染已有设置", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    await createRoom(service, host, { settings: { startYear: 2010, endYear: 2020 } });

    expect(
      await errorCode(
        execute(service, host, {
          id: "bad-years",
          type: "ccb.room.updateSettings",
          payload: { startYear: 2020, endYear: 2010 },
        }),
      ),
    ).toBe("INVALID_SETTINGS");

    // 补丁作用在克隆副本上，失败不能影响房间里的原值
    expect(lastEvent<CCBRoomSnapshot>(host, "ccb.room.snapshot").settings).toMatchObject({
      startYear: 2010,
      endYear: 2020,
    });
  });

  test("请求同步会重置差量基线并只回发给发起者", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    await createRoom(service, host);
    const guest = connection(service, "guest");
    await joinRoom(service, guest);
    const before = eventsOf(host, "ccb.room.snapshot").length;
    const guestBefore = eventsOf(guest, "ccb.room.snapshot").length;

    expect(
      await execute(service, host, { id: "sync", type: "ccb.room.requestSync", payload: {} }),
    ).toEqual({ synced: true });

    expect(host.stateResets).toBeGreaterThan(0);
    expect(eventsOf(host, "ccb.room.snapshot")).toHaveLength(before + 1);
    expect(eventsOf(guest, "ccb.room.snapshot")).toHaveLength(guestBefore);
  });
});

describe("CCB 掉线与房间清理", () => {
  test("房主断线在宽限期后被转移给最早加入的在线玩家", async () => {
    const { service, advanceTime } = createService();
    const host = connection(service, "host");
    const created = (await createRoom(service, host)) as { playerId: string };
    const guest = connection(service, "guest");
    const joined = (await joinRoom(service, guest)) as { playerId: string };

    await service.unregisterConnection(host.record.id);
    expect(lastEvent<CCBRoomSnapshot>(guest, "ccb.room.snapshot").hostPlayerId).toBe(
      created.playerId,
    );
    // 断线不等于离开：宽限期内席位与房主身份都保留
    expect(lastEvent<CCBRoomSnapshot>(guest, "ccb.room.snapshot").players).toHaveLength(2);

    advanceTime(HOST_RECONNECT_TIMEOUT_MS);
    await service.runHousekeeping();

    const snapshot = lastEvent<CCBRoomSnapshot>(guest, "ccb.room.snapshot");
    expect(snapshot.hostPlayerId).toBe(joined.playerId);
    expect(snapshot.players.find((player) => player.id === joined.playerId)?.isReady).toBe(true);
  });

  test("全员离线时先进入空房宽限期，超时才关房", async () => {
    const { service, advanceTime } = createService();
    const host = connection(service, "host");
    await createRoom(service, host);
    const guest = connection(service, "guest");
    await joinRoom(service, guest);

    await service.unregisterConnection(host.record.id);
    await service.unregisterConnection(guest.record.id);

    await service.runHousekeeping();
    expect(service.getRoomSummaries()).toHaveLength(1);

    advanceTime(ROOM_EMPTY_GRACE_PERIOD_MS);
    await service.runHousekeeping();
    expect(service.getRoomSummaries()).toEqual([]);
    expect(service.getHealthSnapshot().roomCount).toBe(0);
  });

  test("房间空置超时按 idle_timeout 关闭并通知房内连接", async () => {
    const { service, advanceTime } = createService();
    const host = connection(service, "host");
    await createRoom(service, host);

    advanceTime(ROOM_IDLE_TIMEOUT_MS);
    await service.runHousekeeping();

    expect(eventsOf(host, "ccb.room.closed")).toEqual([
      { roomId: "1234", reason: "idle_timeout" },
    ]);
  });

  test("掉线玩家超时被清出房间", async () => {
    const { service, advanceTime } = createService();
    const host = connection(service, "host");
    await createRoom(service, host);
    const guest = connection(service, "guest");
    const joined = (await joinRoom(service, guest)) as { playerId: string };

    await service.unregisterConnection(host.record.id);
    // 先越过房主宽限让房主转移，再让原房主超过掉线清理窗口
    advanceTime(HOST_RECONNECT_TIMEOUT_MS);
    await service.runHousekeeping();
    expect(lastEvent<CCBRoomSnapshot>(guest, "ccb.room.snapshot").hostPlayerId).toBe(
      joined.playerId,
    );

    advanceTime(PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS);
    await service.runHousekeeping();
    expect(lastEvent<CCBRoomSnapshot>(guest, "ccb.room.snapshot").players).toHaveLength(1);
  });

  test("掉线观战者立即释放席位，不占用房间成员", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    await createRoom(service, host);
    const watcher = connection(service, "watcher");
    await joinRoom(service, watcher);
    await execute(service, watcher, {
      id: "spectate",
      type: "ccb.player.setSpectator",
      payload: { spectator: true },
    });

    await service.unregisterConnection(watcher.record.id);

    const snapshot = lastEvent<CCBRoomSnapshot>(host, "ccb.room.snapshot");
    expect(snapshot.players).toHaveLength(1);
    expect(snapshot.players[0].name).toBe("房主");
  });

  test("测试房间不会被自动清理", async () => {
    const { service, advanceTime } = createService();
    const host = connection(service, "host");
    const created = (await createRoom(service, host, {
      roomId: "Oblivionis",
      name: "测试房",
    })) as { snapshot: CCBRoomSnapshot };

    expect(created.snapshot.testMode).toBe(true);
    expect(service.getRoomSummaries()).toEqual([]);

    await service.unregisterConnection(host.record.id);
    advanceTime(ROOM_IDLE_TIMEOUT_MS * 2);
    await service.runHousekeeping();
    expect(service.getHealthSnapshot().roomCount).toBe(1);
  });

  test("未加入房间的连接执行房间指令会被拒绝", async () => {
    const { service } = createService();
    const stranger = connection(service, "stranger");

    expect(
      await errorCode(
        execute(service, stranger, { id: "chat", type: "ccb.chat.send", payload: { text: "hi" } }),
      ),
    ).toBe("PLAYER_NOT_IN_ROOM");
    expect(
      await errorCode(
        execute(service, stranger, { id: "leave", type: "ccb.room.leave", payload: {} }),
      ),
    ).toBe("PLAYER_NOT_IN_ROOM");
    expect(
      await errorCode(
        execute(service, stranger, {
          id: "sync",
          type: "ccb.room.requestSync",
          payload: {},
        }),
      ),
    ).toBe("PLAYER_NOT_IN_ROOM");
  });
});

describe("CCB 大厅与运行指标", () => {
  test("大厅订阅者按房间号排序收到房间列表", async () => {
    const { service } = createService();
    const lobby = connection(service, "lobby");
    await execute(service, lobby, {
      id: "subscribe",
      type: "ccb.lobby.subscribeRooms",
      payload: {},
    });
    expect(lastEvent<CCBRoomSummary[]>(lobby, "ccb.lobby.rooms")).toEqual([]);

    const first = connection(service, "first");
    await createRoom(service, first, { roomId: "2222" });
    const second = connection(service, "second");
    await createRoom(service, second, { roomId: "1111", visibility: "private", password: "p" });

    const summaries = lastEvent<CCBRoomSummary[]>(lobby, "ccb.lobby.rooms");
    expect(summaries.map((summary) => summary.roomId)).toEqual(["1111", "2222"]);
    expect(summaries[0]).toMatchObject({
      visibility: "private",
      hasPassword: true,
      allowSpectators: true,
      playerCount: 1,
      spectatorCount: 0,
      onlineCount: 1,
      phase: "waiting",
    });
  });

  test("健康快照统计房间、连接与在线玩家", async () => {
    const { service } = createService();
    expect(service.getHealthSnapshot()).toEqual({
      roomCount: 0,
      connectionCount: 0,
      onlinePlayerCount: 0,
    });

    const host = connection(service, "host");
    await createRoom(service, host);
    const guest = connection(service, "guest");
    await joinRoom(service, guest);

    expect(service.getHealthSnapshot()).toEqual({
      roomCount: 1,
      connectionCount: 2,
      onlinePlayerCount: 2,
    });
  });

  test("停机通知广播给全部连接", async () => {
    const { service } = createService();
    const host = connection(service, "host");
    await createRoom(service, host);
    const stranger = connection(service, "stranger");

    service.notifyShutdown();

    expect(lastEvent<{ message: string }>(stranger, "server.shutdown").message).toContain(
      "服务器已关闭",
    );
    expect(eventsOf(host, "server.shutdown")).toHaveLength(1);
  });
});
