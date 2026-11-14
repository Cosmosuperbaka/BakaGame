import { resetPageControl, setPageControl } from "@/stores/UsePageControl";
import { describe, expect, it } from "vitest";

import {
  WIF_PEOPLE,
  wifFeedbackSnapshot,
  wifPrivate,
  wifSnapshot,
  type WifStage,
} from "@/stories/fixtures/WhoIsFaker";
import { whoIsFakerNeedsAction } from "@/lib/WhoIsFakerActionSignals";

describe("whoIsFakerNeedsAction", () => {
  it("prompts the host to assign a questioner", () => {
    const snapshot = wifSnapshot("assigning");
    expect(whoIsFakerNeedsAction(snapshot, wifPrivate("host", "assigning"))).toBe(true);
    expect(whoIsFakerNeedsAction(snapshot, wifPrivate("me", "assigning"))).toBe(false);
  });

  it("prompts only the questioner to submit words", () => {
    const snapshot = wifSnapshot("words");
    expect(whoIsFakerNeedsAction(snapshot, wifPrivate("host", "words"))).toBe(true);
    expect(whoIsFakerNeedsAction(snapshot, wifPrivate("me", "words"))).toBe(false);
  });

  it("follows the description participation rules", () => {
    const inProgress = wifSnapshot("day2");
    expect(whoIsFakerNeedsAction(inProgress, wifPrivate("me", "day2"))).toBe(true);
    expect(whoIsFakerNeedsAction(inProgress, wifPrivate("host", "day2"))).toBe(false);

    const allSubmitted = wifSnapshot("day1");
    expect(whoIsFakerNeedsAction(allSubmitted, wifPrivate("me", "day1"))).toBe(false);
  });

  it("prompts alive non-questioners who have not voted", () => {
    const snapshot = wifSnapshot("vote1");
    expect(whoIsFakerNeedsAction(snapshot, wifPrivate("me", "vote1"))).toBe(true);
    expect(
      whoIsFakerNeedsAction(
        snapshot,
        wifPrivate("me", "vote1", { myCurrentVoteTargetId: WIF_PEOPLE.peach.id })
      )
    ).toBe(false);
    expect(whoIsFakerNeedsAction(snapshot, wifPrivate("host", "vote1"))).toBe(false);
  });

  it("prompts night actors until they act", () => {
    const snapshot = wifSnapshot("night1");
    expect(whoIsFakerNeedsAction(snapshot, wifPrivate("me", "night1"))).toBe(true);
    expect(
      whoIsFakerNeedsAction(snapshot, wifPrivate("me", "night1", { nightActionSubmitted: true }))
    ).toBe(false);
    // 天使与白板夜里没有行动资格，不提示；资格只看服务端下发的能力位。
    expect(
      whoIsFakerNeedsAction(
        snapshot,
        wifPrivate("me", "night1", { canActAtNight: false, specialRole: "angel" })
      )
    ).toBe(false);
    expect(
      whoIsFakerNeedsAction(
        snapshot,
        wifPrivate("me", "night1", { canActAtNight: false, specialRole: "blank" })
      )
    ).toBe(false);
  });

  it("prompts the blank to submit a guess unless review is pending", () => {
    const snapshot = wifSnapshot("blankGuess");
    const blank = wifPrivate(WIF_PEOPLE.kita, "blankGuess", {
      canSubmitBlankGuess: true,
      blankGuessUsed: false,
    });
    expect(whoIsFakerNeedsAction(snapshot, blank)).toBe(true);
    expect(
      whoIsFakerNeedsAction(
        { ...snapshot, status: { ...snapshot.status, blankGuessPendingReview: true } },
        blank
      )
    ).toBe(false);
  });

  it("handles both tie-break stages", () => {
    const description = wifSnapshot("tie2");
    expect(whoIsFakerNeedsAction(description, wifPrivate(WIF_PEOPLE.kita, "tie2"))).toBe(true);
    expect(whoIsFakerNeedsAction(description, wifPrivate(WIF_PEOPLE.peach, "tie2"))).toBe(false);

    const vote = wifSnapshot("tieVote2");
    expect(whoIsFakerNeedsAction(vote, wifPrivate("me", "tieVote2"))).toBe(true);
    expect(whoIsFakerNeedsAction(vote, wifPrivate(WIF_PEOPLE.peach, "tieVote2"))).toBe(false);
  });

  it("prompts the questioner to continue after feedback", () => {
    const snapshot = wifFeedbackSnapshot("vote");
    expect(whoIsFakerNeedsAction(snapshot, wifPrivate("host", "vote1"))).toBe(true);
    expect(whoIsFakerNeedsAction(snapshot, wifPrivate("me", "vote1"))).toBe(false);
  });

  it("never prompts an agent-controlled seat or a missing state", () => {
    const snapshot = wifSnapshot("vote1");
    setPageControl({ status: "controlled" });
    expect(whoIsFakerNeedsAction(snapshot, wifPrivate("me", "vote1"))).toBe(false);
    resetPageControl();
    expect(whoIsFakerNeedsAction(null, wifPrivate("me", "vote1"))).toBe(false);
    expect(whoIsFakerNeedsAction(snapshot, null)).toBe(false);
  });

  // 三种发言模式各至少两组快照：提示名单只由「存活、非出题人、未提交、轮到」决定。
  const speechActionCases: {
    name: string;
    stage: WifStage;
    submitted?: string[];
    expected: string[];
  }[] = [
    { name: "描述首轮全员已交", stage: "day1", expected: [] },
    {
      name: "描述次轮进行中",
      stage: "day2",
      expected: [WIF_PEOPLE.me.id, WIF_PEOPLE.kita.id],
    },
    { name: "补充发言进行中", stage: "sup2", expected: [WIF_PEOPLE.yuzu.id] },
    {
      name: "补充发言刚开始",
      stage: "sup2",
      submitted: [],
      expected: [WIF_PEOPLE.kita.id, WIF_PEOPLE.yuzu.id],
    },
    { name: "平票发言进行中", stage: "tie2", expected: [WIF_PEOPLE.kita.id] },
    {
      name: "平票发言刚开始",
      stage: "tie2",
      submitted: [],
      expected: [WIF_PEOPLE.peach.id, WIF_PEOPLE.kita.id],
    },
  ];

  it.each(speechActionCases)("$name：只有该发言的人被提示", ({ stage, submitted, expected }) => {
    const base = wifSnapshot(stage);
    const snapshot =
      submitted === undefined
        ? base
        : { ...base, status: { ...base.status, submittedSpeechPlayerIds: submitted } };
    const prompted = Object.values(WIF_PEOPLE)
      .filter((person) => whoIsFakerNeedsAction(snapshot, wifPrivate(person, stage)))
      .map((person) => person.id);
    expect(prompted.sort()).toEqual([...expected].sort());
  });
});
