import { describe, expect, test } from "bun:test";
import { timeoutBlankGuessPhase } from "../../src/application/whoisfaker/BlankGuess";
import { forceRemovePlayer } from "../../src/application/whoisfaker/ForcedRemoval";
import { publishRoom } from "../../src/application/whoisfaker/RoomPublish";
import type { GameRound } from "../../src/shared/Index";
import { execute } from "../Helpers";
import { resetBase, setupRoom, type Name } from "./ForcedRemovalHarness";

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

  await forceRemovePlayer(h.service.ctx, h.room, h.idOf(scenario.target), "kicked");
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
  test("平票发言档：候选只剩一人（现状）", async () => {
    const result = await removeThenFailGuess({
      target: "机3",
      candidates: ["机1", "机3"],
      stage: "description",
    });
    expect(result.phaseAfterRemoval).toBe("blankGuess");
    expect(result.phaseAfterFailedGuess).toBe("feedback");
    // 现状：回到只剩一名候选的平票加赛并重新挂上暂存倒计时（空转一轮）。
    expect(result).toMatchObject({
      phase: "tieBreak",
      speechMode: "tieBreak",
      tieBreak: { candidates: ["机1"], stage: "description" },
      guessContext: undefined,
      timer: [30_000],
    });
  });

  test("平票投票档：候选只剩一人（现状）", async () => {
    const result = await removeThenFailGuess({
      target: "机3",
      candidates: ["机1", "机3"],
      stage: "vote",
    });
    expect(result.phaseAfterRemoval).toBe("blankGuess");
    // 现状：回到只剩一名候选的平票投票并重新挂上暂存倒计时（空转一轮）。
    expect(result).toMatchObject({
      phase: "tieBreak",
      speechMode: undefined,
      tieBreak: { candidates: ["机1"], stage: "vote" },
      guessContext: undefined,
      timer: [30_000],
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
