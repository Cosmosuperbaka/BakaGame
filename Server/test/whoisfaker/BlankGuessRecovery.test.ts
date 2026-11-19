import { describe, expect, test } from "bun:test";
import { timeoutBlankGuessPhase } from "../../src/application/whoisfaker/BlankGuess";
import { forceRemovePlayer } from "../../src/application/whoisfaker/ForcedRemoval";
import { publishRoom } from "../../src/application/whoisfaker/RoomPublish";
import type { GameRound, WhoIsFakerRoomSnapshot } from "../../src/shared/Index";
import { execute, getLastEventPayload } from "../Helpers";
import { dead, resetBase, setupRoom, type Name } from "./ForcedRemovalHarness";

/**
 * 白板猜词被收束之后回到哪里：猜词期间有人被强制移除、随后猜错（草稿超时按失败结算），
 * 出题人（测试房里房主）在反馈阶段点继续，观察回到的阶段、平票状态、发言模式与倒计时。
 */

type Interrupted = {
  /** 被强制移除的人 */
  target: Name;
  /** 被猜词打断的平票加赛：候选与所处档位 */
  candidates: Name[];
  stage: "description" | "vote";
};

/** 搭好「平票加赛被白板猜词打断」的现场，移除一人，让猜词按草稿超时失败，反馈阶段点继续。 */
const removeThenFailGuess = async (scenario: Interrupted) => {
  const h = await setupRoom();
  const round = resetBase(h);
  const ids = scenario.candidates.map((name) => h.idOf(name));
  round.tieBreakCount = 1;
  round.tieBreak = {
    candidateIds: ids,
    stage: scenario.stage,
    descriptionsDone: scenario.stage === "vote" ? ids : [],
    votes: [],
  };
  round.phase = "blankGuess";
  round.speechMode = undefined;
  round.blankGuessContext = {
    playerId: h.idOf("机5"),
    reason: "active",
    resumePhase: "tieBreak",
    // 打断时暂存的剩余倒计时：猜错回到平票加赛时要重新挂上。
    interruptedRemainingTimerMs: 30_000,
    draft: ["橙子", "梨"],
  };

  await forceRemovePlayer(h.service.ctx, h.room, h.idOf(scenario.target), "kick");
  publishRoom(h.service.ctx, h.room);
  const phaseOf = () => round.phase as GameRound["phase"];
  const phaseAfterRemoval = phaseOf();

  await timeoutBlankGuessPhase(h.service.ctx, h.room, round);
  const phaseAfterFailedGuess = phaseOf();
  await execute(h.service, h.host, { id: "continue", type: "game.advancePhase", payload: {} });
  return {
    phaseAfterRemoval,
    phaseAfterFailedGuess,
    phase: phaseOf(),
    speechMode: round.speechMode,
    tieBreak: round.tieBreak && {
      candidates: round.tieBreak.candidateIds.map((id) => h.room.players[id].name),
      stage: round.tieBreak.stage,
    },
    guessContext: round.blankGuessContext,
    timer: h.timers.live().map((timer) => timer.delayMs),
  };
};

describe("猜词期间移除平票候选后猜错", () => {
  test("平票发言档：候选只剩一人时不再回到平票加赛，直接入夜晚", async () => {
    const result = await removeThenFailGuess({
      target: "机3",
      candidates: ["机1", "机3"],
      stage: "description",
    });
    expect(result.phaseAfterRemoval).toBe("blankGuess");
    expect(result.phaseAfterFailedGuess).toBe("feedback");
    // 平票只剩一名候选已无意义：直接入夜晚，原平票加赛暂存的倒计时作废。
    expect(result).toMatchObject({
      phase: "night",
      speechMode: undefined,
      tieBreak: undefined,
      guessContext: undefined,
      timer: [],
    });
  });

  test("平票投票档：候选只剩一人时不再回到平票加赛，直接入夜晚", async () => {
    const result = await removeThenFailGuess({
      target: "机3",
      candidates: ["机1", "机3"],
      stage: "vote",
    });
    expect(result.phaseAfterRemoval).toBe("blankGuess");
    expect(result).toMatchObject({
      phase: "night",
      speechMode: undefined,
      tieBreak: undefined,
      guessContext: undefined,
      timer: [],
    });
  });

  test("候选仍够（三人少一人）：回到平票加赛，暂存倒计时恢复", async () => {
    const result = await removeThenFailGuess({
      target: "机3",
      candidates: ["机1", "机3", "机4"],
      stage: "description",
    });
    expect(result).toMatchObject({
      phase: "tieBreak",
      speechMode: "tieBreak",
      tieBreak: { candidates: ["机1", "机4"], stage: "description" },
      timer: [30_000],
    });
  });
});

/**
 * 白板猜词未决期间，他人被强制移除并使残局成立（最后一名卧底出局）：
 * 已有的猜词上下文原样保留，只补写「预定胜者」；猜错按预定胜者结算，不回被打断的阶段。
 * 路人1 担任出题人（不参战），白板由机器人机5 担任，两名卧底里机4 已出局。
 */
const setupEndgameDuringGuess = async (kind: "pending" | "draft") => {
  const h = await setupRoom();
  const round = resetBase(h);
  const questionerId = h.idOf("路人1");
  delete round.assignments[questionerId];
  round.questionerPlayerId = questionerId;
  round.descriptionOrder = round.descriptionOrder.filter((id) => id !== questionerId);
  dead(round, h.idOf, "机4");
  round.phase = "voting";
  round.votes = [{ voterId: h.idOf("房主"), targetId: h.idOf("机1") }];
  round.phase = "blankGuess";
  round.speechMode = undefined;
  round.blankGuessUsed = kind === "pending";
  round.blankGuessContext = {
    playerId: h.idOf("机5"),
    reason: "active",
    resumePhase: "voting",
    interruptedRemainingTimerMs: 30_000,
    ...(kind === "pending"
      ? { draft: ["苹果", "梨"], pendingReview: { words: ["苹果", "梨"] as [string, string] } }
      : { draft: ["苹果", "香蕉"] as [string, string] }),
  };
  if (kind === "pending") {
    round.blankGuessRecords = [
      {
        playerId: h.idOf("机5"),
        guessedWords: ["苹果", "梨"],
        success: false,
        createdAt: Date.UTC(2026, 3, 10, 0, 0, 0),
        reason: "active",
      },
    ];
  }
  await forceRemovePlayer(h.service.ctx, h.room, h.idOf("机3"), "kick");
  publishRoom(h.service.ctx, h.room);
  return { h, round };
};

const snapshotStatus = (h: Awaited<ReturnType<typeof setupRoom>>) =>
  getLastEventPayload<WhoIsFakerRoomSnapshot>(h.human.connection, "room.snapshot")!.status;

describe("猜词期间他人被移除使残局成立", () => {
  const questionerAdvance = (h: Awaited<ReturnType<typeof setupRoom>>, id: string) =>
    execute(h.service, h.human.connection, { id, type: "game.advancePhase", payload: {} });

  test("只写了草稿：猜词上下文原样保留（草稿还在），只补写预定胜者", async () => {
    const { h, round } = await setupEndgameDuringGuess("draft");
    expect(round.phase).toBe("blankGuess");
    expect(round.blankGuessUsed).toBe(false);
    expect(round.blankGuessContext).toEqual({
      playerId: h.idOf("机5"),
      reason: "active",
      resumePhase: "voting",
      interruptedRemainingTimerMs: 30_000,
      draft: ["苹果", "香蕉"],
      deferredWinner: "good",
    });
    expect(snapshotStatus(h).blankGuessDraft).toEqual(["苹果", "香蕉"]);
  });

  test("只写了草稿：草稿猜中白板胜，猜错按预定胜者结算，都不回被打断的投票", async () => {
    for (const [draft, winner] of [
      [["苹果", "香蕉"], "blank"],
      [["橙子", "梨"], "good"],
    ] as const) {
      const { h, round } = await setupEndgameDuringGuess("draft");
      round.blankGuessContext!.draft = [draft[0], draft[1]];
      await timeoutBlankGuessPhase(h.service.ctx, h.room, round);
      await questionerAdvance(h, "continue");
      const phase = round.phase as GameRound["phase"];
      expect(phase).toBe("gameOver");
      expect(round.summary?.winner).toBe(winner);
    }
  });

  test("已提交待裁定：待裁定标记与猜词都不丢，不直接结算，只补写预定胜者", async () => {
    const { h, round } = await setupEndgameDuringGuess("pending");
    expect(round.phase).toBe("blankGuess");
    expect(round.blankGuessUsed).toBe(true);
    expect(round.blankGuessContext).toMatchObject({
      reason: "active",
      pendingReview: { words: ["苹果", "梨"] },
      deferredWinner: "good",
    });
    expect(round.blankGuessRecords).toHaveLength(1);
    const status = snapshotStatus(h);
    expect(status.phase).toBe("blankGuess");
    expect(status.blankGuessPendingReview).toBe(true);
  });

  test("已提交待裁定：裁定通过白板胜，裁定不通过预定胜者胜，白板都不用重新猜", async () => {
    for (const [approve, winner] of [
      [true, "blank"],
      [false, "good"],
    ] as const) {
      const { h, round } = await setupEndgameDuringGuess("pending");
      await execute(h.service, h.human.connection, {
        id: "review",
        type: "game.reviewBlankGuess",
        payload: { approve },
      });
      await questionerAdvance(h, "continue");
      const phase = round.phase as GameRound["phase"];
      expect(phase).toBe("gameOver");
      expect(round.summary?.winner).toBe(winner);
      expect(round.blankGuessRecords).toHaveLength(1);
    }
  });

  test("已提交待裁定：裁定超时按猜错处理，预定胜者胜", async () => {
    const { h, round } = await setupEndgameDuringGuess("pending");
    await timeoutBlankGuessPhase(h.service.ctx, h.room, round);
    await questionerAdvance(h, "continue");
    expect(round.summary?.winner).toBe("good");
  });
});
