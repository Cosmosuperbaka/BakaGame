import { describe, expect, test } from "bun:test";
import { computeVoteOutcome } from "../../src/domain/Rules";
import { decideVoteResult } from "../../src/application/whoisfaker/Resolution";
import { ABSTAIN_TARGET_ID, type VoteRecord } from "../../src/shared/Index";

const vote = (voterId: string, targetId: string): VoteRecord => ({ voterId, targetId });
const decide = (tieBreak: boolean, votes: VoteRecord[], aliveCount: number) =>
  decideVoteResult(tieBreak, computeVoteOutcome(votes), aliveCount);

describe("投票判定", () => {
  test("首轮单一最高票：该玩家出局", () => {
    expect(decide(false, [vote("a", "x"), vote("b", "x"), vote("c", "y")], 5)).toEqual({
      eliminatedIds: ["x"],
      tieBreakCandidateIds: undefined,
    });
  });

  test("首轮平票且仍有非候选玩家：候选人进平票 PK，无人出局", () => {
    expect(decide(false, [vote("a", "x"), vote("b", "y")], 5)).toEqual({
      eliminatedIds: [],
      tieBreakCandidateIds: ["x", "y"],
    });
  });

  test("首轮全员平票：无人出局也不进平票 PK", () => {
    expect(decide(false, [vote("a", "x"), vote("b", "y")], 2)).toEqual({
      eliminatedIds: [],
      tieBreakCandidateIds: undefined,
    });
  });

  test("首轮弃票数达到最高票：即使最高票唯一也进平票 PK", () => {
    expect(decide(false, [vote("a", "x"), vote("b", ABSTAIN_TARGET_ID)], 5)).toEqual({
      eliminatedIds: [],
      tieBreakCandidateIds: ["x"],
    });
  });

  test("首轮弃票少于最高票：最高票者出局", () => {
    expect(
      decide(false, [vote("a", "x"), vote("b", "x"), vote("c", ABSTAIN_TARGET_ID)], 5)
    ).toEqual({ eliminatedIds: ["x"], tieBreakCandidateIds: undefined });
  });

  test("首轮无人得票或全员弃票：无人出局", () => {
    const none = { eliminatedIds: [], tieBreakCandidateIds: undefined };
    expect(decide(false, [], 5)).toEqual(none);
    expect(decide(false, [vote("a", ABSTAIN_TARGET_ID), vote("b", ABSTAIN_TARGET_ID)], 5)).toEqual(
      none
    );
  });

  test("平票 PK：单一最高票且弃票更少才出局", () => {
    expect(decide(true, [vote("a", "x"), vote("b", "x"), vote("c", "y")], 5)).toEqual({
      eliminatedIds: ["x"],
      tieBreakCandidateIds: undefined,
    });
  });

  test("平票 PK：再次平票、弃票达到最高票、无人投票都无人出局，且不再开新一轮 PK", () => {
    const none = { eliminatedIds: [], tieBreakCandidateIds: undefined };
    expect(decide(true, [vote("a", "x"), vote("b", "y")], 5)).toEqual(none);
    expect(decide(true, [vote("a", "x"), vote("b", ABSTAIN_TARGET_ID)], 5)).toEqual(none);
    expect(decide(true, [], 5)).toEqual(none);
  });
});
