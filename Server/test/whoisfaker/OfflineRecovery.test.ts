import { describe, expect, test } from "bun:test";
import { type JoinedPlayer, createRoom } from "./Fixtures";
import { type WhoIsFakerPrivateState, type WhoIsFakerRoomSnapshot } from "../../src/shared/Index";
import {
  createConnection,
  createTestContext,
  execute,
  getEventPayloads,
  getLastEventPayload,
} from ".././Helpers";

describe("掉线与恢复", () => {
  test("玩家掉线后会等待出题人处理并可被淘汰移出", async () => {
    // 这里验证掉线玩家不会立刻消失，而是进入出题人决策流程。
    const { service } = createTestContext();
    const { host } = await createRoom(service, "5555");
    const joined: JoinedPlayer[] = [];

    for (let index = 0; index < 4; index += 1) {
      const connection = createConnection(service, `disc-join-${index}`);
      const joinResult = (await execute(service, connection, {
        id: `join-${index}`,
        type: "room.join",
        roomId: "5555",
        payload: {
          userName: `掉线玩家${index + 2}`,
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

    await service.unregisterConnection(joined[0].connection.record.id);

    let snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(
      questioner.connection,
      "room.snapshot"
    );
    expect(snapshot?.status.pendingDisconnectPlayerId).toBe(joined[0].joinResult.playerId);

    await execute(service, questioner.connection, {
      id: "resolve-disconnect",
      type: "game.resolveDisconnect",
      payload: {
        playerId: joined[0].joinResult.playerId,
        resolution: "eliminate",
      },
    });

    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(questioner.connection, "room.snapshot");
    expect(snapshot?.status.pendingDisconnectPlayerId).toBeUndefined();
    expect(
      snapshot?.players.find((player) => player.id === joined[0].joinResult.playerId)?.membership
    ).toBe("kicked");
  });

  test("已提交描述的玩家掉线不暂停游戏，进入投票后才要求抉择", async () => {
    // 掉线暂停的意义是「不能没有这个人的操作」。已经交过描述的玩家掉线
    // 不影响本阶段推进，暂停只会白等；但到了需要他投票的阶段就必须补上。
    const { service } = createTestContext();
    const { host } = await createRoom(service, "5557");
    const joined: JoinedPlayer[] = [];

    for (let index = 0; index < 4; index += 1) {
      const connection = createConnection(service, `late-disc-${index}`);
      const joinResult = (await execute(service, connection, {
        id: `join-${index}`,
        type: "room.join",
        roomId: "5557",
        payload: { userName: `按需暂停${index + 2}` },
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

    // 全部参战玩家交完描述，其中一位随后掉线。
    for (const entry of [
      { connection: host, id: "host" },
      ...joined
        .slice(0, 3)
        .map((item, index) => ({ connection: item.connection, id: `p${index}` })),
    ]) {
      await execute(service, entry.connection, {
        id: `desc-${entry.id}`,
        type: "game.submitDescription",
        payload: { text: "一种常见的水果" },
      });
    }

    await service.unregisterConnection(joined[0].connection.record.id);

    // 描述已交齐，本阶段不需要他了，因此不该暂停。
    expect(
      getLastEventPayload<WhoIsFakerRoomSnapshot>(questioner.connection, "room.snapshot")?.status
        .pendingDisconnectPlayerId
    ).toBeUndefined();

    // 出题人得以正常推进到投票。
    await execute(service, questioner.connection, {
      id: "to-voting",
      type: "game.advancePhase",
      payload: {},
    });

    // 投票需要他，此时才要求出题人抉择。
    const voting = getLastEventPayload<WhoIsFakerRoomSnapshot>(
      questioner.connection,
      "room.snapshot"
    );
    expect(voting?.status.phase).toBe("voting");
    expect(voting?.status.pendingDisconnectPlayerId).toBe(joined[0].joinResult.playerId);
  });

  test("同阶段第二名掉线玩家在前一位被处理后仍会被要求抉择", async () => {
    // 按需暂停最危险的失败形态是死锁：推进因「仍有玩家未提交」被拒，
    // 却没有人被要求处理那次掉线。这里锁住「队列不会漏人」。
    const { service } = createTestContext();
    const { host } = await createRoom(service, "5560");
    const joined: JoinedPlayer[] = [];

    for (let index = 0; index < 4; index += 1) {
      const connection = createConnection(service, `dual-disc-${index}`);
      const joinResult = (await execute(service, connection, {
        id: `join-${index}`,
        type: "room.join",
        roomId: "5560",
        payload: { userName: `双掉线${index + 2}` },
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

    // 两名尚未发言的玩家同时掉线：都需要抉择，按顺序排队。
    await service.unregisterConnection(joined[0].connection.record.id);
    await service.unregisterConnection(joined[1].connection.record.id);

    const queued = getLastEventPayload<WhoIsFakerRoomSnapshot>(
      questioner.connection,
      "room.snapshot"
    );
    expect(queued?.status.pendingDisconnectPlayerId).toBe(joined[0].joinResult.playerId);

    // 处理掉第一位之后，第二位必须立刻浮出来，不能被漏掉。
    await execute(service, questioner.connection, {
      id: "resolve-first",
      type: "game.resolveDisconnect",
      payload: { playerId: joined[0].joinResult.playerId, resolution: "eliminate" },
    });

    expect(
      getLastEventPayload<WhoIsFakerRoomSnapshot>(questioner.connection, "room.snapshot")?.status
        .pendingDisconnectPlayerId
    ).toBe(joined[1].joinResult.playerId);
  });

  test("夜晚中途有人被淘汰后，其余玩家保留未受影响的夜晚动作", async () => {
    const { service } = createTestContext();
    const { host, result: hostResult } = await createRoom(service, "5556");
    const joined: JoinedPlayer[] = [];

    for (let index = 0; index < 5; index += 1) {
      const connection = createConnection(service, `night-reset-${index}`);
      const joinResult = (await execute(service, connection, {
        id: `join-${index}`,
        type: "room.join",
        roomId: "5556",
        payload: {
          userName: `夜晚重提${index + 2}`,
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
    const questioner = joined[4];
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

    const participantConnections = [
      host,
      joined[0].connection,
      joined[1].connection,
      joined[2].connection,
      joined[3].connection,
    ];
    const connectionByPlayerId = new Map<string, typeof host>([
      [hostResult.playerId, host],
      ...joined.map((item) => [item.joinResult.playerId, item.connection] as const),
    ]);

    for (const connection of participantConnections) {
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

    let questionerState = getLastEventPayload<WhoIsFakerPrivateState>(
      questioner.connection,
      "game.privateState"
    )!;
    const eliminatedCivilian = questionerState.questionerView?.find(
      (item) => item.role === "civilian"
    );
    const fallbackTarget = questionerState.questionerView?.find(
      (item) => item.playerId !== eliminatedCivilian?.playerId
    );

    expect(eliminatedCivilian).toBeDefined();
    expect(fallbackTarget).toBeDefined();

    for (const item of questionerState.questionerView ?? []) {
      const voterConnection = connectionByPlayerId.get(item.playerId)!;
      const targetId =
        item.playerId === eliminatedCivilian!.playerId
          ? fallbackTarget!.playerId
          : eliminatedCivilian!.playerId;
      await execute(service, voterConnection, {
        id: `vote-${item.playerId}`,
        type: "game.submitVote",
        payload: { targetId },
      });
    }

    await execute(service, questioner.connection, {
      id: "resolve-vote",
      type: "game.advancePhase",
      payload: {},
    });
    await execute(service, questioner.connection, {
      id: "continue-vote",
      type: "game.advancePhase",
      payload: {},
    });

    let snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(
      questioner.connection,
      "room.snapshot"
    );
    expect(snapshot?.status.phase).toBe("night");

    questionerState = getLastEventPayload<WhoIsFakerPrivateState>(
      questioner.connection,
      "game.privateState"
    )!;
    const aliveActors =
      questionerState.questionerView?.filter(
        (item) => item.alive && (item.role === "civilian" || item.role === "undercover")
      ) ?? [];

    expect(aliveActors.length).toBeGreaterThanOrEqual(3);

    const submittedActorId = aliveActors[0]!.playerId;
    const disconnectedActorId = aliveActors.at(-1)!.playerId;
    const submittedActorConnection = connectionByPlayerId.get(submittedActorId)!;
    const disconnectedActorConnection = connectionByPlayerId.get(disconnectedActorId)!;

    await execute(service, submittedActorConnection, {
      id: "night-submit-before-reset",
      type: "game.submitNightAction",
      payload: { targetId: null },
    });

    let privateState = getLastEventPayload<WhoIsFakerPrivateState>(
      submittedActorConnection,
      "game.privateState"
    );
    expect(privateState?.nightActionSubmitted).toBe(true);
    expect(privateState?.privilegedActionPreview).toBeUndefined();
    questionerState = getLastEventPayload<WhoIsFakerPrivateState>(
      questioner.connection,
      "game.privateState"
    )!;
    expect(
      questionerState.privilegedActionPreview?.nightActions.some(
        (action) => action.actorId === submittedActorId && action.targetId === undefined
      )
    ).toBe(true);

    await service.unregisterConnection(disconnectedActorConnection.record.id);

    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(questioner.connection, "room.snapshot");
    expect(snapshot?.status.pendingDisconnectPlayerId).toBe(disconnectedActorId);

    await execute(service, questioner.connection, {
      id: "resolve-night-disconnect",
      type: "game.resolveDisconnect",
      payload: {
        playerId: disconnectedActorId,
        resolution: "eliminate",
      },
    });

    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(questioner.connection, "room.snapshot");
    expect(snapshot?.status.phase).toBe("night");

    privateState = getLastEventPayload<WhoIsFakerPrivateState>(
      submittedActorConnection,
      "game.privateState"
    );
    expect(privateState?.nightActionSubmitted).toBe(true);

    questionerState = getLastEventPayload<WhoIsFakerPrivateState>(
      questioner.connection,
      "game.privateState"
    )!;
    const remainingActors =
      questionerState.questionerView?.filter(
        (item) => item.alive && (item.role === "civilian" || item.role === "undercover")
      ) ?? [];

    for (const actor of remainingActors) {
      const actorConnection = connectionByPlayerId.get(actor.playerId)!;
      await execute(service, actorConnection, {
        id: `night-resubmit-${actor.playerId}`,
        type: "game.submitNightAction",
        payload: { targetId: null },
      });
    }

    await execute(service, questioner.connection, {
      id: "resolve-night-after-reset",
      type: "game.advancePhase",
      payload: {},
    });

    // 天亮反馈只公开死者，不带凶手；继续后才进入下一天。
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(questioner.connection, "room.snapshot");
    expect(snapshot?.status.phase).toBe("feedback");
    expect(snapshot?.status.feedback).toMatchObject({ kind: "night", day: 1, next: "description" });
    expect(JSON.stringify(snapshot?.status.feedback)).not.toContain("actorId");
    expect(snapshot?.status.day).toBe(1);
    await execute(service, questioner.connection, {
      id: "continue-night",
      type: "game.advancePhase",
      payload: {},
    });
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(questioner.connection, "room.snapshot");
    expect(snapshot?.status.phase).toBe("description");
    expect(snapshot?.status.day).toBe(2);
    expect(getEventPayloads(questioner.connection, "game.daybreak")).toHaveLength(0);
  });

  test("掉线玩家只能通过 session token 恢复原席位", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "5560");
    const connection = createConnection(service, "rejoin-original");
    const joinResult = (await execute(service, connection, {
      id: "join-original",
      type: "room.join",
      roomId: "5560",
      payload: {
        userName: "回归玩家",
      },
    })) as { playerId: string; sessionToken: string };
    const filler: JoinedPlayer[] = [];

    for (let index = 0; index < 3; index += 1) {
      const extraConnection = createConnection(service, `rejoin-extra-${index}`);
      const extraJoin = (await execute(service, extraConnection, {
        id: `join-extra-${index}`,
        type: "room.join",
        roomId: "5560",
        payload: {
          userName: `补位玩家${index + 1}`,
        },
      })) as { playerId: string };
      filler.push({ connection: extraConnection, joinResult: extraJoin });
    }

    for (const readyConnection of [host, connection, ...filler.map((item) => item.connection)]) {
      await execute(service, readyConnection, {
        id: `ready-${readyConnection.record.id}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    }

    await execute(service, host, { id: "start", type: "game.advancePhase", payload: {} });
    const questioner = filler[2];
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

    await service.unregisterConnection(connection.record.id);

    let snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(
      questioner.connection,
      "room.snapshot"
    );
    expect(snapshot?.status.pendingDisconnectPlayerId).toBe(joinResult.playerId);

    const takeover = createConnection(service, "rejoin-takeover");
    let takeoverErrorCode: string | undefined;

    try {
      await execute(service, takeover, {
        id: "join-same-name",
        type: "room.join",
        roomId: "5560",
        payload: {
          userName: "回归玩家",
        },
      });
    } catch (error) {
      takeoverErrorCode = (error as { code?: string }).code;
    }

    expect(takeoverErrorCode).toBe("NAME_CONFLICT");

    const reconnect = createConnection(service, "rejoin-new");
    const reclaimed = (await execute(service, reconnect, {
      id: "reconnect-with-token",
      type: "room.reconnect",
      payload: {
        roomId: "5560",
        sessionToken: joinResult.sessionToken,
      },
    })) as { playerId: string; sessionToken: string };

    expect(reclaimed.playerId).toBe(joinResult.playerId);
    expect(reclaimed.sessionToken).toBe(joinResult.sessionToken);

    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(questioner.connection, "room.snapshot");
    expect(snapshot?.status.pendingDisconnectPlayerId).toBeUndefined();

    const privateState = getLastEventPayload<WhoIsFakerPrivateState>(
      reconnect,
      "game.privateState"
    );
    expect(privateState?.word).toBeDefined();
  });

  test("同一 session token 的新连接会替换旧连接", async () => {
    const { service } = createTestContext();
    const { host, result } = await createRoom(service, "5561");
    const replacement = createConnection(service, "replacement");

    const reconnected = (await execute(service, replacement, {
      id: "replace-session",
      type: "room.reconnect",
      payload: {
        roomId: "5561",
        sessionToken: result.sessionToken,
      },
    })) as { playerId: string; sessionToken: string };

    expect(reconnected.playerId).toBe(result.playerId);
    expect(reconnected.sessionToken).toBe(result.sessionToken);
    expect(getLastEventPayload<{ roomId: string }>(host, "session.replaced")).toEqual({
      roomId: "5561",
    });
    expect(host.closed).toEqual([{ code: 4001, reason: "session_replaced" }]);
    expect(host.record.roomId).toBeUndefined();
    expect(host.record.playerId).toBeUndefined();
    expect(replacement.record.roomId).toBe("5561");
    expect(replacement.record.playerId).toBe(result.playerId);
  });

  test("预分配阶段的多名掉线玩家会按顺序进入待处理队列", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "5566");
    const joined: JoinedPlayer[] = [];

    for (let index = 0; index < 6; index += 1) {
      const connection = createConnection(service, `queue-join-${index}`);
      const joinResult = (await execute(service, connection, {
        id: `queue-join-${index}`,
        type: "room.join",
        roomId: "5566",
        payload: {
          userName: `排队玩家${index + 2}`,
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
    await service.unregisterConnection(joined[0].connection.record.id);
    await service.unregisterConnection(joined[1].connection.record.id);

    const questioner = joined[5];
    await execute(service, host, {
      id: "assign",
      type: "game.assignQuestioner",
      payload: { playerId: questioner.joinResult.playerId },
    });

    let snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(
      questioner.connection,
      "room.snapshot"
    );
    expect(snapshot?.status.pendingDisconnectPlayerId).toBe(joined[0].joinResult.playerId);

    await execute(service, questioner.connection, {
      id: "resolve-1",
      type: "game.resolveDisconnect",
      payload: {
        playerId: joined[0].joinResult.playerId,
        resolution: "eliminate",
      },
    });

    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(questioner.connection, "room.snapshot");
    expect(snapshot?.status.pendingDisconnectPlayerId).toBe(joined[1].joinResult.playerId);

    await execute(service, questioner.connection, {
      id: "resolve-2",
      type: "game.resolveDisconnect",
      payload: {
        playerId: joined[1].joinResult.playerId,
        resolution: "eliminate",
      },
    });

    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(questioner.connection, "room.snapshot");
    expect(snapshot?.status.pendingDisconnectPlayerId).toBeUndefined();

    await execute(service, questioner.connection, {
      id: "words",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });

    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(questioner.connection, "room.snapshot");
    expect(snapshot?.status.phase).toBe("description");
  });
});
