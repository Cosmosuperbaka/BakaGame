import { describe, expect, test } from "bun:test";
import { createRoom, joinPlayers, setMyRoleAs } from "./Fixtures";
import { ROOM_EMPTY_GRACE_PERIOD_MS } from "../../src/config/Constants";
import { type WhoIsFakerRoomSnapshot } from "../../src/shared/Index";
import {
  ABSTAIN_TARGET_ID,
  type WhoIsFakerPrivateState,
  type WhoIsFakerRole,
} from "../../src/shared/WhoIsFaker";
import {
  createConnection,
  createTestContext,
  execute,
  getEventPayloads,
  getLastEventPayload,
} from ".././Helpers";

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

    // 旁观者与亡者同属一个频道，以旁观者能读亡者频道为前提；关闭时的口径另有用例。
    await execute(service, host, {
      id: "spectators-see",
      type: "room.updateSettings",
      payload: { spectatorsSeeAnswers: true },
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

  test("私有帧不下发本人身份：平民与卧底的私有帧除词语外逐字段相同", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "4141");
    const joined = await joinPlayers(service, "4141", 9, "玩家");
    await execute(service, host, {
      id: "settings",
      type: "room.updateSettings",
      payload: { roleConfig: { undercoverCount: 1, hasAngel: true, hasBlank: true } },
    });
    for (const connection of [host, ...joined.map((item) => item.connection)]) {
      await execute(service, connection, {
        id: `ready-${connection.record.id}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    }
    await execute(service, host, { id: "start", type: "game.advancePhase", payload: {} });
    const questioner = joined[8];
    await execute(service, host, {
      id: "assign",
      type: "game.assignQuestioner",
      payload: { playerId: questioner.joinResult.playerId },
    });

    // 手动指定身份：卧底、天使、白板各一人，其余平民。
    const manualRoles: Record<string, WhoIsFakerRole> = {
      [host.record.playerId!]: "civilian",
      [joined[0].joinResult.playerId]: "undercover",
      [joined[1].joinResult.playerId]: "angel",
      [joined[2].joinResult.playerId]: "blank",
    };
    for (const index of [3, 4, 5, 6, 7]) {
      manualRoles[joined[index].joinResult.playerId] = "civilian";
    }
    await execute(service, questioner.connection, {
      id: "words",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"], blankHint: "水果", manualRoles },
    });

    const frameOf = (connection: typeof host) =>
      getLastEventPayload<WhoIsFakerPrivateState>(connection, "game.privateState")!;
    const civilian = frameOf(host);
    const undercover = frameOf(joined[0].connection);
    const angel = frameOf(joined[1].connection);
    const blank = frameOf(joined[2].connection);

    // 参与对局的连接从头到尾收到的每一帧私有状态里都没有身份与调试字段。
    for (const connection of [host, ...joined.slice(0, 8).map((item) => item.connection)]) {
      for (const payload of getEventPayloads<Record<string, unknown>>(
        connection,
        "game.privateState"
      )) {
        // 线上帧是 JSON：值为 undefined 的键不会出现，这里按线上形态断言键集。
        const wire = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
        for (const key of ["role", "side", "debugRole"]) {
          expect(Object.keys(wire)).not.toContain(key);
        }
      }
    }

    // 平民与卧底：只有词语不同，其余字段（含能力位）完全一致，无法反推身份。
    const strip = (frame: WhoIsFakerPrivateState) => {
      const { playerId: _playerId, sessionToken: _sessionToken, word: _word, ...rest } = frame;
      return rest;
    };
    expect(civilian.word).toBeDefined();
    expect(undercover.word).toBeDefined();
    expect(civilian.word).not.toBe(undercover.word);
    expect(strip(undercover)).toEqual(strip(civilian));
    expect(civilian.canActAtNight).toBe(true);
    expect(civilian.specialRole).toBeUndefined();

    // 天使与白板本来就知情：靠候选词与词性提示，且夜里没有行动资格。
    expect(angel.specialRole).toBe("angel");
    expect(angel.angelWordOptions).toEqual(["苹果", "香蕉"]);
    expect(angel.canActAtNight).toBe(false);
    expect(blank.specialRole).toBe("blank");
    expect(blank.blankHint).toBe("水果");
    expect(blank.canSubmitBlankGuess).toBe(true);
    expect(blank.canActAtNight).toBe(false);

    // 出题人走上帝视角，不是玩家，没有夜间资格。
    expect(frameOf(questioner.connection).canActAtNight).toBe(false);
    expect(frameOf(questioner.connection).questionerView).toHaveLength(9);
  });

  test("夜间资格随出局取消，普通房间不下发调试身份而测试房下发", async () => {
    const { service } = createTestContext();
    const { host, result: hostSeat } = await createRoom(service, "Oblivionis");
    const [player] = await joinPlayers(service, "Oblivionis", 1, "玩家");
    await execute(service, host, { id: "bots", type: "test.addBot", payload: { count: 3 } });
    await execute(service, host, {
      id: "jump-words",
      type: "test.jumpToPhase",
      payload: { phase: "wordSubmission" },
    });
    await execute(service, host, {
      id: "words",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });
    await setMyRoleAs(service, host, hostSeat.playerId, player, "civilian");

    let frame = getLastEventPayload<WhoIsFakerPrivateState>(player.connection, "game.privateState");
    expect(frame?.debugRole).toBe("civilian");
    expect(frame?.canActAtNight).toBe(true);
    expect(frame).not.toHaveProperty("role");
    expect(frame).not.toHaveProperty("side");

    // 出局后即使角色仍是平民，也不再有夜间行动资格。
    const room = (
      service as unknown as {
        rooms: Map<string, { round: { assignments: Record<string, { alive: boolean }> } }>;
      }
    ).rooms.get("Oblivionis")!;
    room.round.assignments[player.joinResult.playerId].alive = false;
    await execute(service, host, { id: "touch", type: "chat.send", payload: { text: "刷新" } });
    frame = getLastEventPayload<WhoIsFakerPrivateState>(player.connection, "game.privateState");
    expect(frame?.canActAtNight).toBe(false);
  });

  test("关闭死亡身份揭露时，反馈预告不再暴露去向，开启时照常给出", async () => {
    const nextOf = async (reveal: boolean) => {
      const { service } = createTestContext();
      const { host } = await createRoom(service, "Oblivionis");
      const [p1] = await joinPlayers(service, "Oblivionis", 1, "玩家");
      await execute(service, host, {
        id: "settings",
        type: "room.updateSettings",
        payload: { revealRoleOnDeath: reveal },
      });
      await execute(service, host, { id: "bots", type: "test.addBot", payload: { count: 3 } });
      await execute(service, host, {
        id: "jump-words",
        type: "test.jumpToPhase",
        payload: { phase: "wordSubmission" },
      });
      await execute(service, host, {
        id: "words",
        type: "game.submitWords",
        payload: { words: ["苹果", "香蕉"] },
      });
      await execute(service, host, {
        id: "jump-voting",
        type: "test.jumpToPhase",
        payload: { phase: "voting" },
      });
      // 真人弃权，机器人自行投票；具体去向由真实身份与票型决定，这里只比较公开预告。
      await execute(service, p1.connection, {
        id: "abstain",
        type: "game.submitVote",
        payload: { targetId: ABSTAIN_TARGET_ID },
      });
      await execute(service, host, { id: "resolve", type: "game.advancePhase", payload: {} });
      const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(p1.connection, "room.snapshot");
      expect(snapshot?.status.phase).toBe("feedback");
      return snapshot?.status.feedback?.next;
    };

    expect(await nextOf(true)).not.toBe("continue");
    expect(await nextOf(false)).toBe("continue");
  });
});
