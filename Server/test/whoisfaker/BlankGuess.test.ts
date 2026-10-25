import { describe, expect, test } from "bun:test";
import { createRoom, joinPlayers } from "./Fixtures";
import { type WhoIsFakerRoomSnapshot } from "../../src/shared/Index";
import { createTestContext, execute, getLastEventPayload } from ".././Helpers";

describe("白板猜词打断", () => {
  test("白板猜词打断发言阶段后，裁定未通过恢复原阶段并还原剩余倒计时", async () => {
    const { service, advanceTime } = createTestContext();
    const { host } = await createRoom(service, "Oblivionis");
    const [player] = await joinPlayers(service, "Oblivionis", 1, "白板玩家");

    await execute(service, host, {
      id: "add-bots",
      type: "test.addBot",
      payload: { count: 3 },
    });

    // 跳出题阶段并提交词语
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

    // 设置玩家角色为白板
    await execute(service, player.connection, {
      id: "set-blank",
      type: "test.setMyRole",
      payload: { role: "blank" },
    });

    // 主持人开启 60 秒倒计时
    await execute(service, host, {
      id: "start-timer",
      type: "game.startPhaseTimer",
      payload: { durationSeconds: 60 },
    });

    // 经过 20 秒
    advanceTime(20_000);

    // 白板主动发起猜词，打断发言阶段
    await execute(service, player.connection, {
      id: "enter-blank-guess",
      type: "game.enterBlankGuess",
      payload: {},
    });

    let snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(player.connection, "room.snapshot");
    expect(snapshot?.status.phase).toBe("blankGuess");
    expect(snapshot?.status.phaseTimer).toBeUndefined();

    // 白板提交错误词语，进入主持人裁定
    await execute(service, player.connection, {
      id: "submit-guess",
      type: "game.submitBlankGuess",
      payload: { words: ["西瓜", "草莓"] },
    });

    // 主持人裁定未通过
    await execute(service, host, {
      id: "review-guess",
      type: "game.reviewBlankGuess",
      payload: { approve: false },
    });

    // 先停在猜词反馈，继续后阶段恢复为 description，且剩余倒计时被还原为约 40 秒
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(player.connection, "room.snapshot");
    expect(snapshot?.status.phase).toBe("feedback");
    expect(snapshot?.status.phaseTimer).toBeUndefined();
    await execute(service, host, { id: "continue-review", type: "game.advancePhase", payload: {} });
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(player.connection, "room.snapshot");
    expect(snapshot?.status.phase).toBe("description");
    expect(snapshot?.status.phaseTimer).toBeDefined();
    expect(snapshot?.status.phaseTimer?.durationSeconds).toBe(40);
  });

  test("白板猜词期间白板掉线且出题人选择等待时，系统强制挂载 60 秒倒计时兜底避免死锁", async () => {
    const { service, advanceTime } = createTestContext();
    const { host } = await createRoom(service, "Oblivionis");
    const [player] = await joinPlayers(service, "Oblivionis", 1, "白板玩家");

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

    await execute(service, player.connection, {
      id: "set-blank",
      type: "test.setMyRole",
      payload: { role: "blank" },
    });

    // 白板进入猜词
    await execute(service, player.connection, {
      id: "enter-blank-guess",
      type: "game.enterBlankGuess",
      payload: {},
    });

    // 白板掉线
    await service.unregisterConnection(player.connection.record.id);

    // 出题人选择等待掉线白板
    await execute(service, host, {
      id: "resolve-disconnect-wait",
      type: "game.resolveDisconnect",
      payload: { playerId: player.joinResult.playerId, resolution: "wait" },
    });

    // 此时应当已经挂载了 60 秒倒计时兜底
    let snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.status.phase).toBe("blankGuess");
    expect(snapshot?.status.phaseTimer).toBeDefined();
    expect(snapshot?.status.phaseTimer?.durationSeconds).toBe(60);

    // 倒计时超时（61 秒后）
    advanceTime(61_000);
    await service.runHousekeeping();

    // 房间自动结束猜词阶段，反馈后切回原阶段继续，杜绝永久死锁
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.status.phase).toBe("feedback");
    await execute(service, host, {
      id: "continue-timeout",
      type: "game.advancePhase",
      payload: {},
    });
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.status.phase).toBe("description");
  });

  test("平票阶段白板猜词掉线并被出题人淘汰时自动流转至夜晚且无状态异常", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "Oblivionis");
    const [player] = await joinPlayers(service, "Oblivionis", 1, "真人白板");

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

    // 设置 player 为白板，并确保其他机器人有卧底和平民存活（1卧底 + 2平民）
    await execute(service, player.connection, {
      id: "set-blank",
      type: "test.setMyRole",
      payload: { role: "blank" },
    });

    const room = (
      service as unknown as {
        rooms: Map<
          string,
          {
            round: {
              assignments: Record<string, { role: string; side: string; alive: boolean }>;
              tieBreak: { candidateIds: string[] };
            };
          }
        >;
      }
    ).rooms.get("Oblivionis")!;
    const botIds = Object.keys(room.round.assignments).filter(
      (id) => id !== player.joinResult.playerId
    );
    room.round.assignments[botIds[0]].role = "undercover";
    room.round.assignments[botIds[0]].side = "undercover";
    room.round.assignments[botIds[0]].alive = true;
    room.round.assignments[botIds[1]].role = "civilian";
    room.round.assignments[botIds[1]].side = "good";
    room.round.assignments[botIds[1]].alive = true;
    room.round.assignments[botIds[2]].role = "civilian";
    room.round.assignments[botIds[2]].side = "good";
    room.round.assignments[botIds[2]].alive = true;

    // 跳转到 tieBreak 阶段（平票 PK）
    await execute(service, host, {
      id: "jump-to-tie-break",
      type: "test.jumpToPhase",
      payload: { phase: "tieBreak" },
    });

    let snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.status.phase).toBe("tieBreak");

    // 让平票候选人强制包含 player 与另一个存活玩家
    const otherCandidateId =
      room.round.tieBreak.candidateIds.find((id) => id !== player.joinResult.playerId) ?? "bot_1";
    room.round.tieBreak.candidateIds = [player.joinResult.playerId, otherCandidateId];

    // 白板在平票阶段主动进入猜词
    await execute(service, player.connection, {
      id: "enter-blank-guess",
      type: "game.enterBlankGuess",
      payload: {},
    });

    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.status.phase).toBe("blankGuess");

    // 白板掉线
    await service.unregisterConnection(player.connection.record.id);

    // 出题人选择淘汰掉线的白板
    await execute(service, host, {
      id: "resolve-disconnect-eliminate",
      type: "game.resolveDisconnect",
      payload: { playerId: player.joinResult.playerId, resolution: "eliminate" },
    });

    // 由于候选人从2人减至1人，平票PK无法成立，系统自动自愈流转至夜晚
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.status.phase).toBe("night");

    // 出题人推进阶段不会抛出 TIE_BREAK_MISSING 平票状态异常
    const advanceResult = await execute(service, host, {
      id: "advance-phase",
      type: "game.advancePhase",
      payload: {},
    });
    expect(advanceResult).toBeDefined();
  });
});
