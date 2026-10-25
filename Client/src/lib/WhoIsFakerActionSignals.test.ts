import { describe, expect, it } from "vitest";

import {
  WIF_PEOPLE,
  wifFeedbackSnapshot,
  wifPrivate,
  wifSnapshot,
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
    expect(whoIsFakerNeedsAction(snapshot, wifPrivate("me", "night1", { role: "angel" }))).toBe(
      false
    );
    expect(whoIsFakerNeedsAction(snapshot, wifPrivate("me", "night1", { role: "blank" }))).toBe(
      false
    );
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
    expect(
      whoIsFakerNeedsAction(snapshot, wifPrivate("me", "vote1", { mcpControlled: true }))
    ).toBe(false);
    expect(whoIsFakerNeedsAction(null, wifPrivate("me", "vote1"))).toBe(false);
    expect(whoIsFakerNeedsAction(snapshot, null)).toBe(false);
  });
});
