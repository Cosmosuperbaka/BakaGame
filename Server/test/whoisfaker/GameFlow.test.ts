import { describe, expect, test } from "bun:test";
import { type JoinedPlayer, createRoom, joinPlayers } from "./Fixtures";
import { type WhoIsFakerPrivateState, type WhoIsFakerRoomSnapshot } from "../../src/shared/Index";
import {
  createConnection,
  createTestContext,
  execute,
  getEventPayloads,
  getLastEventPayload,
} from ".././Helpers";

describe("对局流程", () => {
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
    let snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")!;
    const order = snapshot.status.speechOrder ?? [];
    expect(order).toEqual(snapshot.status.descriptionOrder ?? []);
    expect(order).toHaveLength(4);

    await execute(service, connectionByPlayerId.get(order[1])!, {
      id: "submit-second-first",
      type: "game.submitDescription",
      payload: { text: "第二位提前提交" },
    });

    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")!;
    expect(snapshot.status.submittedSpeechPlayerIds).toEqual([order[1]]);
    expect(snapshot.descriptions).toEqual([]);

    await execute(service, connectionByPlayerId.get(order[0])!, {
      id: "submit-first-after",
      type: "game.submitDescription",
      payload: { text: "第一位随后提交" },
    });

    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")!;
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

    expect(
      getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")?.chat.at(-1)?.text
    ).toBe("第 1 天描述阶段");

    for (const connection of [
      host,
      joined[0].connection,
      joined[1].connection,
      joined[2].connection,
    ]) {
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
    expect(
      getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")?.chat.at(-1)?.text
    ).toBe("第 1 天投票阶段");

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
    let questionerState = getLastEventPayload<WhoIsFakerPrivateState>(
      questioner.connection,
      "game.privateState"
    );
    let supplementSnapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
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
    supplementSnapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(supplementSnapshot?.status.phase).toBe("description");
    expect(supplementSnapshot?.status.submittedSpeechPlayerIds).toEqual([
      joined[2].joinResult.playerId,
    ]);
    expect(
      supplementSnapshot?.descriptions.some((description) => description.kind === "supplement")
    ).toBe(false);

    await execute(service, joined[1].connection, {
      id: "submit-earlier-supplement-after",
      type: "game.submitDescription",
      payload: { text: "前序玩家随后补充" },
    });
    questionerState = getLastEventPayload<WhoIsFakerPrivateState>(
      questioner.connection,
      "game.privateState"
    );
    supplementSnapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(supplementSnapshot?.status.phase).toBe("voting");
    expect(supplementSnapshot?.status.speechMode).toBeUndefined();
    expect(supplementSnapshot?.status.supplementIndex).toBeUndefined();
    expect(questionerState?.privilegedActionPreview?.votes).toHaveLength(4);
    expect(
      getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")?.descriptions.at(-1)?.kind
    ).toBe("supplement");

    const snapshotsBeforeResolution = getEventPayloads<WhoIsFakerRoomSnapshot>(
      host,
      "room.snapshot"
    ).length;
    await execute(service, questioner.connection, {
      id: "resolve-vote",
      type: "game.advancePhase",
      payload: {},
    });

    const resolutionSnapshots = getEventPayloads<WhoIsFakerRoomSnapshot>(
      host,
      "room.snapshot"
    ).slice(snapshotsBeforeResolution);
    // 决出胜负时先停在投票反馈：出局已落地，继续后才结算。
    const eliminationSnapshot = resolutionSnapshots.find(
      (item) => item.status.phase === "feedback"
    );
    expect(eliminationSnapshot?.status.feedback?.kind).toBe("vote");
    expect(eliminationSnapshot?.status.feedback?.eliminatedPlayerIds).toEqual([
      hostResult.playerId,
    ]);
    expect(eliminationSnapshot?.status.feedback?.votes).toHaveLength(4);
    expect(eliminationSnapshot?.status.feedback?.next).toBe("gameOver");
    await execute(service, questioner.connection, {
      id: "continue-vote",
      type: "game.advancePhase",
      payload: {},
    });
    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(
      eliminationSnapshot?.players.find((player) => player.id === hostResult.playerId)?.roundStatus
    ).toBe("dead");
    expect(snapshot?.status.phase).toBe("gameOver");
    expect(snapshot?.summary?.winner).toBe("good");
    expect(snapshot?.summary?.words?.civilianWord).toBeTruthy();
    expect(snapshot?.summary?.words?.undercoverWord).toBeTruthy();
    expect(snapshot?.summary?.voteHistory).toHaveLength(1);
    expect(snapshot?.summary?.voteHistory?.[0]?.votes).toHaveLength(4);
    expect(snapshot?.summary?.history).toMatchObject([
      { kind: "vote", day: 1, eliminatedPlayerIds: [hostResult.playerId] },
    ]);
    expect(snapshot?.players.find((player) => player.id === hostResult.playerId)?.score).toBe(0);
    expect(
      snapshot?.players.find((player) => player.id === joined[0].joinResult.playerId)?.score
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

    // 投票结果只走状态通道：领先者直接取自快照，事件不再携带票数或领先者负载。
    const candidates = snapshot?.status.tieBreakCandidateIds ?? [];
    expect(candidates).toHaveLength(2);
    expect(snapshot?.status.tieBreakIndex).toBe(1);
    expect(getEventPayloads(host, "game.voteResult")).toHaveLength(0);

    const tieOrder = snapshot?.status.speechOrder ?? [];
    expect(tieOrder).toEqual(snapshot?.status.tieBreakCandidateIds ?? []);
    await execute(service, connectionByPlayerId.get(tieOrder[1])!, {
      id: "tie-desc-second-first",
      type: "game.submitDescription",
      payload: { text: "第二位提前 PK 描述" },
    });
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.descriptions.some((description) => description.kind === "tieBreak")).toBe(
      false
    );

    await execute(service, connectionByPlayerId.get(tieOrder[0])!, {
      id: "tie-desc-first-after",
      type: "game.submitDescription",
      payload: { text: "第一位随后 PK 描述" },
    });
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(
      snapshot?.descriptions
        .filter((description) => description.kind === "tieBreak")
        .map((description) => description.playerId)
    ).toEqual(tieOrder);

    await execute(service, questioner.connection, {
      id: "to-tie-vote",
      type: "game.advancePhase",
      payload: {},
    });

    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
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

    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.status.feedback).toMatchObject({
      kind: "vote",
      tieBreak: true,
      next: "night",
    });
    await execute(service, questioner.connection, {
      id: "continue-2",
      type: "game.advancePhase",
      payload: {},
    });
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
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

    const firstDescriptionSnapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(
      questioner.connection,
      "room.snapshot"
    )!;
    const firstQuestionerState = getLastEventPayload<WhoIsFakerPrivateState>(
      questioner.connection,
      "game.privateState"
    )!;
    const blankPlayerId = firstQuestionerState.questionerView?.find(
      (item) => item.role === "blank"
    )?.playerId;
    const descriptionOrder = firstDescriptionSnapshot.status.descriptionOrder ?? [];

    expect(descriptionOrder).toHaveLength(8);
    expect(new Set(descriptionOrder).size).toBe(8);
    expect(descriptionOrder.indexOf(blankPlayerId!)).toBeGreaterThanOrEqual(
      Math.floor(descriptionOrder.length / 2)
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
    await execute(service, questioner.connection, {
      id: "continue",
      type: "game.advancePhase",
      payload: {},
    });

    let snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    const blankPrivateState = getLastEventPayload<WhoIsFakerPrivateState>(
      blankPlayer.connection,
      "game.privateState"
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
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.status.phase).toBe("night");
  });
});
