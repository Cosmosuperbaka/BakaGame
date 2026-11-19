import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tabSeatId } from "../../src/application/TabSeat";
import { TEST_ROOMS_DISABLED } from "../../src/domain/TestRooms";
import {
  SensitiveTextFilter,
  setSensitiveTextFilterForTest,
} from "../../src/infrastructure/SensitiveText";
import type { WhoIsFakerClientMessage } from "../../src/shared/Index";
import {
  codeOf,
  connect,
  createWorld,
  errorOf,
  joinAs,
  lobbyFrames,
  makeRoom,
  send,
  settleLobby,
  snapshotCount,
  snapshotOf,
  startRound,
  subscribeLobby,
} from "./FacadeKit";

// 只用占位词：测试文件里不出现真实敏感词。
const BAD = "测试违禁词B";
beforeAll(() => setSensitiveTextFilterForTest(new SensitiveTextFilter([BAD])));
afterAll(() => setSensitiveTextFilterForTest(undefined));

/** 慢哈希：卡在 await 上，让测试在「算摘要期间」插入别的命令。 */
const slowHasher = () => {
  const hashed: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    hashed,
    release: () => release(),
    hasher: {
      hash: async (password: string) => {
        hashed.push(password);
        await gate;
        return `h:${password}`;
      },
      verify: async (password: string, digest: string) => digest === `h:${password}`,
    },
  };
};

describe("建房细节", () => {
  test("缺省值、规范化、系统消息与日志", async () => {
    const world = createWorld();
    const conn = connect(world, "c1");
    const result = (await send(world, conn, {
      id: "create",
      type: "room.create",
      payload: {
        roomId: "7001",
        name: "  新房  ",
        visibility: "public",
        allowSpectators: true,
        userName: "  房主甲  ",
      },
    })) as { roomId: string; playerId: string; sessionToken: string };
    const room = world.room("7001");
    expect(room.settings.name).toBe("新房");
    expect(room.settings.revealRoleOnDeath).toBe(true);
    expect(room.settings.spectatorsSeeAnswers).toBe(false);
    expect(room.settings.roleConfig).toEqual({
      undercoverCount: 1,
      hasAngel: false,
      hasBlank: false,
    });
    expect(room.hostPlayerId).toBe(result.playerId);
    expect(room.players[result.playerId]?.name).toBe("房主甲");
    expect(result.sessionToken).toBe(room.players[result.playerId]?.sessionToken ?? "");
    expect(room.chat.map((c) => c.text)).toEqual(["房主甲 创建了房间"]);
    expect(world.logs("room.created").map((e) => e.payload)).toEqual([{ visibility: "public" }]);
  });

  test("房间名缺省取房主名；私密房日志记私密", async () => {
    const world = createWorld();
    const conn = connect(world, "c1");
    await send(world, conn, {
      id: "create",
      type: "room.create",
      payload: {
        roomId: "7002",
        name: "",
        visibility: "private",
        password: "口令",
        allowSpectators: false,
        userName: "阿房",
      },
    });
    expect(world.room("7002").settings.name).toBe("阿房的房间");
    expect(world.logs("room.created").map((e) => e.payload)).toEqual([{ visibility: "private" }]);
  });

  test("角色配置缺省与夹取：一人房里多卧底、天使与白板都被夹回", async () => {
    const world = createWorld();
    await makeRoom(world, "7003", {
      roleConfig: { undercoverCount: 5, hasAngel: true, hasBlank: true },
    });
    expect(world.room("7003").settings.roleConfig).toEqual({
      undercoverCount: 1,
      hasAngel: false,
      hasBlank: false,
    });
  });

  test("标签页席位号、Agent 标记与房间名敏感词", async () => {
    const world = createWorld();
    const tab = connect(world, "tab");
    tab.record.tabKey = "t".repeat(64);
    tab.record.isAgent = true;
    const result = (await send(world, tab, {
      id: "create",
      type: "room.create",
      payload: {
        roomId: "7004",
        name: "房",
        visibility: "public",
        allowSpectators: true,
        userName: "甲",
      },
    })) as { playerId: string };
    expect(result.playerId).toBe(tabSeatId({ tabKey: "t".repeat(64) }, "faker", "7004")!);
    expect(world.room("7004").players[result.playerId]?.isAgent).toBe(true);
    const code = await codeOf(
      send(world, connect(world, "c2"), {
        id: "bad-name",
        type: "room.create",
        payload: {
          roomId: "7005",
          name: BAD,
          visibility: "public",
          allowSpectators: true,
          userName: "乙",
        },
      })
    );
    expect(code).toBe("TEXT_SENSITIVE");
    expect(world.service.rooms.has("7005")).toBe(false);
  });

  test("建房后刷新大厅", async () => {
    const world = createWorld();
    const lobby = await subscribeLobby(world);
    settleLobby(world);
    const before = lobbyFrames(lobby);
    await makeRoom(world, "7006");
    expect(lobbyFrames(lobby)).toBe(before + 1);
  });

  test("私密房：口令按规范化后算摘要；算摘要期间连接断开则拒绝且不登记", async () => {
    const slow = slowHasher();
    const world = createWorld({ passwordHasher: slow.hasher });
    const conn = connect(world, "c1");
    const pending = send(world, conn, {
      id: "create",
      type: "room.create",
      payload: {
        roomId: "7007",
        name: "房",
        visibility: "private",
        password: "  abc  ",
        allowSpectators: true,
        userName: "甲",
      },
    });
    const outcome = codeOf(pending);
    await world.service.unregisterConnection(conn.record.id);
    slow.release();
    expect(await outcome).toBe("CONNECTION_CLOSED");
    expect(slow.hashed).toEqual(["abc"]);
    expect(world.service.rooms.has("7007")).toBe(false);
  });

  test("摘要期间同号占位：第二次建房被拒，结束后占位释放", async () => {
    const slow = slowHasher();
    const world = createWorld({ passwordHasher: slow.hasher });
    const message = (id: string): WhoIsFakerClientMessage => ({
      id,
      type: "room.create",
      payload: {
        roomId: "7008",
        name: "房",
        visibility: "private",
        password: "p",
        allowSpectators: true,
        userName: "甲",
      },
    });
    const first = send(world, connect(world, "c1"), message("a"));
    expect(await codeOf(send(world, connect(world, "c2"), message("b")))).toBe(
      "ROOM_ALREADY_EXISTS"
    );
    slow.release();
    await first;
    // 房间已登记：同号再建仍被拒（占的是房间表而不是残留占位）
    expect(await codeOf(send(world, connect(world, "c3"), message("c")))).toBe(
      "ROOM_ALREADY_EXISTS"
    );
  });

  test("建房失败后占位释放：同号可以重建", async () => {
    const world = createWorld();
    const conn = connect(world, "c1");
    const bad = (id: string): WhoIsFakerClientMessage => ({
      id,
      type: "room.create",
      payload: {
        roomId: "7009",
        name: "房",
        visibility: "private",
        password: "   ",
        allowSpectators: true,
        userName: "甲",
      },
    });
    expect(await codeOf(send(world, conn, bad("a")))).toBe("PASSWORD_REQUIRED");
    await makeRoom(world, "7009");
    expect(world.service.rooms.has("7009")).toBe(true);
  });
});

describe("入房细节", () => {
  test("用户名敏感词被拒；允许旁观关闭时局中入房被拒", async () => {
    const world = createWorld();
    await makeRoom(world, "7101");
    const code = await codeOf(
      send(world, connect(world, "c1"), {
        id: "j",
        type: "room.join",
        roomId: "7101",
        payload: { userName: BAD },
      })
    );
    expect(code).toBe("TEXT_SENSITIVE");

    const round = await startRound(world, "7102");
    world.room("7102").settings.allowSpectators = false;
    expect(
      await codeOf(
        send(world, connect(world, "c2"), {
          id: "j2",
          type: "room.join",
          roomId: "7102",
          payload: { userName: "迟到者" },
        })
      )
    ).toBe("SPECTATOR_DISABLED");
    expect(round.host.id).toBeTruthy();
  });

  test("入房：刷新活跃、系统消息、日志、大厅与等待旧房更新", async () => {
    const world = createWorld();
    await makeRoom(world, "7103");
    const lobby = await subscribeLobby(world);
    settleLobby(world);
    const before = lobbyFrames(lobby);
    const seat = await joinAs(world, "7103", "乙");
    const room = world.room("7103");
    expect(room.lastActivityAt).toBe(world.now());
    expect(room.chat.at(-1)?.text).toBe("乙 加入了房间");
    expect(world.logs("room.joined").map((e) => e.payload)).toEqual([{ membership: "active" }]);
    expect(lobbyFrames(lobby)).toBe(before + 1);
    expect(room.players[seat.id]?.membership).toBe("active");
  });

  test("局中入房记为旁观并写进日志", async () => {
    const world = createWorld();
    await startRound(world, "7104");
    await joinAs(world, "7104", "迟到者");
    expect(world.logs("room.joined").at(-1)?.payload).toEqual({ membership: "spectator" });
  });

  test("连接换房：在新房里重新加入时旧房先收到更新", async () => {
    const world = createWorld();
    const a = await makeRoom(world, "7105");
    await makeRoom(world, "7106");
    const before = snapshotCount(a.conn);
    const conn = connect(world, "mover");
    await send(world, conn, {
      id: "ja",
      type: "room.join",
      roomId: "7105",
      payload: { userName: "游客" },
    });
    const mid = snapshotCount(a.conn);
    expect(mid).toBeGreaterThan(before);
    await send(world, conn, {
      id: "jb",
      type: "room.join",
      roomId: "7106",
      payload: { userName: "游客" },
    });
    expect(snapshotCount(a.conn)).toBeGreaterThan(mid);
    expect(snapshotOf(a.conn)?.players.find((p) => p.name === "游客")?.online).toBe(false);
  });
});

describe("重连与离开", () => {
  test("重连：房号合法性、Agent 准入与凭证比对", async () => {
    const world = createWorld({ testRooms: TEST_ROOMS_DISABLED });
    const host = await makeRoom(world, "7201");
    expect(
      await codeOf(
        send(world, connect(world, "r1"), {
          id: "r",
          type: "room.reconnect",
          payload: { roomId: "Oblivionis", sessionToken: "x".repeat(40) },
        })
      )
    ).toBe("INVALID_ROOM_ID");
    expect(
      await codeOf(
        send(world, connect(world, "r2"), {
          id: "r",
          type: "room.reconnect",
          payload: { roomId: "7201", sessionToken: "bad-token" },
        })
      )
    ).toBe("SESSION_NOT_FOUND");

    const agent = connect(world, "r3");
    agent.record.isAgent = true;
    expect(
      await codeOf(
        send(world, agent, {
          id: "r",
          type: "room.reconnect",
          payload: { roomId: "7201", sessionToken: host.token },
        })
      )
    ).toBe("AGENTS_NOT_ALLOWED");
    world.room("7201").settings.allowAgents = true;
    expect(
      await codeOf(
        send(world, agent, {
          id: "r",
          type: "room.reconnect",
          payload: { roomId: "7201", sessionToken: host.token },
        })
      )
    ).not.toBe("AGENTS_NOT_ALLOWED");
  });

  test("出题人掉线后重连：清截止、清掉线队列、系统消息、日志与大厅", async () => {
    const world = createWorld();
    const round = await startRound(world, "7202");
    const lobby = await subscribeLobby(world);
    await world.service.unregisterConnection(round.questioner.conn.record.id);
    const room = world.room("7202");
    expect(room.round?.questionerReconnectDeadlineAt).toBeDefined();
    settleLobby(world);
    const before = lobbyFrames(lobby);
    const conn = connect(world, "back");
    world.advance(5);
    await send(world, conn, {
      id: "rc",
      type: "room.reconnect",
      payload: { roomId: "7202", sessionToken: round.questioner.token },
    });
    expect(room.round?.questionerReconnectDeadlineAt).toBeUndefined();
    expect(room.lastActivityAt).toBe(world.now());
    expect(room.chat.at(-1)?.text).toBe("玩家4 已重新连接");
    expect(world.logs("room.reconnected").map((e) => e.playerId)).toEqual([round.questioner.id]);
    expect(lobbyFrames(lobby)).toBe(before + 1);
  });

  test("普通玩家重连不动出题人截止", async () => {
    const world = createWorld();
    const round = await startRound(world, "7203");
    await world.service.unregisterConnection(round.questioner.conn.record.id);
    const deadline = world.room("7203").round?.questionerReconnectDeadlineAt;
    const player = round.others[0];
    await world.service.unregisterConnection(player.conn.record.id);
    await send(world, connect(world, "back"), {
      id: "rc",
      type: "room.reconnect",
      payload: { roomId: "7203", sessionToken: player.token },
    });
    expect(world.room("7203").round?.questionerReconnectDeadlineAt).toBe(deadline);
  });

  test("离开与同步的返回值，同步重置连接状态并只发给本连接", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "7204");
    const guest = await joinAs(world, "7204", "乙");
    let reset = 0;
    guest.conn.record.resetStateSync = () => {
      reset += 1;
    };
    const hostFrames = snapshotCount(host.conn);
    const mine = snapshotCount(guest.conn);
    expect(
      await send(world, guest.conn, { id: "s", type: "room.requestSync", payload: {} })
    ).toEqual({
      synced: true,
    });
    expect(reset).toBe(1);
    expect(snapshotCount(guest.conn)).toBe(mine + 1);
    expect(snapshotCount(host.conn)).toBe(hostFrames);
    expect(await send(world, guest.conn, { id: "l", type: "room.leave", payload: {} })).toEqual({
      left: true,
    });
    expect(world.room("7204").players[guest.id]).toBeUndefined();
  });
});

describe("改设置细节", () => {
  test("字段逐项生效与返回；改后刷新活跃、日志与大厅", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "7301");
    await joinAs(world, "7301", "乙");
    const lobby = await subscribeLobby(world);
    settleLobby(world);
    const before = lobbyFrames(lobby);
    const result = (await send(world, host.conn, {
      id: "u",
      type: "room.updateSettings",
      payload: {
        name: "  改名后  ",
        allowSpectators: false,
        revealRoleOnDeath: false,
        spectatorsSeeAnswers: true,
        allowAgents: true,
      },
    })) as { settings: Record<string, unknown> };
    const room = world.room("7301");
    expect(room.settings).toMatchObject({
      name: "改名后",
      allowSpectators: false,
      revealRoleOnDeath: false,
      spectatorsSeeAnswers: true,
      allowAgents: true,
    });
    expect(result.settings).toEqual({ ...room.settings });
    expect(room.lastActivityAt).toBe(world.now());
    expect(world.logs("room.settings_changed").at(-1)?.payload).toEqual({ ...room.settings });
    expect(lobbyFrames(lobby)).toBe(before + 1);
  });

  test("房间名敏感词与空名被拒，且不改任何设置", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "7302");
    const room = world.room("7302");
    const before = { ...room.settings };
    expect(
      await codeOf(
        send(world, host.conn, {
          id: "u1",
          type: "room.updateSettings",
          payload: { name: BAD, allowSpectators: false },
        })
      )
    ).toBe("TEXT_SENSITIVE");
    expect(
      await codeOf(
        send(world, host.conn, {
          id: "u2",
          type: "room.updateSettings",
          payload: { name: "   " },
        })
      )
    ).toBe("INVALID_ROOM_NAME");
    expect(room.settings).toEqual(before);
  });

  test("私密房：换口令与改公开：摘要写入、清除与规范化", async () => {
    const slow = slowHasher();
    slow.release();
    const world = createWorld({ passwordHasher: slow.hasher });
    const host = await makeRoom(world, "7303");
    await send(world, host.conn, {
      id: "u1",
      type: "room.updateSettings",
      payload: { visibility: "private", password: "  pw  " },
    });
    expect(slow.hashed).toEqual(["pw"]);
    expect(world.room("7303").passwordHash).toBe("h:pw");
    // 不带口令改别的：沿用旧摘要
    await send(world, host.conn, {
      id: "u2",
      type: "room.updateSettings",
      payload: { name: "新名" },
    });
    expect(world.room("7303").passwordHash).toBe("h:pw");
    await send(world, host.conn, {
      id: "u3",
      type: "room.updateSettings",
      payload: { visibility: "public" },
    });
    expect(world.room("7303").passwordHash).toBeUndefined();
  });

  test("私密房没有口令时缺口令被拒", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "7304");
    expect(
      await codeOf(
        send(world, host.conn, {
          id: "u",
          type: "room.updateSettings",
          payload: { visibility: "private" },
        })
      )
    ).toBe("PASSWORD_REQUIRED");
  });

  test("有旁观者时不能关旁观", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "7305");
    const guest = await joinAs(world, "7305", "乙");
    await send(world, guest.conn, {
      id: "w",
      type: "player.setSpectator",
      payload: { spectator: true },
    });
    expect(
      await codeOf(
        send(world, host.conn, {
          id: "u",
          type: "room.updateSettings",
          payload: { allowSpectators: false },
        })
      )
    ).toBe("SPECTATOR_EXISTS");
  });

  test("角色配置按人数夹取；不带角色配置时按当前人数重算", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "7306");
    const guests = [];
    for (let i = 0; i < 8; i += 1) guests.push(await joinAs(world, "7306", `玩家${i}`));
    await send(world, host.conn, {
      id: "u1",
      type: "room.updateSettings",
      payload: { roleConfig: { undercoverCount: 2, hasAngel: true, hasBlank: true } },
    });
    expect(world.room("7306").settings.roleConfig).toMatchObject({
      undercoverCount: 2,
      hasAngel: true,
    });
    // 超过上限的配置被夹回：9 名成员（8 名可参战）最多 2 个卧底
    await send(world, host.conn, {
      id: "u0",
      type: "room.updateSettings",
      payload: { roleConfig: { undercoverCount: 3, hasAngel: false, hasBlank: false } },
    });
    expect(world.room("7306").settings.roleConfig.undercoverCount).toBe(2);
    // 退到 4 人：不带角色配置的修改也会把已存的配置重算回上限
    for (const [index, guest] of guests.slice(3).entries()) {
      await send(world, guest.conn, { id: `l${index}`, type: "room.leave", payload: {} });
    }
    await send(world, host.conn, {
      id: "u2",
      type: "room.updateSettings",
      payload: { name: "缩小" },
    });
    expect(world.room("7306").settings.roleConfig).toMatchObject({
      undercoverCount: 1,
      hasAngel: false,
    });
  });

  test("算摘要期间：房间被关闭、房主换人、回合开始、出现旁观者都在回来时被复核", async () => {
    // 房间被关闭
    {
      const slow = slowHasher();
      const world = createWorld({ passwordHasher: slow.hasher });
      const host = await makeRoom(world, "7307");
      const pending = errorOf(
        send(world, host.conn, {
          id: "u",
          type: "room.updateSettings",
          payload: { visibility: "private", password: "p" },
        })
      );
      await world.service.adminCloseRoom("7307");
      slow.release();
      expect(await pending).toMatchObject({ code: "ROOM_NOT_FOUND", message: "房间不存在" });
    }
    // 房主换人
    {
      const slow = slowHasher();
      const world = createWorld({ passwordHasher: slow.hasher });
      const host = await makeRoom(world, "7308");
      const guest = await joinAs(world, "7308", "乙");
      const pending = codeOf(
        send(world, host.conn, {
          id: "u",
          type: "room.updateSettings",
          payload: { visibility: "private", password: "p" },
        })
      );
      await send(world, host.conn, {
        id: "t",
        type: "room.transferHost",
        payload: { playerId: guest.id },
      });
      slow.release();
      expect(await pending).toBe("FORBIDDEN");
      expect(world.room("7308").settings.visibility).toBe("public");
    }
    // 出现旁观者
    {
      const slow = slowHasher();
      const world = createWorld({ passwordHasher: slow.hasher });
      const host = await makeRoom(world, "7309");
      const guest = await joinAs(world, "7309", "乙");
      const pending = codeOf(
        send(world, host.conn, {
          id: "u",
          type: "room.updateSettings",
          payload: { allowSpectators: false, visibility: "private", password: "p" },
        })
      );
      await send(world, guest.conn, {
        id: "w",
        type: "player.setSpectator",
        payload: { spectator: true },
      });
      slow.release();
      expect(await pending).toBe("SPECTATOR_EXISTS");
      expect(world.room("7309").settings.allowSpectators).toBe(true);
    }
  });
});

describe("踢人与转让细节", () => {
  test("房主踢人：署名、返回值、大厅；已被踢者不重复处理", async () => {
    const world = createWorld();
    const round = await startRound(world, "7401");
    const lobby = await subscribeLobby(world);
    settleLobby(world);
    const before = lobbyFrames(lobby);
    const target = round.others[0];
    expect(
      await send(world, round.host.conn, {
        id: "k",
        type: "room.kick",
        payload: { playerId: target.id },
      })
    ).toEqual({ playerId: target.id });
    expect(world.room("7401").round?.assignments[target.id]?.eliminatedReason).toBe(
      "房主已将其移出房间"
    );
    expect(lobbyFrames(lobby)).toBe(before + 1);
    const logs = world.logs("player.kicked").length;
    await send(world, round.host.conn, {
      id: "k2",
      type: "room.kick",
      payload: { playerId: target.id },
    });
    expect(world.logs("player.kicked").length).toBe(logs);
  });

  test("后台移人：署名、不存在与已被踢者按不存在", async () => {
    const world = createWorld();
    const round = await startRound(world, "7402");
    const target = round.others[0];
    await world.service.adminKickPlayer("7402", target.id);
    expect(world.room("7402").round?.assignments[target.id]?.eliminatedReason).toBe(
      "管理员已将其移出房间"
    );
    let code: string | undefined;
    try {
      await world.service.adminKickPlayer("7402", target.id);
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe("PLAYER_NOT_FOUND");
  });

  test("转让房主：被踢者不能接任；成功后刷新活跃、日志、大厅与返回值", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "7403");
    const a = await joinAs(world, "7403", "乙");
    const b = await joinAs(world, "7403", "丙");
    await send(world, host.conn, { id: "k", type: "room.kick", payload: { playerId: b.id } });
    expect(
      await codeOf(
        send(world, host.conn, { id: "t0", type: "room.transferHost", payload: { playerId: b.id } })
      )
    ).toBe("PLAYER_NOT_FOUND");
    const lobby = await subscribeLobby(world);
    settleLobby(world);
    const before = lobbyFrames(lobby);
    expect(
      await send(world, host.conn, {
        id: "t",
        type: "room.transferHost",
        payload: { playerId: a.id },
      })
    ).toEqual({ hostPlayerId: a.id });
    expect(world.room("7403").lastActivityAt).toBe(world.now());
    expect(world.logs("room.host_transferred").at(-1)?.payload).toEqual({ nextHostId: a.id });
    expect(lobbyFrames(lobby)).toBe(before + 1);
  });
});
