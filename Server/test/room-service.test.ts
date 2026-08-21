import { expect, test } from "bun:test";

import {
  PHASE_RESULT_DISPLAY_MS,
  ROOM_EMPTY_GRACE_PERIOD_MS,
} from "../src/config/constants";
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

const joinPlayers = async (
  service: ReturnType<typeof createTestContext>["service"],
  roomId: string,
  count: number,
  prefix: string,
): Promise<JoinedPlayer[]> => {
  const joined: JoinedPlayer[] = [];
  for (let index = 0; index < count; index += 1) {
    const connection = createConnection(service, `${roomId}-${prefix}-${index}`);
    const joinResult = (await execute(service, connection, {
      id: `${prefix}-join-${index}`,
      type: "room.join",
      roomId,
      payload: { userName: `${prefix}${index + 1}` },
    })) as { playerId: string };
    joined.push({ connection, joinResult });
  }
  return joined;
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

  const snapshot = getLastEventPayload<RoomSnapshot>(guest, "room.snapshot");
  expect(snapshot?.visibility).toBe("private");
  expect(snapshot?.hasPassword).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain("new-password");
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
    getLastEventPayload<RoomSnapshot>(host, "room.snapshot")?.players.find(
      (player) => player.id === result.playerId,
    )?.name,
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
    getLastEventPayload<RoomSnapshot>(host, "room.snapshot")?.players.find(
      (player) => player.id === host.record.playerId,
    )?.name,
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

  const snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  const player = snapshot?.players.find((entry) => entry.id === joined[6].joinResult.playerId);
  expect(player?.membership).toBe("spectator");
  expect(player?.isReady).toBe(false);
  expect(snapshot?.roleLimits.canEnableBlank).toBe(false);
  expect(snapshot?.settings.roleConfig.hasBlank).toBe(false);
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

test("正式房间提前提交的描述只按发言顺序公开", async () => {
  const { service } = createTestContext();
  const { host, result: hostResult } = await createRoom(service, "1616");
  const joined = await joinPlayers(service, "1616", 4, "顺序玩家");
  const allConnections = [host, ...joined.map((item) => item.connection)];

  for (const connection of allConnections) {
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

  const connectionByPlayerId = new Map<string, typeof host>([
    [hostResult.playerId, host],
    ...joined.map((item) => [item.joinResult.playerId, item.connection] as const),
  ]);
  let snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot")!;
  const order = snapshot.status.speechOrder ?? [];
  expect(order).toEqual(snapshot.status.descriptionOrder ?? []);
  expect(order).toHaveLength(4);

  await execute(service, connectionByPlayerId.get(order[1])!, {
    id: "submit-second-first",
    type: "game.submitDescription",
    payload: { text: "第二位提前提交" },
  });

  snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot")!;
  expect(snapshot.status.submittedSpeechPlayerIds).toEqual([order[1]]);
  expect(snapshot.descriptions).toEqual([]);

  await execute(service, connectionByPlayerId.get(order[0])!, {
    id: "submit-first-after",
    type: "game.submitDescription",
    payload: { text: "第一位随后提交" },
  });

  snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot")!;
  expect(snapshot.descriptions.map((description) => description.playerId)).toEqual([
    order[0],
    order[1],
  ]);
  expect(snapshot.descriptions.map((description) => description.text)).toEqual([
    "第一位随后提交",
    "第二位提前提交",
  ]);
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

  expect(getLastEventPayload<RoomSnapshot>(host, "room.snapshot")?.chat.at(-1)?.text).toBe(
    "已进入第 1 天描述阶段",
  );

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
  expect(getLastEventPayload<RoomSnapshot>(host, "room.snapshot")?.chat.at(-1)?.text).toBe(
    "已进入投票阶段",
  );

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
    id: "request-supplement-during-vote",
    type: "game.requestSupplement",
    payload: {
      playerIds: [joined[1].joinResult.playerId, joined[2].joinResult.playerId],
    },
  });
  let questionerState = getLastEventPayload<PrivateState>(
    questioner.connection,
    "game.privateState",
  );
  let supplementSnapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(supplementSnapshot?.status.phase).toBe("description");
  expect(supplementSnapshot?.status.speechMode).toBe("supplement");
  expect(supplementSnapshot?.status.supplementIndex).toBe(1);
  expect(questionerState?.privilegedActionPreview?.votes).toHaveLength(4);

  let supplementBlockCode: string | undefined;
  try {
    await execute(service, questioner.connection, {
      id: "resolve-before-supplement",
      type: "game.advancePhase",
      payload: {},
    });
  } catch (error) {
    supplementBlockCode = (error as { code?: string }).code;
  }
  expect(supplementBlockCode).toBe("PHASE_INCOMPLETE");

  await execute(service, joined[2].connection, {
    id: "submit-later-supplement-first",
    type: "game.submitDescription",
    payload: { text: "后序玩家提前补充" },
  });
  supplementSnapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(supplementSnapshot?.status.phase).toBe("description");
  expect(supplementSnapshot?.status.submittedSpeechPlayerIds).toEqual([
    joined[2].joinResult.playerId,
  ]);
  expect(
    supplementSnapshot?.descriptions.some(
      (description) => description.kind === "supplement",
    ),
  ).toBe(false);

  await execute(service, joined[1].connection, {
    id: "submit-earlier-supplement-after",
    type: "game.submitDescription",
    payload: { text: "前序玩家随后补充" },
  });
  questionerState = getLastEventPayload<PrivateState>(
    questioner.connection,
    "game.privateState",
  );
  supplementSnapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(supplementSnapshot?.status.phase).toBe("voting");
  expect(supplementSnapshot?.status.speechMode).toBeUndefined();
  expect(supplementSnapshot?.status.supplementIndex).toBeUndefined();
  expect(questionerState?.privilegedActionPreview?.votes).toHaveLength(4);
  expect(
    getLastEventPayload<RoomSnapshot>(host, "room.snapshot")?.descriptions.at(-1)?.kind,
  ).toBe("supplement");

  const snapshotsBeforeResolution = getEventPayloads<RoomSnapshot>(host, "room.snapshot").length;
  await execute(service, questioner.connection, {
    id: "resolve-vote",
    type: "game.advancePhase",
    payload: {},
  });

  const resolutionSnapshots = getEventPayloads<RoomSnapshot>(host, "room.snapshot").slice(
    snapshotsBeforeResolution,
  );
  const eliminationSnapshot = resolutionSnapshots.find(
    (item) => item.status.phase === "voting",
  );
  const snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(eliminationSnapshot?.players.find((player) => player.id === hostResult.playerId)?.roundStatus)
    .toBe("dead");
  expect(snapshot?.status.phase).toBe("gameOver");
  expect(snapshot?.summary?.winner).toBe("good");
  expect(snapshot?.summary?.words?.civilianWord).toBeTruthy();
  expect(snapshot?.summary?.words?.undercoverWord).toBeTruthy();
  expect(snapshot?.summary?.voteHistory).toHaveLength(1);
  expect(snapshot?.summary?.voteHistory?.[0]?.votes).toHaveLength(4);
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
  expect(snapshot?.status.tieBreakIndex).toBe(1);
  expect([...(snapshot?.status.tieBreakCandidateIds ?? [])].sort()).toEqual(
    [...(leaders ?? [])].sort(),
  );

  const tieOrder = snapshot?.status.speechOrder ?? [];
  expect(tieOrder).toEqual(snapshot?.status.tieBreakCandidateIds ?? []);
  await execute(service, connectionByPlayerId.get(tieOrder[1])!, {
    id: "tie-desc-second-first",
    type: "game.submitDescription",
    payload: { text: "第二位提前 PK 描述" },
  });
  snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(snapshot?.descriptions.some((description) => description.kind === "tieBreak")).toBe(
    false,
  );

  await execute(service, connectionByPlayerId.get(tieOrder[0])!, {
    id: "tie-desc-first-after",
    type: "game.submitDescription",
    payload: { text: "第一位随后 PK 描述" },
  });
  snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(
    snapshot?.descriptions
      .filter((description) => description.kind === "tieBreak")
      .map((description) => description.playerId),
  ).toEqual(tieOrder);

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

test("白板被淘汰后不能再主动发起猜词", async () => {
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

  const firstDescriptionSnapshot = getLastEventPayload<RoomSnapshot>(
    questioner.connection,
    "room.snapshot",
  )!;
  const firstQuestionerState = getLastEventPayload<PrivateState>(
    questioner.connection,
    "game.privateState",
  )!;
  const blankPlayerId = firstQuestionerState.questionerView?.find(
    (item) => item.role === "blank",
  )?.playerId;
  const descriptionOrder = firstDescriptionSnapshot.status.descriptionOrder ?? [];

  expect(descriptionOrder).toHaveLength(8);
  expect(new Set(descriptionOrder).size).toBe(8);
  expect(descriptionOrder.indexOf(blankPlayerId!)).toBeGreaterThanOrEqual(
    Math.floor(descriptionOrder.length / 2),
  );

  const participants = [
    { connection: host, playerId: hostResult.playerId },
    ...joined.slice(0, 7).map((item) => ({
      connection: item.connection,
      playerId: item.joinResult.playerId,
    })),
  ];
  const blankPlayer = participants.find((item) => item.playerId === blankPlayerId)!;
  const fallbackTargetId = participants.find((item) => item.playerId !== blankPlayerId)!.playerId;

  for (const participant of participants) {
    await execute(service, participant.connection, {
      id: `desc-${participant.connection.record.id}`,
      type: "game.submitDescription",
      payload: { text: "描述" },
    });
  }

  await execute(service, questioner.connection, {
    id: "to-vote",
    type: "game.advancePhase",
    payload: {},
  });

  for (const participant of participants) {
    await execute(service, participant.connection, {
      id: `vote-${participant.connection.record.id}`,
      type: "game.submitVote",
      payload: {
        targetId: participant.playerId === blankPlayerId ? fallbackTargetId : blankPlayerId!,
      },
    });
  }

  await execute(service, questioner.connection, {
    id: "resolve",
    type: "game.advancePhase",
    payload: {},
  });

  let snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  const blankPrivateState = getLastEventPayload<PrivateState>(
    blankPlayer.connection,
    "game.privateState",
  );
  expect(snapshot?.status.phase).toBe("night");
  expect(snapshot?.players.find((item) => item.id === blankPlayerId)?.roundStatus).toBe("dead");
  expect(blankPrivateState?.canSubmitBlankGuess).toBe(false);

  let errorCode: string | undefined;
  try {
    await execute(service, blankPlayer.connection, {
      id: "enter-guess",
      type: "game.enterBlankGuess",
      payload: {},
    });
  } catch (error) {
    errorCode = (error as { code?: string }).code;
  }
  expect(errorCode).toBe("ACTION_FORBIDDEN");
  snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(snapshot?.status.phase).toBe("night");
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
    ...joined.slice(0, 3).map((item, index) => ({ connection: item.connection, id: `p${index}` })),
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
    getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot")?.status
      .pendingDisconnectPlayerId,
  ).toBeUndefined();

  // 出题人得以正常推进到投票。
  await execute(service, questioner.connection, {
    id: "to-voting",
    type: "game.advancePhase",
    payload: {},
  });

  // 投票需要他，此时才要求出题人抉择。
  const voting = getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot");
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

  const queued = getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot");
  expect(queued?.status.pendingDisconnectPlayerId).toBe(joined[0].joinResult.playerId);

  // 处理掉第一位之后，第二位必须立刻浮出来，不能被漏掉。
  await execute(service, questioner.connection, {
    id: "resolve-first",
    type: "game.resolveDisconnect",
    payload: { playerId: joined[0].joinResult.playerId, resolution: "eliminate" },
  });

  expect(
    getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot")?.status
      .pendingDisconnectPlayerId,
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

  let questionerState = getLastEventPayload<PrivateState>(
    questioner.connection,
    "game.privateState",
  )!;
  const eliminatedCivilian = questionerState.questionerView?.find(
    (item) => item.role === "civilian",
  );
  const fallbackTarget = questionerState.questionerView?.find(
    (item) => item.playerId !== eliminatedCivilian?.playerId,
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

  let snapshot = getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot");
  expect(snapshot?.status.phase).toBe("night");

  questionerState = getLastEventPayload<PrivateState>(questioner.connection, "game.privateState")!;
  const aliveActors =
    questionerState.questionerView?.filter(
      (item) => item.alive && (item.role === "civilian" || item.role === "undercover"),
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

  let privateState = getLastEventPayload<PrivateState>(
    submittedActorConnection,
    "game.privateState",
  );
  expect(privateState?.nightActionSubmitted).toBe(true);
  expect(privateState?.privilegedActionPreview).toBeUndefined();
  questionerState = getLastEventPayload<PrivateState>(questioner.connection, "game.privateState")!;
  expect(
    questionerState.privilegedActionPreview?.nightActions.some(
      (action) => action.actorId === submittedActorId && action.targetId === undefined,
    ),
  ).toBe(true);

  await service.unregisterConnection(disconnectedActorConnection.record.id);

  snapshot = getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot");
  expect(snapshot?.status.pendingDisconnectPlayerId).toBe(disconnectedActorId);

  await execute(service, questioner.connection, {
    id: "resolve-night-disconnect",
    type: "game.resolveDisconnect",
    payload: {
      playerId: disconnectedActorId,
      resolution: "eliminate",
    },
  });

  snapshot = getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot");
  expect(snapshot?.status.phase).toBe("night");

  privateState = getLastEventPayload<PrivateState>(submittedActorConnection, "game.privateState");
  expect(privateState?.nightActionSubmitted).toBe(true);

  questionerState = getLastEventPayload<PrivateState>(questioner.connection, "game.privateState")!;
  const remainingActors =
    questionerState.questionerView?.filter(
      (item) => item.alive && (item.role === "civilian" || item.role === "undercover"),
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

  snapshot = getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot");
  expect(snapshot?.status.phase).toBe("description");
  expect(snapshot?.status.day).toBe(2);
  expect(
    getEventPayloads<{ day: number }>(questioner.connection, "game.daybreak").at(-1)?.day,
  ).toBe(2);
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

  let snapshot = getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot");
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

  snapshot = getLastEventPayload<RoomSnapshot>(questioner.connection, "room.snapshot");
  expect(snapshot?.status.pendingDisconnectPlayerId).toBeUndefined();

  const privateState = getLastEventPayload<PrivateState>(reconnect, "game.privateState");
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
  const { host, result: hostResult } = await createRoom(service, "5858");
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
  expect(privateState?.role).toBeUndefined();
  expect(privateState?.side).toBeUndefined();
  expect(privateState?.word).toBeUndefined();
  expect(privateState?.angelWordOptions).toBeUndefined();
  expect(privateState?.blankHint).toBeUndefined();
  expect(privateState?.questionerView).toHaveLength(4);

  // 已能看到全部身份的视角才拿到全局词语；参战玩家仍只知道自己那一个。
  expect(privateState?.globalWords).toEqual({
    civilianWord: expect.any(String),
    undercoverWord: expect.any(String),
    blankHint: undefined,
  });
  expect(
    getLastEventPayload<PrivateState>(joined[3].connection, "game.privateState")?.globalWords,
  ).toEqual(privateState?.globalWords);
  expect(getLastEventPayload<PrivateState>(host, "game.privateState")?.globalWords).toBeUndefined();
  expect(privateState?.questionerView?.every((entry) => entry.role != null)).toBe(true);
  expect(
    privateState?.questionerView?.some(
      (entry) => entry.playerId === spectator.joinResult.playerId,
    ),
  ).toBe(false);

  const connectionByPlayerId = new Map<string, ReturnType<typeof createConnection>>([
    [hostResult.playerId, host],
    ...joined.map((item) => [item.joinResult.playerId, item.connection] as const),
  ]);
  for (const player of privateState?.questionerView ?? []) {
    await execute(service, connectionByPlayerId.get(player.playerId)!, {
      id: `view-desc-${player.playerId}`,
      type: "game.submitDescription",
      payload: { text: "身份预览测试描述" },
    });
  }
  await execute(service, joined[3].connection, {
    id: "view-to-voting",
    type: "game.advancePhase",
    payload: {},
  });
  await execute(service, host, {
    id: "view-submit-vote",
    type: "game.submitVote",
    payload: { targetId: joined[0].joinResult.playerId },
  });

  const spectatorVotingState = getLastEventPayload<PrivateState>(
    spectator.connection,
    "game.privateState",
  );
  expect(spectatorVotingState?.privilegedActionPreview?.votes).toContainEqual({
    voterId: hostResult.playerId,
    targetId: joined[0].joinResult.playerId,
  });
  expect(
    getLastEventPayload<PrivateState>(host, "game.privateState")?.privilegedActionPreview,
  ).toBeUndefined();
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

test("游戏进行中可以转移房主并踢出普通玩家", async () => {
  const { service } = createTestContext();
  const { host, result: hostResult } = await createRoom(service, "Oblivionis");
  const extra = createConnection(service, "Oblivionis-review-extra");
  const extraJoin = (await execute(service, extra, {
    id: "extra-join",
    type: "room.join",
    roomId: "Oblivionis",
    payload: { userName: "复查玩家" },
  })) as { playerId: string };

  // 测试房间与真实房间同规则：4 名参战 + 1 名出题人，用机器人补足。
  await execute(service, host, {
    id: "add-bots",
    type: "test.addBot",
    payload: { count: 3 },
  });

  await execute(service, host, {
    id: "jump-voting",
    type: "test.jumpToPhase",
    payload: { phase: "voting" },
  });

  await execute(service, host, {
    id: "transfer-host-active",
    type: "room.transferHost",
    payload: { playerId: extraJoin.playerId },
  });

  let snapshot = getLastEventPayload<RoomSnapshot>(extra, "room.snapshot");
  expect(snapshot?.hostPlayerId).toBe(extraJoin.playerId);

  await execute(service, extra, {
    id: "kick-active",
    type: "room.kick",
    payload: { playerId: hostResult.playerId },
  });

  snapshot = getLastEventPayload<RoomSnapshot>(extra, "room.snapshot");
  expect(snapshot?.players.find((player) => player.id === hostResult.playerId)?.membership).toBe(
    "kicked",
  );
});

test("房主断线满 60 秒后转移给最早在线的正式玩家", async () => {
  const { service, advanceTime } = createTestContext();
  const { host, result: hostResult } = await createRoom(service, "2121");
  const spectator = createConnection(service, "2121-spectator");
  const spectatorJoin = (await execute(service, spectator, {
    id: "spectator-join",
    type: "room.join",
    roomId: "2121",
    payload: { userName: "旁观者" },
  })) as { playerId: string };
  await execute(service, spectator, {
    id: "become-spectator",
    type: "player.setSpectator",
    payload: { spectator: true },
  });

  advanceTime(1);
  const player = createConnection(service, "2121-player");
  const playerJoin = (await execute(service, player, {
    id: "player-join",
    type: "room.join",
    roomId: "2121",
    payload: { userName: "正式玩家" },
  })) as { playerId: string };

  await service.unregisterConnection(host.record.id);
  advanceTime(60 * 1000 - 1);
  await service.runHousekeeping();
  expect(getLastEventPayload<RoomSnapshot>(player, "room.snapshot")?.hostPlayerId).toBe(
    hostResult.playerId,
  );

  advanceTime(1);
  await service.runHousekeeping();
  const snapshot = getLastEventPayload<RoomSnapshot>(player, "room.snapshot");
  expect(snapshot?.hostPlayerId).toBe(playerJoin.playerId);
  expect(snapshot?.hostPlayerId).not.toBe(spectatorJoin.playerId);
});

test("房主在宽限期内凭令牌重连会取消自动转移", async () => {
  const { service, advanceTime } = createTestContext();
  const { host, result } = await createRoom(service, "2323");
  const player = createConnection(service, "2323-player");
  await execute(service, player, {
    id: "player-join",
    type: "room.join",
    roomId: "2323",
    payload: { userName: "候选房主" },
  });

  await service.unregisterConnection(host.record.id);
  advanceTime(60 * 1000 - 1);
  const reconnectedHost = createConnection(service, "2323-reconnected-host");
  await execute(service, reconnectedHost, {
    id: "host-reconnect",
    type: "room.reconnect",
    payload: {
      roomId: "2323",
      sessionToken: result.sessionToken,
    },
  });

  advanceTime(1);
  await service.runHousekeeping();
  expect(
    getLastEventPayload<RoomSnapshot>(reconnectedHost, "room.snapshot")?.hostPlayerId,
  ).toBe(result.playerId);
});

test("宽限期到达时没有正式玩家会在其加入后继续转移", async () => {
  const { service, advanceTime } = createTestContext();
  const { host } = await createRoom(service, "2525");
  const spectator = createConnection(service, "2525-spectator");
  await execute(service, spectator, {
    id: "spectator-join",
    type: "room.join",
    roomId: "2525",
    payload: { userName: "旁观者" },
  });
  await execute(service, spectator, {
    id: "become-spectator",
    type: "player.setSpectator",
    payload: { spectator: true },
  });

  await service.unregisterConnection(host.record.id);
  advanceTime(60 * 1000);
  await service.runHousekeeping();

  const player = createConnection(service, "2525-player");
  const playerJoin = (await execute(service, player, {
    id: "player-join",
    type: "room.join",
    roomId: "2525",
    payload: { userName: "后来玩家" },
  })) as { playerId: string };
  await service.runHousekeeping();

  expect(getLastEventPayload<RoomSnapshot>(player, "room.snapshot")?.hostPlayerId).toBe(
    playerJoin.playerId,
  );
});

test("房主显式离开时无需等待宽限期即可转移", async () => {
  const { service } = createTestContext();
  const { host } = await createRoom(service, "2424");
  const player = createConnection(service, "2424-player");
  const playerJoin = (await execute(service, player, {
    id: "player-join",
    type: "room.join",
    roomId: "2424",
    payload: { userName: "接任玩家" },
  })) as { playerId: string };

  await execute(service, host, {
    id: "host-leave",
    type: "room.leave",
    payload: {},
  });

  expect(getLastEventPayload<RoomSnapshot>(player, "room.snapshot")?.hostPlayerId).toBe(
    playerJoin.playerId,
  );
});

test("正式房间转移房主后原房主踢掉新房主，房主交给剩下的人", async () => {
  const { service } = createTestContext();
  const { host, result: hostResult } = await createRoom(service, "2222");

  const second = createConnection(service, "2222-second");
  const secondJoin = (await execute(service, second, {
    id: "second-join",
    type: "room.join",
    roomId: "2222",
    payload: { userName: "二号" },
  })) as { playerId: string };

  const third = createConnection(service, "2222-third");
  const thirdJoin = (await execute(service, third, {
    id: "third-join",
    type: "room.join",
    roomId: "2222",
    payload: { userName: "三号" },
  })) as { playerId: string };

  // 房主交给二号，二号再把原房主踢掉；房主必须仍落在二号身上。
  await execute(service, host, {
    id: "transfer-to-second",
    type: "room.transferHost",
    payload: { playerId: secondJoin.playerId },
  });
  expect(getLastEventPayload<RoomSnapshot>(second, "room.snapshot")?.hostPlayerId).toBe(
    secondJoin.playerId,
  );

  await execute(service, second, {
    id: "kick-old-host",
    type: "room.kick",
    payload: { playerId: hostResult.playerId },
  });
  expect(getLastEventPayload<RoomSnapshot>(second, "room.snapshot")?.hostPlayerId).toBe(
    secondJoin.playerId,
  );

  // 二号自己离开后，房主交给仅剩的三号，不悬空在已离开的人身上。
  await execute(service, second, {
    id: "second-leave",
    type: "room.leave",
    payload: {},
  });

  const snapshot = getLastEventPayload<RoomSnapshot>(third, "room.snapshot");
  expect(snapshot?.hostPlayerId).toBe(thirdJoin.playerId);
});

test("游戏中踢出出题人会中止本局", async () => {
  const { service } = createTestContext();
  const { host } = await createRoom(service, "Oblivionis");
  const supportingPlayers = Array.from({ length: 3 }, (_, index) =>
    createConnection(service, `Oblivionis-support-${index}`),
  );
  const questioner = createConnection(service, "Oblivionis-questioner");
  const questionerJoin = (await execute(service, questioner, {
    id: "questioner-join",
    type: "room.join",
    roomId: "Oblivionis",
    payload: { userName: "出题人" },
  })) as { playerId: string };

  for (const [index, connection] of supportingPlayers.entries()) {
    await execute(service, connection, {
      id: `support-join-${index}`,
      type: "room.join",
      roomId: "Oblivionis",
      payload: { userName: `正式玩家${index + 2}` },
    });
  }

  for (const connection of [host, ...supportingPlayers, questioner]) {
    await execute(service, connection, {
      id: `ready-${connection.record.id}`,
      type: "player.setReady",
      payload: { ready: true },
    });
  }

  await execute(service, host, { id: "start-kick-questioner", type: "game.advancePhase", payload: {} });
  await execute(service, host, {
    id: "assign-kicked-questioner",
    type: "game.assignQuestioner",
    payload: { playerId: questionerJoin.playerId },
  });
  await execute(service, questioner, {
    id: "words-before-kick",
    type: "game.submitWords",
    payload: { words: ["苹果", "香蕉"] },
  });
  await execute(service, host, {
    id: "kick-questioner",
    type: "room.kick",
    payload: { playerId: questionerJoin.playerId },
  });

  const snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(snapshot?.status.phase).toBe("gameOver");
  expect(snapshot?.summary?.winner).toBe("aborted");
  expect(snapshot?.players.find((player) => player.id === questionerJoin.playerId)?.membership).toBe(
    "kicked",
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

  const snapshot = getLastEventPayload<RoomSnapshot>(rejoin, "room.snapshot");
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

  expect(getLastEventPayload<RoomSnapshot>(rejoin, "room.snapshot")?.roomId).toBe("8123");
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
  const stillWaiting = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
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

  const snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  const privateState = getLastEventPayload<PrivateState>(host, "game.privateState");
  expect(snapshot?.status.phase).toBe("voting");
  expect(snapshot?.players.find((player) => player.id === privateState?.playerId)?.roundStatus).toBe(
    "alive",
  );
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

  const snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  const privateState = getLastEventPayload<PrivateState>(host, "game.privateState");
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
  expect(getLastEventPayload<RoomSnapshot>(host, "room.snapshot")?.status.questionerPlayerId).toBe(
    result.playerId,
  );

  // 出完题继续往后跳，出题人身份必须留住，不能退化成普通玩家。
  for (const phase of ["description", "voting", "night"] as const) {
    await execute(service, host, {
      id: `jump-${phase}`,
      type: "test.jumpToPhase",
      payload: { phase },
    });

    const snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
    const privateState = getLastEventPayload<PrivateState>(host, "game.privateState");
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
    const snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
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
  expect(getLastEventPayload<RoomSnapshot>(host, "room.snapshot")?.status.phase).toBe("gameOver");

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
  expect(getLastEventPayload<RoomSnapshot>(host, "room.snapshot")?.status.phase).toBe("gameOver");

  advanceTime(PHASE_RESULT_DISPLAY_MS);
  await execute(service, host, {
    id: "advance-after-result",
    type: "game.advancePhase",
    payload: {},
  });
  expect(getLastEventPayload<RoomSnapshot>(host, "room.snapshot")?.status.phase).toBe("waiting");
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

  let snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(snapshot?.status).toMatchObject({ phase: "waiting", started: false, day: 0 });
  expect(snapshot?.summary).toBeUndefined();
  expect(snapshot?.players.find((player) => player.id === result.playerId)?.isReady).toBe(false);
  expect(snapshot?.players.filter((player) => player.isBot).every((player) => player.isReady)).toBe(
    true,
  );

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
  snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
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

  const voteTarget = getLastEventPayload<RoomSnapshot>(player.connection, "room.snapshot")?.players.find(
    (entry) => entry.roundStatus === "alive" && entry.id !== player.joinResult.playerId,
  );
  expect(voteTarget).toBeDefined();
  await execute(service, player.connection, {
    id: "submit-vote-before-cancel",
    type: "game.submitVote",
    payload: { targetId: voteTarget!.id },
  });
  expect(
    getLastEventPayload<PrivateState>(player.connection, "game.privateState")
      ?.myCurrentVoteTargetId,
  ).toBe(voteTarget!.id);

  await execute(service, player.connection, {
    id: "cancel-vote",
    type: "game.cancelVote",
    payload: {},
  });
  expect(
    getLastEventPayload<PrivateState>(player.connection, "game.privateState")
      ?.myCurrentVoteTargetId,
  ).toBeUndefined();
  expect(
    getLastEventPayload<PrivateState>(host, "game.privateState")?.privilegedActionPreview?.votes.some(
      (vote) => vote.voterId === player.joinResult.playerId,
    ),
  ).toBe(false);
  expect(
    await execute(service, player.connection, {
      id: "cancel-vote-again",
      type: "game.cancelVote",
      payload: {},
    }),
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
    getLastEventPayload<PrivateState>(player.connection, "game.privateState")
      ?.nightActionSubmitted,
  ).toBe(true);

  await execute(service, player.connection, {
    id: "cancel-night",
    type: "game.cancelNightAction",
    payload: {},
  });
  const cancelledNight = getLastEventPayload<PrivateState>(
    player.connection,
    "game.privateState",
  );
  expect(cancelledNight?.nightActionSubmitted).toBe(false);
  expect(cancelledNight?.myCurrentNightTargetId).toBeUndefined();
  expect(
    getLastEventPayload<PrivateState>(host, "game.privateState")?.privilegedActionPreview?.nightActions.some(
      (action) => action.actorId === player.joinResult.playerId,
    ),
  ).toBe(false);
  expect(
    await execute(service, player.connection, {
      id: "cancel-night-again",
      type: "game.cancelNightAction",
      payload: {},
    }),
  ).toEqual({ cancelled: false });

  await execute(service, player.connection, {
    id: "submit-night-again",
    type: "game.submitNightAction",
    payload: { targetId: null },
  });
  expect(
    getLastEventPayload<PrivateState>(player.connection, "game.privateState")
      ?.nightActionSubmitted,
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
      getLastEventPayload<PrivateState>(connection, "game.privateState")?.role === "civilian",
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

  let snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  expect(snapshot?.status.phase).toBe("description");
  expect(snapshot?.status.descriptionOrder).not.toContain(target!.joinResult.playerId);
  await execute(service, host, {
    id: "advance-after-description-kick",
    type: "game.advancePhase",
    payload: {},
  });
  snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
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
      getLastEventPayload<PrivateState>(connection, "game.privateState")?.role === "civilian",
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
    getLastEventPayload<PrivateState>(actor!.connection, "game.privateState")
      ?.nightActionSubmitted,
  ).toBe(true);
  await execute(service, host, {
    id: "advance-after-night-kick",
    type: "game.advancePhase",
    payload: {},
  });
  expect(getLastEventPayload<RoomSnapshot>(host, "room.snapshot")?.status.phase).toBe(
    "description",
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

  let snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
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

  snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
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

  snapshot = getLastEventPayload<RoomSnapshot>(host, "room.snapshot");
  // 必须进入夜晚且全员存活，无人出局
  expect(snapshot?.status.phase).toBe("night");
  const aliveCount = (snapshot?.players ?? []).filter((p) => p.roundStatus === "alive").length;
  expect(aliveCount).toBe(4);
});

test("真人离开测试房间后测试房间自动关闭", async () => {
  const { service } = createTestContext();
  const { host } = await createRoom(service, "Oblivionis");

  await execute(service, host, {
    id: "leave-test-room",
    type: "room.leave",
    payload: {},
  });

  const rejoin = createConnection(service, "oblivionis-new-human");
  // 房间已关闭，直接加入会找不到房间
  await expect(
    execute(service, rejoin, {
      id: "join-new",
      type: "room.join",
      roomId: "Oblivionis",
      payload: { userName: "新玩家" },
    }),
  ).rejects.toThrow("房间不存在");

  // 再次创建 Oblivionis 则是全新房间
  const { result: createResult } = await createRoom(service, "Oblivionis");
  expect(createResult.roomId).toBe("Oblivionis");
});

test("0分数的旁观者掉线立即移除", async () => {
  const { service } = createTestContext();
  const { host } = await createRoom(service, "3333");
  const spectatorConn = createConnection(service, "spec-conn");
  const joinResult = (await execute(service, spectatorConn, {
    id: "join-spec",
    type: "room.join",
    roomId: "3333",
    payload: { userName: "旁观者" },
  })) as { playerId: string };
  await execute(service, spectatorConn, {
    id: "set-spec",
    type: "player.setSpectator",
    payload: { spectator: true },
  });

  const room = (service as any).rooms.get("3333")!;
  expect(room.players[joinResult.playerId]).toBeDefined();

  await service.unregisterConnection(spectatorConn.record.id);
  expect(room.players[joinResult.playerId]).toBeUndefined();
});

test("退出房间的玩家即使有积分也会被正确清理", async () => {
  const { service } = createTestContext();
  const { host } = await createRoom(service, "4444");
  const playerConn = createConnection(service, "player-conn");
  const joinResult = (await execute(service, playerConn, {
    id: "join-player",
    type: "room.join",
    roomId: "4444",
    payload: { userName: "有分玩家" },
  })) as { playerId: string };

  const room = (service as any).rooms.get("4444")!;
  room.players[joinResult.playerId]!.score = 10;

  await execute(service, playerConn, {
    id: "leave-player",
    type: "room.leave",
    payload: {},
  });

  expect(room.players[joinResult.playerId]).toBeUndefined();
});

test("掉线玩家3分钟后由 housekeeping 自动清理", async () => {
  const { service, advanceTime } = createTestContext();
  const { host } = await createRoom(service, "5555");
  const playerConn = createConnection(service, "offline-player-conn");
  const joinResult = (await execute(service, playerConn, {
    id: "join-player",
    type: "room.join",
    roomId: "5555",
    payload: { userName: "掉线玩家" },
  })) as { playerId: string };

  const room = (service as any).rooms.get("5555")!;
  await service.unregisterConnection(playerConn.record.id);
  expect(room.players[joinResult.playerId]).toBeDefined();
  expect(room.players[joinResult.playerId]?.online).toBe(false);

  // 模拟2分钟过去，尚未超时
  advanceTime(2 * 60 * 1000);
  await service.runHousekeeping();
  expect(room.players[joinResult.playerId]).toBeDefined();

  // 模拟超过3分钟过去（累计3分01秒）
  advanceTime(1 * 60 * 1000 + 1000);
  await service.runHousekeeping();
  expect(room.players[joinResult.playerId]).toBeUndefined();
});

test("房主掉线1分钟后自动移交房主", async () => {
  const { service, advanceTime } = createTestContext();
  const { host, result: hostResult } = await createRoom(service, "6666");
  const playerConn = createConnection(service, "next-host-conn");
  const joinResult = (await execute(service, playerConn, {
    id: "join-player",
    type: "room.join",
    roomId: "6666",
    payload: { userName: "接任房主" },
  })) as { playerId: string };

  const room = (service as any).rooms.get("6666")!;
  expect(room.hostPlayerId).toBe(hostResult.playerId);

  await service.unregisterConnection(host.record.id);
  expect(room.hostPlayerId).toBe(hostResult.playerId);
  expect(room.hostReconnectDeadlineAt).toBeDefined();

  // 30秒过去，房主尚未移交
  advanceTime(30 * 1000);
  await service.runHousekeeping();
  expect(room.hostPlayerId).toBe(hostResult.playerId);

  // 累计61秒过去，房主已移交给下一位在线正式玩家
  advanceTime(31 * 1000);
  await service.runHousekeeping();
  expect(room.hostPlayerId).toBe(joinResult.playerId);
});
