import { expect, test } from "bun:test";

import type { PrivateState, RoomSnapshot } from "../src/domain/model";
import { createConnection, createTestContext, execute, getEventPayloads, getLastEventPayload } from "./helpers";

interface JoinedPlayer {
  connection: ReturnType<typeof createConnection>;
  joinResult: { playerId: string };
}

// 统一封装建房，减少每个场景重复准备样板代码。
const createRoom = async (
  service: ReturnType<typeof createTestContext>["service"],
  roomId: string,
  userName = "房主",
) => {
  const host = createConnection(service, `${roomId}-host`);
  const result = (await execute(service, host, {
    id: `${roomId}-create`,
    type: "room.create",
    payload: {
      roomId,
      name: `${roomId}-房间`,
      visibility: "public",
      allowSpectators: true,
      userName,
    },
  })) as { roomId: string; playerId: string; sessionToken: string };

  return { host, result };
};

// ==================== 房间与状态机集成测试 ====================

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
  expect(getLastEventPayload<RoomSnapshot>(host, "room.snapshot")?.roomId).toBe("1111");
});

test("常规流程可以完整进入好人胜利结算", async () => {
  // 这个场景覆盖：建房 -> 开局 -> 指定出题人 -> 提交词语 -> 描述 -> 投票 -> 结算。
  const { service } = createTestContext();
  const { host, result: hostResult } = await createRoom(service, "2222");
  const joined: JoinedPlayer[] = [];

  for (let index = 0; index < 4; index += 1) {
    const connection = createConnection(service, `join-${index}`);
    const joinResult = (await execute(service, connection, {
      id: `join-${index}`,
      type: "room.join",
      roomId: "2222",
      payload: {
        userName: `玩家${index + 2}`,
      },
    })) as { playerId: string };
    joined.push({ connection, joinResult });
  }

  for (const connection of [host, ...joined.map((item) => item.connection)]) {
    await execute(service, connection, {
      id: `ready-${connection.record.id}`,
      type: "player.setReady",
      payload: {
        ready: true,
      },
    });
  }

  await execute(service, host, {
    id: "start",
    type: "game.advancePhase",
    payload: {},
  });

  const questioner = joined[3];

  await execute(service, host, {
    id: "assign",
    type: "game.assignQuestioner",
    payload: {
      playerId: questioner.joinResult.playerId,
    },
  });

  await execute(service, questioner.connection, {
    id: "words",
    type: "game.submitWords",
    payload: {
      words: ["苹果", "香蕉"],
    },
  });

  for (const connection of [host, joined[0].connection, joined[1].connection, joined[2].connection]) {
    await execute(service, connection, {
      id: `desc-${connection.record.id}`,
      type: "game.submitDescription",
      payload: {
        text: `${connection.record.id} 的描述`,
      },
    });
  }

  await execute(service, questioner.connection, {
    id: "to-vote",
    type: "game.advancePhase",
    payload: {},
  });

  await execute(service, host, {
    id: "vote-host",
    type: "game.submitVote",
    payload: {
      targetId: joined[0].joinResult.playerId,
    },
  });
  for (const connection of [joined[0].connection, joined[1].connection, joined[2].connection]) {
    await execute(service, connection, {
      id: `vote-${connection.record.id}`,
      type: "game.submitVote",
      payload: {
        targetId: hostResult.playerId,
      },
    });
  }

  await execute(service, questioner.connection, {
    id: "resolve-vote",
    type: "game.advancePhase",
    payload: {},
  });

  const snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(snapshot?.status.phase).toBe("gameOver");
  expect(snapshot?.summary?.winner).toBe("good");
  expect(snapshot?.players.find((player) => player.id === hostResult.playerId)?.score).toBe(0);
  expect(
    snapshot?.players.find((player) => player.id === joined[0].joinResult.playerId)?.score,
  ).toBe(1);
});

test("平票会进入 tieBreak 并在第二轮后进入夜晚阶段", async () => {
  // 这个场景验证 tieBreak 的两段式流程：补充描述 + 第二轮投票。
  const { service } = createTestContext();
  const { host, result: hostResult } = await createRoom(service, "3333");
  const joined: JoinedPlayer[] = [];

  for (let index = 0; index < 4; index += 1) {
    const connection = createConnection(service, `tie-join-${index}`);
    const joinResult = (await execute(service, connection, {
      id: `join-${index}`,
      type: "room.join",
      roomId: "3333",
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
  const connectionByPlayerId = new Map<string, typeof host>([
    [hostResult.playerId, host],
    ...joined.map((item) => [item.joinResult.playerId, item.connection] as const),
  ]);
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

  for (const connection of [host, joined[0].connection, joined[1].connection, joined[2].connection]) {
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

  let snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(snapshot?.status.phase).toBe("tieBreak");
  expect(snapshot?.status.tieBreakStage).toBe("description");

  const leaders = getEventPayloads<{ leaders: string[] }>(host, "game.voteResult").at(-1)
    ?.leaders;
  expect(leaders).toHaveLength(2);

  for (const candidateId of leaders ?? []) {
    await execute(service, connectionByPlayerId.get(candidateId)!, {
      id: `tie-desc-${candidateId}`,
      type: "game.submitDescription",
      payload: { text: "补充描述" },
    });
  }

  await execute(service, questioner.connection, {
    id: "to-tie-vote",
    type: "game.advancePhase",
    payload: {},
  });

  snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(snapshot?.status.tieBreakStage).toBe("vote");

  await execute(service, host, {
    id: "tie-vote-host",
    type: "game.submitVote",
    payload: { targetId: joined[0].joinResult.playerId },
  });
  await execute(service, joined[2].connection, {
    id: "tie-vote-2",
    type: "game.submitVote",
    payload: { targetId: joined[0].joinResult.playerId },
  });

  await execute(service, questioner.connection, {
    id: "resolve-2",
    type: "game.advancePhase",
    payload: {},
  });

  snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(snapshot?.status.phase).toBe("night");
});

test("白板被淘汰后可以触发 blankGuess 并独立获胜", async () => {
  // 这个场景覆盖“白板被淘汰后进入被动猜词并独赢”的特殊规则。
  const { service } = createTestContext();
  const { host, result: hostResult } = await createRoom(service, "4444");
  const joined: JoinedPlayer[] = [];

  for (let index = 0; index < 8; index += 1) {
    const connection = createConnection(service, `blank-join-${index}`);
    const joinResult = (await execute(service, connection, {
      id: `join-${index}`,
      type: "room.join",
      roomId: "4444",
      payload: {
        userName: `白板玩家${index + 2}`,
      },
    })) as { playerId: string };
    joined.push({ connection, joinResult });
  }

  await execute(service, host, {
    id: "settings",
    type: "room.updateSettings",
    payload: {
      roleConfig: {
        undercoverCount: 1,
        hasAngel: false,
        hasBlank: true,
      },
    },
  });

  for (const connection of [host, ...joined.map((item) => item.connection)]) {
    await execute(service, connection, {
      id: `ready-${connection.record.id}`,
      type: "player.setReady",
      payload: { ready: true },
    });
  }

  await execute(service, host, { id: "start", type: "game.advancePhase", payload: {} });
  const questioner = joined[7];
  await execute(service, host, {
    id: "assign",
    type: "game.assignQuestioner",
    payload: { playerId: questioner.joinResult.playerId },
  });
  await execute(service, questioner.connection, {
    id: "words",
    type: "game.submitWords",
    payload: { words: ["苹果", "香蕉"], blankHint: "水果" },
  });

  for (const connection of [host, ...joined.slice(0, 7).map((item) => item.connection)]) {
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

  await execute(service, host, {
    id: "vote-host",
    type: "game.submitVote",
    payload: { targetId: joined[0].joinResult.playerId },
  });
  for (const connection of joined.slice(0, 7).map((item) => item.connection)) {
    await execute(service, connection, {
      id: `vote-${connection.record.id}`,
      type: "game.submitVote",
      payload: { targetId: hostResult.playerId },
    });
  }

  await execute(service, questioner.connection, {
    id: "resolve",
    type: "game.advancePhase",
    payload: {},
  });

  let snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(snapshot?.status.phase).toBe("blankGuess");

  await execute(service, host, {
    id: "guess",
    type: "game.submitBlankGuess",
    payload: { words: ["香蕉", "苹果"] },
  });

  snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(snapshot?.summary?.winner).toBe("blank");
  expect(snapshot?.players.find((player) => player.id === hostResult.playerId)?.score).toBe(2);
});

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

  let snapshot = getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot");
  expect(snapshot?.status.pendingDisconnectPlayerId).toBe(joined[0].joinResult.playerId);

  await execute(service, questioner.connection, {
    id: "resolve-disconnect",
    type: "game.resolveDisconnect",
    payload: {
      playerId: joined[0].joinResult.playerId,
      resolution: "eliminate",
    },
  });

  snapshot = getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot");
  expect(snapshot?.status.pendingDisconnectPlayerId).toBeUndefined();
  expect(
    snapshot?.players.find((player) => player.id === joined[0].joinResult.playerId)?.membership,
  ).toBe("kicked");
});

test("掉线玩家可以通过同名重新加入恢复原席位", async () => {
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

  let snapshot = getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot");
  expect(snapshot?.status.pendingDisconnectPlayerId).toBe(joinResult.playerId);

  const reconnect = createConnection(service, "rejoin-new");
  const reclaimed = (await execute(service, reconnect, {
    id: "join-same-name",
    type: "room.join",
    roomId: "5560",
    payload: {
      userName: "回归玩家",
    },
  })) as { playerId: string; sessionToken: string };

  expect(reclaimed.playerId).toBe(joinResult.playerId);
  expect(reclaimed.sessionToken).not.toBe(joinResult.sessionToken);

  snapshot = getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot");
  expect(snapshot?.status.pendingDisconnectPlayerId).toBeUndefined();

  const privateState = getLastEventPayload<PrivateState>(reconnect, "game.privateState");
  expect(privateState?.word).toBeDefined();
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

  let snapshot = getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot");
  expect(snapshot?.status.pendingDisconnectPlayerId).toBe(joined[0].joinResult.playerId);

  await execute(service, questioner.connection, {
    id: "resolve-1",
    type: "game.resolveDisconnect",
    payload: {
      playerId: joined[0].joinResult.playerId,
      resolution: "eliminate",
    },
  });

  snapshot = getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot");
  expect(snapshot?.status.pendingDisconnectPlayerId).toBe(joined[1].joinResult.playerId);

  await execute(service, questioner.connection, {
    id: "resolve-2",
    type: "game.resolveDisconnect",
    payload: {
      playerId: joined[1].joinResult.playerId,
      resolution: "eliminate",
    },
  });

  snapshot = getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot");
  expect(snapshot?.status.pendingDisconnectPlayerId).toBeUndefined();

  await execute(service, questioner.connection, {
    id: "words",
    type: "game.submitWords",
    payload: { words: ["苹果", "香蕉"] },
  });

  snapshot = getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot");
  expect(snapshot?.status.phase).toBe("description");
});

test("4 名正式玩家且无旁观者时不能开始游戏", async () => {
  const { service } = createTestContext();
  const { host } = await createRoom(service, "5656");

  for (let index = 0; index < 3; index += 1) {
    const connection = createConnection(service, `min-join-${index}`);
    await execute(service, connection, {
      id: `min-join-${index}`,
      type: "room.join",
      roomId: "5656",
      payload: {
        userName: `最小玩家${index + 2}`,
      },
    });
    await execute(service, connection, {
      id: `min-ready-${index}`,
      type: "player.setReady",
      payload: { ready: true },
    });
  }

  await execute(service, host, {
    id: "host-ready",
    type: "player.setReady",
    payload: { ready: true },
  });

  let errorCode: string | undefined;
  try {
    await execute(service, host, {
      id: "start",
      type: "game.advancePhase",
      payload: {},
    });
  } catch (error) {
    errorCode = (error as { code?: string }).code;
  }

  expect(errorCode).toBe("INSUFFICIENT_PLAYERS");
});

test("旁观者不会阻塞准备且可以作为 4 名正式玩家房间的出题人", async () => {
  const { service } = createTestContext();
  const { host } = await createRoom(service, "5757");
  const joined: JoinedPlayer[] = [];

  for (let index = 0; index < 4; index += 1) {
    const connection = createConnection(service, `spec-join-${index}`);
    const joinResult = (await execute(service, connection, {
      id: `spec-join-${index}`,
      type: "room.join",
      roomId: "5757",
      payload: {
        userName: `旁观测试${index + 2}`,
      },
    })) as { playerId: string };
    joined.push({ connection, joinResult });
  }

  await execute(service, joined[3].connection, {
    id: "set-spectator",
    type: "player.setSpectator",
    payload: { spectator: true },
  });

  for (const connection of [host, joined[0].connection, joined[1].connection, joined[2].connection]) {
    await execute(service, connection, {
      id: `ready-${connection.record.id}`,
      type: "player.setReady",
      payload: { ready: true },
    });
  }

  await execute(service, host, { id: "start", type: "game.advancePhase", payload: {} });
  await execute(service, host, {
    id: "assign-spectator",
    type: "game.assignQuestioner",
    payload: { playerId: joined[3].joinResult.playerId },
  });

  const snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(snapshot?.status.phase).toBe("wordSubmission");
  expect(snapshot?.status.questionerPlayerId).toBe(joined[3].joinResult.playerId);
});

test("旁观者在局内可以看到所有玩家身份", async () => {
  const { service } = createTestContext();
  const { host } = await createRoom(service, "5858");
  const joined: JoinedPlayer[] = [];

  for (let index = 0; index < 5; index += 1) {
    const connection = createConnection(service, `view-join-${index}`);
    const joinResult = (await execute(service, connection, {
      id: `view-join-${index}`,
      type: "room.join",
      roomId: "5858",
      payload: {
        userName: `身份视图${index + 2}`,
      },
    })) as { playerId: string };
    joined.push({ connection, joinResult });
  }

  const spectator = joined[4];
  await execute(service, spectator.connection, {
    id: "set-spectator",
    type: "player.setSpectator",
    payload: { spectator: true },
  });

  for (const connection of [host, ...joined.slice(0, 4).map((item) => item.connection)]) {
    await execute(service, connection, {
      id: `ready-${connection.record.id}`,
      type: "player.setReady",
      payload: { ready: true },
    });
  }

  await execute(service, host, { id: "start", type: "game.advancePhase", payload: {} });
  await execute(service, host, {
    id: "assign",
    type: "game.assignQuestioner",
    payload: { playerId: joined[3].joinResult.playerId },
  });
  await execute(service, joined[3].connection, {
    id: "words",
    type: "game.submitWords",
    payload: { words: ["苹果", "香蕉"] },
  });

  const privateState = getLastEventPayload<PrivateState>(spectator.connection, "game.privateState");
  expect(privateState?.isQuestioner).toBe(false);
  expect(privateState?.questionerView).toHaveLength(4);
  expect(privateState?.questionerView?.every((entry) => entry.role != null)).toBe(true);
});

test("天使只会看到无标签候选词，不会直接知道自己的身份词", async () => {
  const { service } = createTestContext();
  const { host } = await createRoom(service, "5959");
  const joined: JoinedPlayer[] = [];

  for (let index = 0; index < 10; index += 1) {
    const connection = createConnection(service, `angel-join-${index}`);
    const joinResult = (await execute(service, connection, {
      id: `angel-join-${index}`,
      type: "room.join",
      roomId: "5959",
      payload: {
        userName: `天使测试${index + 2}`,
      },
    })) as { playerId: string };
    joined.push({ connection, joinResult });
  }

  await execute(service, host, {
    id: "settings",
    type: "room.updateSettings",
    payload: {
      roleConfig: {
        undercoverCount: 1,
        hasAngel: true,
        hasBlank: false,
      },
    },
  });

  for (const connection of [host, ...joined.map((item) => item.connection)]) {
    await execute(service, connection, {
      id: `ready-${connection.record.id}`,
      type: "player.setReady",
      payload: { ready: true },
    });
  }

  await execute(service, host, { id: "start", type: "game.advancePhase", payload: {} });
  const questioner = joined[9];
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

  const angelConnection = [host, ...joined.map((item) => item.connection)].find((connection) => {
    const privateState = getLastEventPayload<PrivateState>(connection, "game.privateState");
    return privateState?.role === "angel";
  });
  const angelPrivateState = angelConnection
    ? getLastEventPayload<PrivateState>(angelConnection, "game.privateState")
    : undefined;

  expect(angelPrivateState?.angelWordOptions).toEqual(["苹果", "香蕉"]);
  expect(angelPrivateState?.word).toBeUndefined();
});

test("游戏进行中房主不能踢人，结算后踢人不会重复结算分数", async () => {
  const { service } = createTestContext();
  const { host, result: hostResult } = await createRoom(service, "Oblivionis");
  const extra = createConnection(service, "Oblivionis-review-extra");
  const extraJoin = (await execute(service, extra, {
    id: "extra-join",
    type: "room.join",
    roomId: "Oblivionis",
    payload: { userName: "复查玩家" },
  })) as { playerId: string };

  await execute(service, host, {
    id: "jump-voting",
    type: "test.jumpToPhase",
    payload: { phase: "voting" },
  });

  let errorCode: string | undefined;
  try {
    await execute(service, host, {
      id: "kick-active",
      type: "room.kick",
      payload: { playerId: extraJoin.playerId },
    });
  } catch (error) {
    errorCode = (error as { code?: string }).code;
  }

  expect(errorCode).toBe("ROUND_ACTIVE");

  await execute(service, host, {
    id: "jump-game-over",
    type: "test.jumpToPhase",
    payload: { phase: "gameOver" },
  });

  const before = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  const scoresBefore = new Map(before?.players.map((player) => [player.id, player.score]));

  await execute(service, host, {
    id: "kick-after-game-over",
    type: "room.kick",
    payload: { playerId: extraJoin.playerId },
  });

  const after = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(after?.status.phase).toBe("gameOver");
  expect(after?.players.find((player) => player.id === hostResult.playerId)?.score).toBe(
    scoresBefore.get(hostResult.playerId),
  );
});

test("Oblivionis 测试房间不含机器人、不进大厅、不自动清理", async () => {
  // 新版测试模式改为手动跳转阶段；服务端不再注入 Bot、不入大厅列表、housekeeping 不清理。
  const { service, advanceTime } = createTestContext();
  const { host } = await createRoom(service, "Oblivionis");

  const snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(snapshot?.players.filter((player) => player.isBot)).toHaveLength(0);

  // 测试房间不应出现在大厅摘要里。
  expect(service.getRoomSummaries().find((item) => item.roomId === "Oblivionis"))
    .toBeUndefined();

  // 闲置超时后也不应被清理。
  advanceTime(30 * 60 * 1000);
  await service.runHousekeeping();
  const afterSnapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(afterSnapshot?.roomId).toBe("Oblivionis");
});

test("测试房间支持单人通过 test.jumpToPhase 直接切换阶段", async () => {
  // 单人测试房间也应能直接预填分配，方便逐个阶段验收 UI。
  const { service } = createTestContext();
  const { host } = await createRoom(service, "Oblivionis");

  await execute(service, host, {
    id: "jump-voting",
    type: "test.jumpToPhase",
    payload: { phase: "voting" },
  });

  const snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  const privateState = getLastEventPayload<PrivateState>(host, "game.privateState");
  expect(snapshot?.status.phase).toBe("voting");
  expect(snapshot?.players.find((player) => player.id === privateState?.playerId)?.roundStatus).toBe(
    "alive",
  );
  expect(privateState?.role).toBeDefined();
});

test("测试房间单人时可以指定自己为出题人并提交词语进入描述阶段", async () => {
  const { service } = createTestContext();
  const { host, result } = await createRoom(service, "Oblivionis");

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

  const snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  const privateState = getLastEventPayload<PrivateState>(host, "game.privateState");
  expect(snapshot?.status.phase).toBe("description");
  expect(snapshot?.status.questionerPlayerId).toBeUndefined();
  expect(snapshot?.players.find((player) => player.id === result.playerId)?.roundStatus).toBe(
    "alive",
  );
  expect(privateState?.isQuestioner).toBe(false);
  expect(privateState?.word).toBeDefined();
});

test("房间会在无人在线或闲置超时后被清理", async () => {
  // 这里同时验证“空房立即清理”和“闲置超时清理”两条房间生命周期规则。
  const { service, advanceTime } = createTestContext();
  const { host } = await createRoom(service, "6666");

  await service.unregisterConnection(host.record.id);
  expect(service.getRoomSummaries()).toHaveLength(0);

  const next = await createRoom(service, "7777");
  advanceTime(10 * 60 * 1000 + 1);
  await service.runHousekeeping();

  const closed = getLastEventPayload<{ roomId: string; reason: string }>(
    next.host,
    "room.closed",
  );
  expect(closed?.reason).toBe("idle_timeout");
  expect(service.getRoomSummaries()).toHaveLength(0);
});

test("服务关闭通知会广播到所有连接", () => {
  const { service } = createTestContext();
  const connection = createConnection(service, "shutdown");

  service.notifyShutdown();

  expect(getLastEventPayload<{ message: string }>(connection, "server.shutdown")?.message).toContain(
    "服务器即将关闭",
  );
});
