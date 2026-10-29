import { describe, expect, test } from "bun:test";
import { type JoinedPlayer, createRoom, joinPlayers } from "./Fixtures";
import { PHASE_RESULT_DISPLAY_MS, ROOM_EMPTY_GRACE_PERIOD_MS } from "../../src/config/Constants";
import {
  SERVER_SHUTDOWN_MESSAGE,
  type WhoIsFakerPrivateState,
  type WhoIsFakerRoomSnapshot,
} from "../../src/shared/Index";
import {
  createConnection,
  createTestContext,
  execute,
  getEventPayloads,
  getLastEventPayload,
} from ".././Helpers";

describe("测试房间", () => {
  test("Oblivionis 测试房间不含机器人、不进大厅、不自动清理", async () => {
    // 新版测试模式改为手动跳转阶段；服务端不再注入 Bot、不入大厅列表、housekeeping 不清理。
    const { service, advanceTime } = createTestContext();
    const { host } = await createRoom(service, "Oblivionis");

    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.players.filter((player) => player.isBot)).toHaveLength(0);

    // 测试房间不应出现在大厅摘要里。
    expect(service.getRoomSummaries().find((item) => item.roomId === "Oblivionis")).toBeUndefined();

    // 闲置超时后也不应被清理。
    advanceTime(30 * 60 * 1000);
    await service.runHousekeeping();
    const afterSnapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(afterSnapshot?.roomId).toBe("Oblivionis");
  });

  test("测试房间最后一人掉线后仍然保留，可凭令牌回到原席位", async () => {
    // 刷新页面会先断开旧连接。此时测试房如果被当成空房清掉，
    // 正在调试的房间状态就一起丢了。
    const { service } = createTestContext();
    const { host, result } = await createRoom(service, "Oblivionis");

    await service.unregisterConnection(host.record.id);

    const rejoin = createConnection(service, "oblivionis-rejoin");
    await execute(service, rejoin, {
      id: "reconnect-test-room",
      type: "room.reconnect",
      payload: { roomId: "Oblivionis", sessionToken: result.sessionToken },
    });

    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(rejoin, "room.snapshot");
    expect(snapshot?.roomId).toBe("Oblivionis");
    expect(getEventPayloads(host, "room.closed")).toHaveLength(0);
  });

  test("正式房间最后一人掉线后在空房宽限期内仍可重连", async () => {
    const { service, advanceTime } = createTestContext();
    const { host, result } = await createRoom(service, "8123");

    await service.unregisterConnection(host.record.id);
    expect(service.getRoomSummaries()).toHaveLength(1);
    advanceTime(ROOM_EMPTY_GRACE_PERIOD_MS - 1);
    await service.runHousekeeping();

    const rejoin = createConnection(service, "8123-rejoin");
    await execute(service, rejoin, {
      id: "reconnect-within-grace",
      type: "room.reconnect",
      payload: { roomId: "8123", sessionToken: result.sessionToken },
    });

    expect(getLastEventPayload<WhoIsFakerRoomSnapshot>(rejoin, "room.snapshot")?.roomId).toBe(
      "8123"
    );
  });

  test("测试房间单人不能跳转阶段，补足机器人后可以", async () => {
    // 测试房间与真实房间同规则：不足 4 名正式玩家不能开局。
    const { service } = createTestContext();
    const { host } = await createRoom(service, "Oblivionis");

    let errorCode: string | undefined;
    try {
      await execute(service, host, {
        id: "jump-solo",
        type: "test.jumpToPhase",
        payload: { phase: "voting" },
      });
    } catch (error) {
      errorCode = (error as { code?: string }).code;
    }

    expect(errorCode).toBe("INSUFFICIENT_PLAYERS");

    // 人数不足的跳转在建 round 之前就被拒，房间仍停在等待阶段，
    // 所以补进来的机器人直接参战，不需要先回退阶段。
    const stillWaiting = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(stillWaiting?.status.phase).toBe("waiting");

    await execute(service, host, {
      id: "add-bots",
      type: "test.addBot",
      payload: { count: 4 },
    });
    await execute(service, host, {
      id: "jump-voting",
      type: "test.jumpToPhase",
      payload: { phase: "voting" },
    });

    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    const privateState = getLastEventPayload<WhoIsFakerPrivateState>(host, "game.privateState");
    expect(snapshot?.status.phase).toBe("voting");
    expect(
      snapshot?.players.find((player) => player.id === privateState?.playerId)?.roundStatus
    ).toBe("alive");
    expect(privateState?.role).toBeDefined();
  });

  test("指定自己为出题人后始终保持出题人身份，不会退化成玩家", async () => {
    const { service } = createTestContext();
    const { host, result } = await createRoom(service, "Oblivionis");

    // 5 名正式玩家：房主出题，4 个机器人参战。
    await execute(service, host, {
      id: "add-bots",
      type: "test.addBot",
      payload: { count: 4 },
    });
    await execute(service, host, {
      id: "ready-host",
      type: "player.setReady",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "start",
      type: "game.advancePhase",
      payload: {},
    });
    await execute(service, host, {
      id: "assign-self",
      type: "game.assignQuestioner",
      payload: { playerId: result.playerId },
    });
    await execute(service, host, {
      id: "submit-words",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });

    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    const privateState = getLastEventPayload<WhoIsFakerPrivateState>(host, "game.privateState");
    expect(snapshot?.status.phase).toBe("description");
    // 出题人必须仍是自己，且不参与对局、不持有词语。
    expect(snapshot?.status.questionerPlayerId).toBe(result.playerId);
    expect(privateState?.isQuestioner).toBe(true);
    expect(privateState?.word).toBeUndefined();
  });

  test("跳转控制器不会把已确定的出题人清空", async () => {
    const { service } = createTestContext();
    const { host, result } = await createRoom(service, "Oblivionis");

    await execute(service, host, {
      id: "add-bots",
      type: "test.addBot",
      payload: { count: 4 },
    });

    // 跳出题阶段 → 调用者成为出题人。
    await execute(service, host, {
      id: "jump-words",
      type: "test.jumpToPhase",
      payload: { phase: "wordSubmission" },
    });
    expect(
      getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")?.status.questionerPlayerId
    ).toBe(result.playerId);

    // 出完题继续往后跳，出题人身份必须留住，不能退化成普通玩家。
    for (const phase of ["description", "voting", "night"] as const) {
      await execute(service, host, {
        id: `jump-${phase}`,
        type: "test.jumpToPhase",
        payload: { phase },
      });

      const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
      const privateState = getLastEventPayload<WhoIsFakerPrivateState>(host, "game.privateState");
      expect(snapshot?.status.questionerPlayerId).toBe(result.playerId);
      expect(privateState?.isQuestioner).toBe(true);
      // 出题人不参战，不该被分到词和身份。
      expect(privateState?.word).toBeUndefined();
    }
  });

  test("单人在测试房间跳转被拒后，房间不会被开局", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "Oblivionis");

    for (const phase of ["assigningQuestioner", "wordSubmission", "description"] as const) {
      let errorCode: string | undefined;
      try {
        await execute(service, host, {
          id: `solo-${phase}`,
          type: "test.jumpToPhase",
          payload: { phase },
        });
      } catch (error) {
        errorCode = (error as { code?: string }).code;
      }

      expect(errorCode).toBe("INSUFFICIENT_PLAYERS");
      // 关键：拒绝必须发生在 startRound 之前，房间仍停在等待阶段。
      const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
      expect(snapshot?.status.phase).toBe("waiting");
      expect(snapshot?.status.day).toBe(0);
    }
  });

  test("房间会在无人在线或闲置超时后被清理", async () => {
    // 这里同时验证“空房宽限期清理”和“闲置超时清理”两条房间生命周期规则。
    const { service, advanceTime } = createTestContext();
    const { host } = await createRoom(service, "6666");

    await service.unregisterConnection(host.record.id);
    expect(service.getRoomSummaries()).toHaveLength(1);
    advanceTime(ROOM_EMPTY_GRACE_PERIOD_MS + 1);
    await service.runHousekeeping();
    expect(service.getRoomSummaries()).toHaveLength(0);

    const next = await createRoom(service, "7777");
    advanceTime(10 * 60 * 1000 + 1);
    await service.runHousekeeping();

    const closed = getLastEventPayload<{ roomId: string; reason: string }>(
      next.host,
      "room.closed"
    );
    expect(closed?.reason).toBe("idle_timeout");
    expect(service.getRoomSummaries()).toHaveLength(0);
  });

  test("服务关闭通知会广播到所有连接", () => {
    const { service } = createTestContext();
    const connection = createConnection(service, "shutdown");

    service.notifyShutdown();

    expect(getLastEventPayload<{ message: string }>(connection, "server.shutdown")?.message).toBe(
      SERVER_SHUTDOWN_MESSAGE
    );
  });

  test("真实结算结果展示结束前不能返回等待阶段", async () => {
    const { service, advanceTime } = createTestContext();
    const { host, result: hostResult } = await createRoom(service, "5151");
    const joined = await joinPlayers(service, "5151", 4, "结算锁玩家");
    const allConnections = [host, ...joined.map((item) => item.connection)];

    for (const connection of allConnections) {
      await execute(service, connection, {
        id: `ready-${connection.record.id}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    }
    await execute(service, host, { id: "start", type: "game.advancePhase", payload: {} });
    const questioner = joined[3]!;
    await execute(service, host, {
      id: "assign-questioner",
      type: "game.assignQuestioner",
      payload: { playerId: questioner.joinResult.playerId },
    });
    await execute(service, questioner.connection, {
      id: "submit-words",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });

    const voters = [host, joined[0]!.connection, joined[1]!.connection, joined[2]!.connection];
    for (const connection of voters) {
      await execute(service, connection, {
        id: `describe-${connection.record.id}`,
        type: "game.submitDescription",
        payload: { text: "阶段结算测试" },
      });
    }
    await execute(service, questioner.connection, {
      id: "advance-to-voting",
      type: "game.advancePhase",
      payload: {},
    });
    for (const [index, connection] of voters.entries()) {
      await execute(service, connection, {
        id: `vote-${connection.record.id}`,
        type: "game.submitVote",
        payload: {
          targetId: index === 0 ? joined[0]!.joinResult.playerId : hostResult.playerId,
        },
      });
    }
    await execute(service, questioner.connection, {
      id: "resolve-voting",
      type: "game.advancePhase",
      payload: {},
    });
    // 反馈只有出题人能继续，房主不行。
    let hostContinueError: string | undefined;
    try {
      await execute(service, host, { id: "host-continue", type: "game.advancePhase", payload: {} });
    } catch (error) {
      hostContinueError = (error as { code?: string }).code;
    }
    expect(hostContinueError).toBe("FORBIDDEN");
    await execute(service, questioner.connection, {
      id: "continue-voting",
      type: "game.advancePhase",
      payload: {},
    });
    expect(getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")?.status.phase).toBe(
      "gameOver"
    );

    let errorCode: string | undefined;
    try {
      await execute(service, host, {
        id: "advance-during-result",
        type: "game.advancePhase",
        payload: {},
      });
    } catch (error) {
      errorCode = (error as { code?: string }).code;
    }
    expect(errorCode).toBe("PHASE_RESULT_PENDING");
    expect(getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")?.status.phase).toBe(
      "gameOver"
    );

    advanceTime(PHASE_RESULT_DISPLAY_MS);
    await execute(service, host, {
      id: "advance-after-result",
      type: "game.advancePhase",
      payload: {},
    });
    expect(getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")?.status.phase).toBe(
      "waiting"
    );
  });

  test("测试控制器生成的结算后房主可以让全房返回等待阶段", async () => {
    const { service, advanceTime } = createTestContext();
    const { host, result } = await createRoom(service, "Oblivionis");
    await execute(service, host, {
      id: "waiting-add-bots",
      type: "test.addBot",
      payload: { count: 4 },
    });
    await execute(service, host, {
      id: "waiting-jump-over",
      type: "test.jumpToPhase",
      payload: { phase: "gameOver" },
    });
    advanceTime(PHASE_RESULT_DISPLAY_MS);

    await execute(service, host, {
      id: "return-to-waiting",
      type: "game.advancePhase",
      payload: {},
    });

    let snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.status).toMatchObject({ phase: "waiting", started: false, day: 0 });
    expect(snapshot?.summary).toBeUndefined();
    // 房主没有准备态，快照里恒为已准备；机器人回到等待后自动准备。
    expect(snapshot?.players.find((player) => player.id === result.playerId)?.isReady).toBe(true);
    expect(
      snapshot?.players.filter((player) => player.isBot).every((player) => player.isReady)
    ).toBe(true);

    await execute(service, host, {
      id: "host-ready-again",
      type: "player.setReady",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "start-next-round",
      type: "game.advancePhase",
      payload: {},
    });
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.status.phase).toBe("assigningQuestioner");
  });

  test("撤销投票和夜晚动作会同步清空私有状态并允许重新提交", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "Oblivionis");
    const [player] = await joinPlayers(service, "Oblivionis", 1, "撤回玩家");
    await execute(service, host, {
      id: "cancel-add-bots",
      type: "test.addBot",
      payload: { count: 3 },
    });
    await execute(service, host, {
      id: "cancel-jump-words",
      type: "test.jumpToPhase",
      payload: { phase: "wordSubmission" },
    });
    await execute(service, host, {
      id: "cancel-submit-words",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });
    await execute(service, host, {
      id: "cancel-jump-voting",
      type: "test.jumpToPhase",
      payload: { phase: "voting" },
    });

    const voteTarget = getLastEventPayload<WhoIsFakerRoomSnapshot>(
      player.connection,
      "room.snapshot"
    )?.players.find(
      (entry) => entry.roundStatus === "alive" && entry.id !== player.joinResult.playerId
    );
    expect(voteTarget).toBeDefined();
    await execute(service, player.connection, {
      id: "submit-vote-before-cancel",
      type: "game.submitVote",
      payload: { targetId: voteTarget!.id },
    });
    expect(
      getLastEventPayload<WhoIsFakerPrivateState>(player.connection, "game.privateState")
        ?.myCurrentVoteTargetId
    ).toBe(voteTarget!.id);

    await execute(service, player.connection, {
      id: "cancel-vote",
      type: "game.cancelVote",
      payload: {},
    });
    expect(
      getLastEventPayload<WhoIsFakerPrivateState>(player.connection, "game.privateState")
        ?.myCurrentVoteTargetId
    ).toBeUndefined();
    expect(
      getLastEventPayload<WhoIsFakerPrivateState>(
        host,
        "game.privateState"
      )?.privilegedActionPreview?.votes.some((vote) => vote.voterId === player.joinResult.playerId)
    ).toBe(false);
    expect(
      await execute(service, player.connection, {
        id: "cancel-vote-again",
        type: "game.cancelVote",
        payload: {},
      })
    ).toEqual({ cancelled: false });

    await execute(service, player.connection, {
      id: "submit-vote-again",
      type: "game.submitVote",
      payload: { targetId: voteTarget!.id },
    });

    await execute(service, host, {
      id: "cancel-jump-night",
      type: "test.jumpToPhase",
      payload: { phase: "night" },
    });
    await execute(service, player.connection, {
      id: "submit-night-before-cancel",
      type: "game.submitNightAction",
      payload: { targetId: null },
    });
    expect(
      getLastEventPayload<WhoIsFakerPrivateState>(player.connection, "game.privateState")
        ?.nightActionSubmitted
    ).toBe(true);

    await execute(service, player.connection, {
      id: "cancel-night",
      type: "game.cancelNightAction",
      payload: {},
    });
    const cancelledNight = getLastEventPayload<WhoIsFakerPrivateState>(
      player.connection,
      "game.privateState"
    );
    expect(cancelledNight?.nightActionSubmitted).toBe(false);
    expect(cancelledNight?.myCurrentNightTargetId).toBeUndefined();
    expect(
      getLastEventPayload<WhoIsFakerPrivateState>(
        host,
        "game.privateState"
      )?.privilegedActionPreview?.nightActions.some(
        (action) => action.actorId === player.joinResult.playerId
      )
    ).toBe(false);
    expect(
      await execute(service, player.connection, {
        id: "cancel-night-again",
        type: "game.cancelNightAction",
        payload: {},
      })
    ).toEqual({ cancelled: false });

    await execute(service, player.connection, {
      id: "submit-night-again",
      type: "game.submitNightAction",
      payload: { targetId: null },
    });
    expect(
      getLastEventPayload<WhoIsFakerPrivateState>(player.connection, "game.privateState")
        ?.nightActionSubmitted
    ).toBe(true);
  });

  test("踢出待发言玩家会从当前描述顺序移除且不阻塞推进", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "Oblivionis");
    const humans = await joinPlayers(service, "Oblivionis", 2, "发言玩家");
    await execute(service, host, {
      id: "description-add-bots",
      type: "test.addBot",
      payload: { count: 3 },
    });
    await execute(service, host, {
      id: "description-jump-words",
      type: "test.jumpToPhase",
      payload: { phase: "wordSubmission" },
    });
    await execute(service, host, {
      id: "description-submit-words",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });

    const target = humans.find(
      ({ connection }) =>
        getLastEventPayload<WhoIsFakerPrivateState>(connection, "game.privateState")?.role ===
        "civilian"
    );
    const remaining = humans.find((item) => item !== target);
    expect(target).toBeDefined();
    expect(remaining).toBeDefined();

    await execute(service, remaining!.connection, {
      id: "remaining-description",
      type: "game.submitDescription",
      payload: { text: "剩余玩家发言" },
    });
    await execute(service, host, {
      id: "kick-pending-description",
      type: "room.kick",
      payload: { playerId: target!.joinResult.playerId },
    });

    let snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.status.phase).toBe("description");
    expect(snapshot?.status.descriptionOrder).not.toContain(target!.joinResult.playerId);
    await execute(service, host, {
      id: "advance-after-description-kick",
      type: "game.advancePhase",
      payload: {},
    });
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.status.phase).toBe("voting");
  });

  test("夜晚踢人会保留其他有效动作并让机器人补齐缺失动作", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "Oblivionis");
    const humans = await joinPlayers(service, "Oblivionis", 2, "夜晚玩家");
    await execute(service, host, {
      id: "night-kick-add-bots",
      type: "test.addBot",
      payload: { count: 3 },
    });
    await execute(service, host, {
      id: "night-kick-jump-words",
      type: "test.jumpToPhase",
      payload: { phase: "wordSubmission" },
    });
    await execute(service, host, {
      id: "night-kick-submit-words",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });
    await execute(service, host, {
      id: "night-kick-jump-night",
      type: "test.jumpToPhase",
      payload: { phase: "night" },
    });

    const target = humans.find(
      ({ connection }) =>
        getLastEventPayload<WhoIsFakerPrivateState>(connection, "game.privateState")?.role ===
        "civilian"
    );
    const actor = humans.find((item) => item !== target);
    expect(target).toBeDefined();
    expect(actor).toBeDefined();

    await execute(service, actor!.connection, {
      id: "night-action-before-kick",
      type: "game.submitNightAction",
      payload: { targetId: null },
    });
    await execute(service, host, {
      id: "kick-during-night",
      type: "room.kick",
      payload: { playerId: target!.joinResult.playerId },
    });

    expect(
      getLastEventPayload<WhoIsFakerPrivateState>(actor!.connection, "game.privateState")
        ?.nightActionSubmitted
    ).toBe(true);
    await execute(service, host, {
      id: "advance-after-night-kick",
      type: "game.advancePhase",
      payload: {},
    });
    await execute(service, host, {
      id: "continue-after-night-kick",
      type: "game.advancePhase",
      payload: {},
    });
    expect(getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")?.status.phase).toBe(
      "description"
    );
  });

  test("平票PK第二轮再次平票时无人出局并直接进入夜晚", async () => {
    const { service } = createTestContext();
    const { host, result: hostResult } = await createRoom(service, "3334");
    const joined: JoinedPlayer[] = [];

    for (let index = 0; index < 4; index += 1) {
      const connection = createConnection(service, `tie-draw-join-${index}`);
      const joinResult = (await execute(service, connection, {
        id: `join-${index}`,
        type: "room.join",
        roomId: "3334",
        payload: {
          userName: `平票玩家${index + 2}`,
        },
      })) as { playerId: string };
      joined.push({ connection, joinResult });
    }

    for (const connection of [host, ...joined.map((item) => item.connection)]) {
      await execute(service, connection, {
        id: `ready-${connection.record.id}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    }

    await execute(service, host, { id: "start", type: "game.advancePhase", payload: {} });
    const questioner = joined[3];
    await execute(service, host, {
      id: "assign",
      type: "game.assignQuestioner",
      payload: { playerId: questioner.joinResult.playerId },
    });
    await execute(service, questioner.connection, {
      id: "words",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });

    for (const connection of [
      host,
      joined[0].connection,
      joined[1].connection,
      joined[2].connection,
    ]) {
      await execute(service, connection, {
        id: `desc-${connection.record.id}`,
        type: "game.submitDescription",
        payload: { text: "描述" },
      });
    }

    await execute(service, questioner.connection, {
      id: "to-vote",
      type: "game.advancePhase",
      payload: {},
    });

    // 第一轮：joined[0] 和 joined[1] 各得2票平票
    await execute(service, host, {
      id: "vote-host",
      type: "game.submitVote",
      payload: { targetId: joined[0].joinResult.playerId },
    });
    await execute(service, joined[0].connection, {
      id: "vote-1",
      type: "game.submitVote",
      payload: { targetId: joined[1].joinResult.playerId },
    });
    await execute(service, joined[1].connection, {
      id: "vote-2",
      type: "game.submitVote",
      payload: { targetId: joined[0].joinResult.playerId },
    });
    await execute(service, joined[2].connection, {
      id: "vote-3",
      type: "game.submitVote",
      payload: { targetId: joined[1].joinResult.playerId },
    });

    await execute(service, questioner.connection, {
      id: "resolve-1",
      type: "game.advancePhase",
      payload: {},
    });

    let snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.status.phase).toBe("feedback");
    expect(snapshot?.status.feedback?.tieBreakCandidateIds).toHaveLength(2);
    expect(snapshot?.status.feedback?.next).toBe("tieBreak");
    await execute(service, questioner.connection, {
      id: "continue-1",
      type: "game.advancePhase",
      payload: {},
    });
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.status.phase).toBe("tieBreak");
    expect(snapshot?.status.tieBreakStage).toBe("description");

    // 双方补充发言
    const tieOrder = snapshot?.status.speechOrder ?? [];
    const connectionByPlayerId = new Map<string, typeof host>([
      [hostResult.playerId, host],
      ...joined.map((item) => [item.joinResult.playerId, item.connection] as const),
    ]);

    for (const pid of tieOrder) {
      await execute(service, connectionByPlayerId.get(pid)!, {
        id: `tie-desc-${pid}`,
        type: "game.submitDescription",
        payload: { text: "PK描述" },
      });
    }

    await execute(service, questioner.connection, {
      id: "to-tie-vote",
      type: "game.advancePhase",
      payload: {},
    });

    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.status.tieBreakStage).toBe("vote");

    // 第二轮平票PK投票：host 投 joined[0], joined[2] 投 joined[1] -> 再次各得1票平票
    await execute(service, host, {
      id: "tie-vote-host-again",
      type: "game.submitVote",
      payload: { targetId: joined[0].joinResult.playerId },
    });
    await execute(service, joined[2].connection, {
      id: "tie-vote-2-again",
      type: "game.submitVote",
      payload: { targetId: joined[1].joinResult.playerId },
    });

    await execute(service, questioner.connection, {
      id: "resolve-2",
      type: "game.advancePhase",
      payload: {},
    });

    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    // 再次平票的反馈里无人出局，也不再有 PK 候选
    expect(snapshot?.status.feedback).toMatchObject({
      kind: "vote",
      tieBreak: true,
      eliminatedPlayerIds: [],
      next: "night",
    });
    expect(snapshot?.status.feedback?.tieBreakCandidateIds).toBeUndefined();
    await execute(service, questioner.connection, {
      id: "continue-2",
      type: "game.advancePhase",
      payload: {},
    });
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    // 必须进入夜晚且全员存活，无人出局
    expect(snapshot?.status.phase).toBe("night");
    const aliveCount = (snapshot?.players ?? []).filter((p) => p.roundStatus === "alive").length;
    expect(aliveCount).toBe(4);
  });
});

test("测试房在对局中途跳回等待，不留下开局时间记录", async () => {
  const { service } = createTestContext();
  const { host } = await createRoom(service, "Oblivionis");
  await execute(service, host, { id: "bots", type: "test.addBot", payload: { count: 4 } });
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
  expect(service.roundStartedAtById.size).toBe(1);
  // 跳回等待跳过了结算：结算侧不会再来取走这条记录，必须在丢弃回合时一并清掉。
  await execute(service, host, {
    id: "back",
    type: "test.jumpToPhase",
    payload: { phase: "waiting" },
  });
  expect(service.roundStartedAtById.size).toBe(0);
});
