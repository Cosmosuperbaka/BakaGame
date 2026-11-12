import { describe, expect, test } from "bun:test";
import { type JoinedPlayer, createRoom, joinPlayers } from "./Fixtures";
import { LOBBY_MERGE_WINDOW_MS } from "../../src/application/LobbyFanout";
import { WhoIsFakerService } from "../../src/application/WhoIsFakerService";
import { EventLogger } from "../../src/infrastructure/EventLogger";
import {
  JOIN_PASSWORD_MAX_ATTEMPTS,
  JOIN_PASSWORD_ROOM_MAX_ATTEMPTS,
  JOIN_PASSWORD_WINDOW_MS,
} from "../../src/config/Constants";
import { type WhoIsFakerRoomSnapshot } from "../../src/shared/Index";
import {
  createConnection,
  createTestContext,
  execute,
  getEventPayloads,
  getLastEventPayload,
} from ".././Helpers";

describe("大厅与房间", () => {
  test("大厅订阅后会收到房间列表更新", async () => {
    const { service } = createTestContext();
    const lobby = createConnection(service, "lobby");
    const { host } = await createRoom(service, "1111");

    await execute(service, lobby, {
      id: "sub",
      type: "lobby.subscribeRooms",
      payload: {},
    });

    const rooms = getLastEventPayload<Array<{ roomId: string }>>(lobby, "lobby.rooms");
    expect(rooms?.some((room) => room.roomId === "1111")).toBe(true);
    expect(getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")?.roomId).toBe("1111");
  });

  test("大厅列表按合并窗收敛：订阅只回给自己，窗口内的多次变更并为一次下发", async () => {
    const { service, advanceTime } = createTestContext();
    const first = createConnection(service, "lobby-a");
    const second = createConnection(service, "lobby-b");
    const frames = (connection: ReturnType<typeof createConnection>) =>
      getEventPayloads<Array<{ roomId: string }>>(connection, "lobby.rooms");

    for (const connection of [first, second]) {
      await execute(service, connection, {
        id: `sub-${connection.record.id}`,
        type: "lobby.subscribeRooms",
        payload: {},
      });
    }
    // 旧写法向全服重发一遍：N 个人同时打开大厅就是 N×N 帧。现在每人只拿自己那一份。
    expect(frames(first)).toHaveLength(1);
    expect(frames(second)).toHaveLength(1);

    // 窗口起点的第一次变更立刻下发，随后的建房攒在窗内。
    await createRoom(service, "2222");
    await createRoom(service, "3333");
    await createRoom(service, "4444");
    expect(frames(first)).toHaveLength(2);
    expect(frames(second)).toHaveLength(2);

    // 尾沿自己收敛：不需要新事件，越过窗口后攒下的变更一次带出去。
    advanceTime(LOBBY_MERGE_WINDOW_MS);
    expect(frames(first)).toHaveLength(3);
    expect(
      frames(first)
        .at(-1)
        ?.map((room) => room.roomId)
        .sort()
    ).toEqual(["2222", "3333", "4444"]);

    // 合并只推迟可见，不丢内容：新窗口内的这次建房同样等下一个尾沿。
    await createRoom(service, "5555");
    expect(frames(first)).toHaveLength(3);
    advanceTime(LOBBY_MERGE_WINDOW_MS);
    expect(
      frames(first)
        .at(-1)
        ?.map((room) => room.roomId)
        .sort()
    ).toEqual(["2222", "3333", "4444", "5555"]);
    expect(frames(second)).toHaveLength(4);
  });

  test("房间设置只通过公开快照同步且不会暴露私房密码", async () => {
    const { service } = createTestContext();
    const host = createConnection(service, "settings-host");
    await execute(service, host, {
      id: "create-private",
      type: "room.create",
      payload: {
        roomId: "1010",
        name: "私房",
        visibility: "private",
        password: "old-password",
        allowSpectators: true,
        userName: "房主",
      },
    });
    const guest = createConnection(service, "settings-guest");
    await execute(service, guest, {
      id: "join-private",
      type: "room.join",
      roomId: "1010",
      payload: { userName: "玩家", password: "old-password" },
    });

    await execute(service, host, {
      id: "change-password",
      type: "room.updateSettings",
      payload: { password: "new-password" },
    });

    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(guest, "room.snapshot");
    expect(snapshot?.visibility).toBe("private");
    expect(snapshot?.hasPassword).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("new-password");
  });

  test("私密房口令按规范化后的值比对，摘要不落明文", async () => {
    const { service } = createTestContext();
    const host = createConnection(service, "space-host");
    await execute(service, host, {
      id: "space-create",
      type: "room.create",
      payload: {
        roomId: "1616",
        name: "私房",
        visibility: "private",
        password: "  a  b  ",
        allowSpectators: true,
        userName: "房主",
      },
    });
    // 建房时收的是带多余空白的口令，进房时给规范化后的同一个值仍应通过。
    const guest = createConnection(service, "space-guest");
    await execute(service, guest, {
      id: "space-join",
      type: "room.join",
      roomId: "1616",
      payload: { userName: "玩家", password: "a b" },
    });

    const other = createConnection(service, "space-other");
    await expect(
      execute(service, other, {
        id: "space-wrong",
        type: "room.join",
        roomId: "1616",
        payload: { userName: "玩家二", password: "ab" },
      })
    ).rejects.toMatchObject({ code: "PASSWORD_INCORRECT" });
  });

  test("密码尝试超过上限后连正确密码也拒绝，其它连接不受影响，窗口过后恢复", async () => {
    const { service, advanceTime } = createTestContext();
    const host = createConnection(service, "limit-host");
    await execute(service, host, {
      id: "limit-create",
      type: "room.create",
      payload: {
        roomId: "1414",
        name: "私房",
        visibility: "private",
        password: "secret",
        allowSpectators: true,
        userName: "房主",
      },
    });
    let attemptId = 0;
    const attempt = (
      connection: ReturnType<typeof createConnection>,
      userName: string,
      password?: string
    ) =>
      execute(service, connection, {
        id: `limit-join-${++attemptId}`,
        type: "room.join",
        roomId: "1414",
        payload: password === undefined ? { userName } : { userName, password },
      });

    const attacker = createConnection(service, "limit-attacker");
    for (let index = 0; index < JOIN_PASSWORD_MAX_ATTEMPTS; index += 1) {
      await expect(attempt(attacker, "尝试者", `猜测${index}`)).rejects.toMatchObject({
        code: "PASSWORD_INCORRECT",
      });
    }
    await expect(attempt(attacker, "尝试者", "secret")).rejects.toMatchObject({
      code: "TOO_MANY_ATTEMPTS",
    });

    // 缺少密码回 PASSWORD_REQUIRED 且不消耗配额：另一个连接先空试到上限，仍能凭正确密码进入。
    const friend = createConnection(service, "limit-friend");
    for (let index = 0; index < JOIN_PASSWORD_MAX_ATTEMPTS; index += 1) {
      await expect(attempt(friend, "朋友")).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
    }
    await attempt(friend, "朋友", "secret");

    advanceTime(JOIN_PASSWORD_WINDOW_MS + 1);
    await attempt(attacker, "尝试者", "secret");
    expect(
      getLastEventPayload<WhoIsFakerRoomSnapshot>(friend, "room.snapshot")
        ?.players.map((player) => player.name)
        .sort()
    ).toEqual(["尝试者", "房主", "朋友"].sort());
  });

  test("同一房间的密码尝试有聚合额度：多开连接换不来更多爆破次数", async () => {
    const { service, advanceTime } = createTestContext();
    const host = createConnection(service, "burst-host");
    await execute(service, host, {
      id: "burst-create",
      type: "room.create",
      payload: {
        roomId: "1515",
        name: "私房",
        visibility: "private",
        password: "secret",
        allowSpectators: true,
        userName: "房主",
      },
    });

    let attemptId = 0;
    const attempt = (
      connection: ReturnType<typeof createConnection>,
      userName: string,
      password: string
    ) =>
      execute(service, connection, {
        id: `burst-join-${++attemptId}`,
        type: "room.join",
        roomId: "1515",
        payload: { userName, password },
      });

    const sockets = Array.from(
      { length: JOIN_PASSWORD_ROOM_MAX_ATTEMPTS / JOIN_PASSWORD_MAX_ATTEMPTS + 1 },
      (_, index) => createConnection(service, `burst-socket-${index}`)
    );
    const burst = sockets.slice(0, -1);
    for (const socket of burst) {
      for (let index = 0; index < JOIN_PASSWORD_MAX_ATTEMPTS; index += 1) {
        await expect(attempt(socket, "尝试者", `猜测${index}`)).rejects.toMatchObject({
          code: "PASSWORD_INCORRECT",
        });
      }
    }

    // 最后一条连接自己一次都没试过，房间聚合额度已被前面的连接用光。
    const overflow = sockets[sockets.length - 1]!;
    await expect(attempt(overflow, "溢出者", "错误口令")).rejects.toMatchObject({
      code: "TOO_MANY_ATTEMPTS",
    });
    // 先计数再校验：正确密码同样被拒，攻击者分不清是额度用完还是口令猜中。
    await expect(attempt(overflow, "溢出者", "secret")).rejects.toMatchObject({
      code: "TOO_MANY_ATTEMPTS",
    });

    advanceTime(JOIN_PASSWORD_WINDOW_MS + 1);
    await attempt(overflow, "溢出者", "secret");
    expect(
      getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")?.players.map(
        (player) => player.name
      )
    ).toEqual(["房主", "溢出者"]);
  });

  test("玩家改名会规范化名称并广播最新快照", async () => {
    const { service } = createTestContext();
    const { host, result } = await createRoom(service, "1212");

    const response = await execute(service, host, {
      id: "rename",
      type: "player.rename",
      payload: { name: "  新房主  " },
    });

    expect(response).toEqual({ name: "新房主" });
    expect(
      getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")?.players.find(
        (player) => player.id === result.playerId
      )?.name
    ).toBe("新房主");
  });

  test("玩家改名会拒绝空名称和房间内重名", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "1313");
    const guest = createConnection(service, "rename-guest");
    await execute(service, guest, {
      id: "join",
      type: "room.join",
      roomId: "1313",
      payload: { userName: "现有玩家" },
    });

    for (const [name, expectedCode] of [
      ["   ", "INVALID_NAME"],
      ["  现有玩家  ", "NAME_CONFLICT"],
    ] as const) {
      let errorCode: string | undefined;
      try {
        await execute(service, host, {
          id: `rename-${expectedCode}`,
          type: "player.rename",
          payload: { name },
        });
      } catch (error) {
        errorCode = (error as { code?: string }).code;
      }
      expect(errorCode).toBe(expectedCode);
    }

    expect(
      getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")?.players.find(
        (player) => player.id === host.record.playerId
      )?.name
    ).toBe("房主");
  });

  test("切换为旁观者会清除准备状态并收紧角色配置", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "1414");
    const joined: JoinedPlayer[] = [];

    for (let index = 0; index < 7; index += 1) {
      const connection = createConnection(service, `role-limit-${index}`);
      const joinResult = (await execute(service, connection, {
        id: `join-${index}`,
        type: "room.join",
        roomId: "1414",
        payload: { userName: `角色玩家${index + 2}` },
      })) as { playerId: string };
      joined.push({ connection, joinResult });
    }

    await execute(service, host, {
      id: "enable-blank",
      type: "room.updateSettings",
      payload: {
        roleConfig: { undercoverCount: 2, hasAngel: false, hasBlank: true },
      },
    });
    await execute(service, joined[6].connection, {
      id: "ready-before-spectating",
      type: "player.setReady",
      payload: { ready: true },
    });
    await execute(service, joined[6].connection, {
      id: "become-spectator",
      type: "player.setSpectator",
      payload: { spectator: true },
    });

    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    const player = snapshot?.players.find((entry) => entry.id === joined[6].joinResult.playerId);
    expect(player?.membership).toBe("spectator");
    expect(player?.isReady).toBe(false);
    expect(snapshot?.roleLimits.canEnableBlank).toBe(false);
    expect(snapshot?.settings.roleConfig.hasBlank).toBe(false);
  });

  test("房主没有准备态：其他玩家都准备好即可开局，快照里房主恒为已准备", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "1616");
    const guests = [];
    for (let index = 0; index < 4; index += 1) {
      const connection = createConnection(service, `host-ready-${index}`);
      await execute(service, connection, {
        id: `join-${index}`,
        type: "room.join",
        roomId: "1616",
        payload: { userName: `免准备玩家${index + 2}` },
      });
      guests.push(connection);
    }
    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.players.find((entry) => entry.isHost)?.isReady).toBe(true);
    for (const connection of guests) {
      await execute(service, connection, {
        id: `ready-${connection.record.id}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    }
    const result = await execute(service, host, {
      id: "start",
      type: "game.advancePhase",
      payload: {},
    });
    expect(result).toMatchObject({ phase: expect.not.stringMatching(/^waiting$/) });
  });

  test("对局开始后不能切换旁观或准备状态", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "1515");
    const players = [host];

    for (let index = 0; index < 4; index += 1) {
      const connection = createConnection(service, `active-round-${index}`);
      await execute(service, connection, {
        id: `join-${index}`,
        type: "room.join",
        roomId: "1515",
        payload: { userName: `开局玩家${index + 2}` },
      });
      players.push(connection);
    }
    for (const connection of players) {
      await execute(service, connection, {
        id: `ready-${connection.record.id}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    }
    await execute(service, host, {
      id: "start",
      type: "game.advancePhase",
      payload: {},
    });

    for (const message of [
      {
        id: "spectate-during-round",
        type: "player.setSpectator",
        payload: { spectator: true },
      },
      {
        id: "ready-during-round",
        type: "player.setReady",
        payload: { ready: false },
      },
    ] as const) {
      let errorCode: string | undefined;
      try {
        await execute(service, host, message);
      } catch (error) {
        errorCode = (error as { code?: string }).code;
      }
      expect(errorCode).toBe("ROUND_ACTIVE");
    }
  });

  test("无口令的公开房改成私密被拒后，设置原样不变且仍可无口令加入", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "2121");

    await expect(
      execute(service, host, {
        id: "to-private-without-password",
        type: "room.updateSettings",
        payload: { name: "新房名", visibility: "private" },
      })
    ).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });

    const room = service.rooms.get("2121")!;
    expect(room.settings.visibility).toBe("public");
    expect(room.settings.name).toBe("2121-房间");
    expect(room.passwordHash).toBeUndefined();

    const guest = createConnection(service, "2121-guest");
    await execute(service, guest, {
      id: "join-after-reject",
      type: "room.join",
      roomId: "2121",
      payload: { userName: "访客" },
    });
  });

  test("同一请求里关闭旁观被旁观者挡住时，同请求的其它字段不会写入", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "2122");
    const spectator = createConnection(service, "2122-spec");
    await execute(service, spectator, {
      id: "join-spec",
      type: "room.join",
      roomId: "2122",
      payload: { userName: "旁观者" },
    });
    await execute(service, spectator, {
      id: "set-spec",
      type: "player.setSpectator",
      payload: { spectator: true },
    });

    await expect(
      execute(service, host, {
        id: "rename-and-close-spectate",
        type: "room.updateSettings",
        payload: { name: "改名", allowSpectators: false },
      })
    ).rejects.toMatchObject({ code: "SPECTATOR_EXISTS" });

    const settings = service.rooms.get("2122")!.settings;
    expect(settings.name).toBe("2122-房间");
    expect(settings.allowSpectators).toBe(true);
  });

  test("慢哈希期间房主已开局时，改设置在回来后被拒且设置不被改写", async () => {
    // 可控哈希器把 await 窗口卡住，确定性地在窗口内插入开局命令。
    let releaseHash: () => void = () => {};
    const hashGate = new Promise<void>((resolve) => {
      releaseHash = resolve;
    });
    const service = new WhoIsFakerService({
      eventLogger: new EventLogger(),
      passwordHasher: {
        hash: async (password) => {
          await hashGate;
          return `digest:${password}`;
        },
        verify: async (password, digest) => digest === `digest:${password}`,
      },
    });
    const { host } = await createRoom(service, "2123");
    const others = await joinPlayers(service, "2123", 4, "玩家");
    for (const other of others) {
      await execute(service, other.connection, {
        id: `ready-${other.joinResult.playerId}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    }

    const pending = execute(service, host, {
      id: "slow-update",
      type: "room.updateSettings",
      payload: { visibility: "private", password: "secret", name: "不该生效" },
    }).then(
      () => undefined,
      (error: unknown) => error as { code?: string }
    );

    await execute(service, host, { id: "start-round", type: "game.advancePhase", payload: {} });
    releaseHash();

    expect(await pending).toMatchObject({ code: "ROUND_ACTIVE" });
    const room = service.rooms.get("2123")!;
    expect(room.settings.visibility).toBe("public");
    expect(room.settings.name).toBe("2123-房间");
    expect(room.passwordHash).toBeUndefined();
  });

  test("私密房建房在慢哈希期间连接已断开时，房间被撤销而不留幽灵座位", async () => {
    let releaseHash: () => void = () => {};
    const hashGate = new Promise<void>((resolve) => {
      releaseHash = resolve;
    });
    const service = new WhoIsFakerService({
      eventLogger: new EventLogger(),
      passwordHasher: {
        hash: async (password) => {
          await hashGate;
          return `digest:${password}`;
        },
        verify: async (password, digest) => {
          await hashGate;
          return digest === `digest:${password}`;
        },
      },
    });

    // 建房：哈希期间连接断开，房间必须被撤销。
    const creator = createConnection(service, "2131-host");
    const creating = execute(service, creator, {
      id: "create-private",
      type: "room.create",
      payload: {
        roomId: "2131",
        name: "私房",
        visibility: "private",
        password: "secret",
        allowSpectators: true,
        userName: "房主",
      },
    }).then(
      () => undefined,
      (error: unknown) => error as { code?: string }
    );
    await service.unregisterConnection(creator.record.id);
    releaseHash();
    expect(await creating).toMatchObject({ code: "CONNECTION_CLOSED" });
    expect(service.rooms.has("2131")).toBe(false);
  });

  test("建私密房算摘要期间：无口令加入进不去，同号再建被拒，大厅与后台看不到半成品", async () => {
    let releaseHash: () => void = () => {};
    const hashGate = new Promise<void>((resolve) => {
      releaseHash = resolve;
    });
    const service = new WhoIsFakerService({
      eventLogger: new EventLogger(),
      passwordHasher: {
        hash: async (password) => {
          await hashGate;
          return `digest:${password}`;
        },
        verify: async (password, digest) => digest === `digest:${password}`,
      },
    });
    const payload = {
      roomId: "2133",
      name: "私房",
      visibility: "private" as const,
      password: "secret",
      allowSpectators: true,
      userName: "房主",
    };
    const creator = createConnection(service, "2133-host");
    const creating = execute(service, creator, {
      id: "create-private",
      type: "room.create",
      payload,
    });

    // 摘要还没算完：房间表里没有这间房，不会出现「私密却没有口令」的窗口。
    expect(service.rooms.has("2133")).toBe(false);
    expect(service.getRoomSummaries()).toHaveLength(0);
    expect(service.adminListRooms()).toHaveLength(0);

    const intruder = createConnection(service, "2133-intruder");
    await expect(
      execute(service, intruder, {
        id: "join-no-password",
        type: "room.join",
        roomId: "2133",
        payload: { userName: "闯入者" },
      })
    ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });

    const rival = createConnection(service, "2133-rival");
    await expect(
      execute(service, rival, { id: "create-again", type: "room.create", payload })
    ).rejects.toMatchObject({ code: "ROOM_ALREADY_EXISTS" });

    releaseHash();
    await creating;
    const room = service.rooms.get("2133")!;
    expect(room.passwordHash).toBe("digest:secret");
    expect(Object.keys(room.players)).toHaveLength(1);

    // 建好之后仍然要口令。
    await expect(
      execute(service, intruder, {
        id: "join-no-password-2",
        type: "room.join",
        roomId: "2133",
        payload: { userName: "闯入者" },
      })
    ).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
  });

  test("入私密房比对口令期间连接断开，座位不会被标成在线", async () => {
    let gate: Promise<void> = Promise.resolve();
    let releaseVerify: () => void = () => {};
    const service = new WhoIsFakerService({
      eventLogger: new EventLogger(),
      passwordHasher: {
        hash: async (password) => `digest:${password}`,
        verify: async (password, digest) => {
          await gate;
          return digest === `digest:${password}`;
        },
      },
    });
    const host = createConnection(service, "2132-host");
    await execute(service, host, {
      id: "create-private",
      type: "room.create",
      payload: {
        roomId: "2132",
        name: "私房",
        visibility: "private",
        password: "secret",
        allowSpectators: true,
        userName: "房主",
      },
    });

    gate = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    const guest = createConnection(service, "2132-guest");
    const joining = execute(service, guest, {
      id: "join-private",
      type: "room.join",
      roomId: "2132",
      payload: { userName: "访客", password: "secret" },
    }).then(
      () => undefined,
      (error: unknown) => error as { code?: string }
    );
    await service.unregisterConnection(guest.record.id);
    releaseVerify();

    expect(await joining).toMatchObject({ code: "CONNECTION_CLOSED" });
    const players = Object.values(service.rooms.get("2132")!.players);
    expect(players).toHaveLength(1);
  });
});
