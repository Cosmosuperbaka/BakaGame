import { describe, expect, test } from "bun:test";
import { createRoom, joinPlayers } from "./Fixtures";
import { ROOM_EMPTY_GRACE_PERIOD_MS } from "../../src/config/Constants";
import { type WhoIsFakerPrivateState, type WhoIsFakerRoomSnapshot } from "../../src/shared/Index";
import { type WhoIsFakerRole } from "../../src/shared/WhoIsFaker";
import { createConnection, createTestContext, execute, getLastEventPayload } from ".././Helpers";

describe("隐私开关与 Agent 接管", () => {
  test("revealRoleOnDeath 开关控制死亡玩家身份是否在对局中公开", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "Oblivionis");

    // 默认开启 revealRoleOnDeath
    let snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.settings.revealRoleOnDeath).toBe(true);

    // 修改设置为关闭
    await execute(service, host, {
      id: "update-settings",
      type: "room.updateSettings",
      payload: { revealRoleOnDeath: false },
    });

    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.settings.revealRoleOnDeath).toBe(false);

    const [p1] = await joinPlayers(service, "Oblivionis", 1, "普通玩家");

    await execute(service, host, {
      id: "add-bots",
      type: "test.addBot",
      payload: { count: 3 },
    });

    await execute(service, host, {
      id: "jump-words",
      type: "test.jumpToPhase",
      payload: { phase: "wordSubmission" },
    });

    await execute(service, host, {
      id: "submit-words",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });

    // 淘汰一名玩家（如 bot_1）
    const room = (
      service as unknown as {
        rooms: Map<
          string,
          { round: { assignments: Record<string, { alive: boolean; role: WhoIsFakerRole }> } }
        >;
      }
    ).rooms.get("Oblivionis")!;
    const victimId = Object.keys(room.round.assignments).find(
      (id) => id !== p1.joinResult.playerId && id !== host.record.playerId!
    )!;
    room.round.assignments[victimId].alive = false;

    // 触发状态下发
    await execute(service, host, {
      id: "touch-chat",
      type: "chat.send",
      payload: { text: "测试" },
    });

    // 普通玩家收到的公共快照中，死者身份应当为 undefined（隐藏）
    const p1Snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(p1.connection, "room.snapshot");
    const victimView = p1Snapshot?.players.find((p) => p.id === victimId);
    expect(victimView?.roundStatus).toBe("dead");
    expect(victimView?.revealedRole).toBeUndefined();

    // 游戏结束时（gameOver），应当统一公开
    await execute(service, host, {
      id: "jump-game-over",
      type: "test.jumpToPhase",
      payload: { phase: "gameOver" },
    });

    const gameOverSnapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(
      p1.connection,
      "room.snapshot"
    );
    const finalVictimView = gameOverSnapshot?.players.find((p) => p.id === victimId);
    expect(finalVictimView?.revealedRole).toBe(room.round.assignments[victimId].role);
  });

  test("阶段精简播报、观战频道流转时机与发言顺序序号验证", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "3333");

    const p1Connection = createConnection(service, "p1");
    await execute(service, p1Connection, {
      id: "join-p1",
      type: "room.join",
      roomId: "3333",
      payload: { userName: "玩家1" },
    });

    const p2Connection = createConnection(service, "p2");
    await execute(service, p2Connection, {
      id: "join-p2",
      type: "room.join",
      roomId: "3333",
      payload: { userName: "玩家2" },
    });

    const p3Connection = createConnection(service, "p3");
    const p3 = (await execute(service, p3Connection, {
      id: "join-p3",
      type: "room.join",
      roomId: "3333",
      payload: { userName: "玩家3" },
    })) as { playerId: string };

    const specConnection = createConnection(service, "spec");
    await execute(service, specConnection, {
      id: "join-spec",
      type: "room.join",
      roomId: "3333",
      payload: { userName: "旁观者" },
    });
    await execute(service, specConnection, {
      id: "set-spec",
      type: "player.setSpectator",
      payload: { spectator: true },
    });

    for (const conn of [host, p1Connection, p2Connection, p3Connection]) {
      await execute(service, conn, {
        id: `ready-${conn.record.id}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    }

    // 1. 开局 -> 第 1 轮游戏已开始
    await execute(service, host, {
      id: "start",
      type: "game.advancePhase",
      payload: {},
    });
    let snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")!;
    expect(snapshot.chat.at(-1)?.text).toBe("第 1 轮游戏已开始");

    // 选人和出题阶段：旁观者发言应在 main 频道
    await execute(service, specConnection, {
      id: "spec-chat-1",
      type: "chat.send",
      payload: { text: "选人阶段发言" },
    });
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")!;
    expect(snapshot.chat.at(-1)?.channel).toBe("main");

    // 2. 指定出题人 -> xxx正在出题
    await execute(service, host, {
      id: "assign",
      type: "game.assignQuestioner",
      payload: { playerId: p3.playerId },
    });
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")!;
    expect(snapshot.chat.at(-1)?.text).toBe("玩家3正在出题");

    // 出题阶段：旁观者发言依然在 main 频道
    await execute(service, specConnection, {
      id: "spec-chat-2",
      type: "chat.send",
      payload: { text: "出题阶段发言" },
    });
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")!;
    expect(snapshot.chat.at(-1)?.channel).toBe("main");

    // 3. 提交词语 -> 第 1 天描述阶段
    await execute(service, p3Connection, {
      id: "submit-words",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")!;
    expect(snapshot.chat.at(-1)?.text).toBe("第 1 天描述阶段");

    // 正式对局中：旁观者发言进入 ghost 频道
    await execute(service, specConnection, {
      id: "spec-chat-3",
      type: "chat.send",
      payload: { text: "游戏对局中发言" },
    });
    const specSnapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(
      specConnection,
      "room.snapshot"
    )!;
    expect(specSnapshot.chat.at(-1)?.channel).toBe("ghost");

    // 4. 提交描述并断言发言顺位 order 字段
    const order = snapshot.status.descriptionOrder!;
    expect(order.length).toBe(3);

    for (const conn of [host, p1Connection, p2Connection]) {
      await execute(service, conn, {
        id: `desc-${conn.record.id}`,
        type: "game.submitDescription",
        payload: { text: `${conn.record.id}的发言` },
      });
    }

    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")!;
    expect(snapshot.descriptions.length).toBe(3);
    for (const record of snapshot.descriptions) {
      const expectedOrder = order.indexOf(record.playerId) + 1;
      expect(record.order).toBe(expectedOrder);
    }
  });

  test("换房校验失败保留原绑定，成功建房加入重连均将原席位离线", async () => {
    const { service, advanceTime } = createTestContext();
    const { host, result } = await createRoom(service, "8910");
    const { host: targetHost, result: target } = await createRoom(service, "8911");
    await execute(service, targetHost, {
      id: "private-target",
      type: "room.updateSettings",
      payload: { visibility: "private", password: "secret" },
    });
    const failures = [
      { id: "missing", type: "room.join", roomId: "8912", payload: { userName: "换房" } },
      {
        id: "exists",
        type: "room.create",
        payload: {
          roomId: "8911",
          name: "重复",
          visibility: "public",
          allowSpectators: true,
          userName: "换房",
        },
      },
      { id: "token", type: "room.reconnect", payload: { roomId: "8911", sessionToken: "invalid" } },
      {
        id: "name",
        type: "room.join",
        roomId: "8911",
        payload: { userName: "房主", password: "secret" },
      },
      {
        id: "password",
        type: "room.join",
        roomId: "8911",
        payload: { userName: "换房", password: "wrong" },
      },
    ] as const;
    for (const message of failures) {
      await expect(execute(service, host, message)).rejects.toBeDefined();
      expect(host.record.roomId).toBe("8910");
      expect(host.record.playerId).toBe(result.playerId);
      expect(service.getHealthSnapshot().onlinePlayerCount).toBe(2);
    }
    await execute(service, host, {
      id: "switch-create",
      type: "room.create",
      payload: {
        roomId: "8912",
        name: "新房",
        visibility: "public",
        allowSpectators: true,
        userName: "换房",
      },
    });
    expect(service.getHealthSnapshot().onlinePlayerCount).toBe(2);
    await execute(service, host, {
      id: "switch-join",
      type: "room.join",
      roomId: "8911",
      payload: { userName: "换房", password: "secret" },
    });
    expect(service.getHealthSnapshot().onlinePlayerCount).toBe(2);
    await execute(service, host, {
      id: "switch-reconnect",
      type: "room.reconnect",
      payload: { roomId: "8910", sessionToken: result.sessionToken },
    });
    expect(service.getHealthSnapshot().onlinePlayerCount).toBe(2);
    // 同一连接恢复同一席位不产生离线/房主宽限副作用。
    await execute(service, host, {
      id: "same-reconnect",
      type: "room.reconnect",
      payload: { roomId: "8910", sessionToken: result.sessionToken },
    });
    expect(host.record.playerId).toBe(result.playerId);
    expect(target.roomId).toBe("8911");
    await service.unregisterConnection(host.record.id);
    advanceTime(ROOM_EMPTY_GRACE_PERIOD_MS + 1);
    await service.runHousekeeping();
    expect(service.getRoomSummaries().map((room) => room.roomId)).toEqual(["8911"]);
  });

  /**
   * 顶号只是把身份挪到新连接，对旧连接的通知与关闭都是尽力而为。
   *
   * 会走到这段代码的时机就是「客户端掉线后重连」——旧套接字十有八九已经废了，
   * send / close 一抛就把新连接也挡在门外，一次掉线被放大成进不去房。
   */
  test("旧连接 send 与 close 抛错不挡住顶号", async () => {
    const { service } = createTestContext();
    const { host, result } = await createRoom(service, "2401");
    host.record.send = () => {
      throw new Error("socket is not open");
    };
    host.record.close = () => {
      throw new Error("socket is not open");
    };

    const restored = createConnection(service, "2401-restored");
    const outcome = (await execute(service, restored, {
      id: "2401-reconnect",
      type: "room.reconnect",
      payload: { roomId: "2401", sessionToken: result.sessionToken },
    })) as { playerId: string };

    expect(outcome.playerId).toBe(result.playerId);
    expect(restored.record.roomId).toBe("2401");
    // 顶号分支确实走到了：旧席位被清空只发生在通知+关闭那一段里。
    expect(host.record.roomId).toBeUndefined();
    expect(host.record.playerId).toBeUndefined();
  });

  test("Agent 默认被拒绝，房主打开 allowAgents 后可进入并带身份标记", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "6161");
    const agent = createConnection(service, "agent-connection");
    agent.record.isAgent = true;

    await expect(
      execute(service, agent, {
        id: "agent-join-denied",
        type: "room.join",
        roomId: "6161",
        payload: { userName: "AgentOne" },
      })
    ).rejects.toMatchObject({ code: "AGENTS_NOT_ALLOWED" });

    await execute(service, host, {
      id: "allow-agents",
      type: "room.updateSettings",
      roomId: "6161",
      payload: { allowAgents: true },
    });
    const joined = (await execute(service, agent, {
      id: "agent-join-allowed",
      type: "room.join",
      roomId: "6161",
      payload: { userName: "AgentOne" },
    })) as { playerId: string };

    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.settings.allowAgents).toBe(true);
    expect(snapshot?.players.find((player) => player.id === joined.playerId)?.isAgent).toBe(true);
  });

  test("MCP 配对后人类会话锁定，Agent 接管同一座位，收回后恢复手动", async () => {
    const { service } = createTestContext();
    const host = createConnection(service, "pair-host");
    const created = (await execute(service, host, {
      id: "pair-create",
      type: "room.create",
      payload: {
        roomId: "9191",
        name: "配对房",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
        allowAgents: true,
      },
    })) as { playerId: string; sessionToken: string };

    const agent = createConnection(service, "pair-agent");
    agent.record.isAgent = true;
    const claimed = (await execute(service, agent, {
      id: "pair-claim",
      type: "mcp.claim",
      payload: { roomId: "9191", sessionToken: created.sessionToken },
    })) as { playerId: string; sessionToken: string };

    expect(claimed.playerId).toBe(created.playerId);
    expect(claimed.sessionToken).not.toBe(created.sessionToken);

    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.players.find((player) => player.id === created.playerId)?.mcpControlled).toBe(
      true
    );
    const viewerState = getLastEventPayload<WhoIsFakerPrivateState>(host, "game.privateState");
    expect(viewerState?.mcpControlled).toBe(true);
    expect(viewerState?.sessionToken).toBe(created.sessionToken);

    await expect(
      execute(service, host, {
        id: "pair-host-chat",
        type: "chat.send",
        payload: { text: "人类手动消息" },
      })
    ).rejects.toMatchObject({ code: "MCP_CONTROL_ONLY" });

    await execute(service, agent, {
      id: "pair-agent-chat",
      type: "chat.send",
      payload: { text: "Agent 消息" },
    });

    await execute(service, host, {
      id: "pair-release",
      type: "mcp.release",
      payload: {},
    });
    await execute(service, host, {
      id: "pair-host-chat-after",
      type: "chat.send",
      payload: { text: "恢复手动" },
    });
  });

  test("人类页面已关时 Agent 离房：座位转为离线保留，人类凭证仍可重连", async () => {
    const { service } = createTestContext();
    const host = createConnection(service, "away-host");
    const created = (await execute(service, host, {
      id: "away-create",
      type: "room.create",
      payload: {
        roomId: "9292",
        name: "离房房",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
        allowAgents: true,
      },
    })) as { playerId: string; sessionToken: string };
    const guest = createConnection(service, "away-guest");
    await execute(service, guest, {
      id: "away-guest-join",
      type: "room.join",
      roomId: "9292",
      payload: { userName: "玩家" },
    });
    const agent = createConnection(service, "away-agent");
    agent.record.isAgent = true;
    await execute(service, agent, {
      id: "away-claim",
      type: "mcp.claim",
      payload: { roomId: "9292", sessionToken: created.sessionToken },
    });
    await service.unregisterConnection(host.record.id);

    await execute(service, agent, { id: "away-leave", type: "room.leave", payload: {} });

    const seat = getLastEventPayload<WhoIsFakerRoomSnapshot>(guest, "room.snapshot")?.players.find(
      (player) => player.id === created.playerId
    );
    expect(seat).toMatchObject({ online: false });
    const back = createConnection(service, "away-host-back");
    const resumed = (await execute(service, back, {
      id: "away-reconnect",
      type: "room.reconnect",
      payload: { roomId: "9292", sessionToken: created.sessionToken },
    })) as { playerId: string };
    expect(resumed.playerId).toBe(created.playerId);
  });

  test("会话凭证只能走 MCP 认领，Agent 不能直接重连顶掉人类页面", async () => {
    const { service } = createTestContext();
    const host = createConnection(service, "claim-guard-host");
    const created = (await execute(service, host, {
      id: "claim-guard-create",
      type: "room.create",
      payload: {
        roomId: "9192",
        name: "凭证房",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
        allowAgents: true,
      },
    })) as { sessionToken: string };

    const agent = createConnection(service, "claim-guard-agent");
    agent.record.isAgent = true;
    await expect(
      execute(service, agent, {
        id: "claim-guard-reconnect",
        type: "room.reconnect",
        payload: { roomId: "9192", sessionToken: created.sessionToken },
      })
    ).rejects.toMatchObject({ code: "AGENT_CLAIM_REQUIRED" });

    await expect(
      execute(service, agent, {
        id: "claim-guard-wrong-token",
        type: "mcp.claim",
        payload: { roomId: "9192", sessionToken: "wrong-token" },
      })
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  test("Agent 焦点只发给接管座位的人类查看器，普通连接不能伪造焦点", async () => {
    const { service } = createTestContext();
    const host = createConnection(service, "focus-host");
    const created = (await execute(service, host, {
      id: "focus-create",
      type: "room.create",
      payload: {
        roomId: "9193",
        name: "焦点房",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
        allowAgents: true,
      },
    })) as { sessionToken: string };
    const other = createConnection(service, "focus-other");
    await execute(service, other, {
      id: "focus-join-other",
      type: "room.join",
      roomId: "9193",
      payload: { userName: "旁观者" },
    });

    const agent = createConnection(service, "focus-agent");
    agent.record.isAgent = true;
    await execute(service, agent, {
      id: "focus-claim",
      type: "mcp.claim",
      payload: { roomId: "9193", sessionToken: created.sessionToken },
    });

    const human = createConnection(service, "focus-human");
    await expect(
      execute(service, human, {
        id: "focus-human",
        type: "mcp.focus",
        payload: { agentName: "Fake", tool: "get_screen", kind: "state" },
      })
    ).rejects.toMatchObject({ code: "AGENT_REQUIRED" });

    await execute(service, agent, {
      id: "focus-agent",
      type: "mcp.focus",
      payload: {
        agentName: "TestAgent",
        tool: "ui_run",
        kind: "action",
        action: "type",
        controlId: "chat.input",
        part: "chat",
        label: "聊天消息",
        input: "只给座位主人看",
      },
    });
    const focus = getLastEventPayload<{
      agentName: string;
      kind: string;
      game: string;
      controlId: string;
      input: string;
      at: number;
    }>(host, "mcp.focus");
    expect(focus).toMatchObject({
      agentName: "TestAgent",
      kind: "action",
      game: "faker",
      controlId: "chat.input",
      input: "只给座位主人看",
    });
    expect(typeof focus?.at).toBe("number");
    expect(getLastEventPayload(other, "mcp.focus")).toBeUndefined();
  });
});
