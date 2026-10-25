import { describe, expect, it } from "vitest";

import { SONG_PEOPLE, songPrivate, songSnapshot } from "@/stories/fixtures/SonGuessr";
import { sonGuessrNeedsAction } from "@/lib/SonGuessrActionSignals";

describe("sonGuessrNeedsAction", () => {
  it("is true when it is the local player's turn to submit a song", () => {
    const snapshot = songSnapshot({ phase: "submittingSong", roundNumber: 1 });
    expect(sonGuessrNeedsAction(snapshot, songPrivate({ canSubmitSong: true }))).toBe(true);
    expect(sonGuessrNeedsAction(snapshot, songPrivate({ canSubmitSong: false }))).toBe(false);
  });

  it("is true while the local player can guess", () => {
    const snapshot = songSnapshot({ phase: "playing", roundNumber: 1 });
    expect(sonGuessrNeedsAction(snapshot, songPrivate({ canGuess: true }))).toBe(true);
    expect(sonGuessrNeedsAction(snapshot, songPrivate({ canGuess: false, canGiveUp: true }))).toBe(
      false
    );
  });

  it("prompts the host to assign a submitter only when candidates exist", () => {
    const snapshot = songSnapshot({ phase: "choosingSubmitter", roundNumber: 1 });
    expect(
      sonGuessrNeedsAction(
        snapshot,
        songPrivate({
          playerId: SONG_PEOPLE.host.id,
          submitterCandidateIds: [SONG_PEOPLE.me.id],
        })
      )
    ).toBe(true);
    expect(
      sonGuessrNeedsAction(
        snapshot,
        songPrivate({ playerId: SONG_PEOPLE.host.id, submitterCandidateIds: [] })
      )
    ).toBe(false);
    expect(
      sonGuessrNeedsAction(
        snapshot,
        songPrivate({
          playerId: SONG_PEOPLE.me.id,
          submitterCandidateIds: [SONG_PEOPLE.host.id],
        })
      )
    ).toBe(false);
  });

  it("never prompts a seat controlled by an agent or without both states", () => {
    const snapshot = songSnapshot({ phase: "playing", roundNumber: 1 });
    expect(
      sonGuessrNeedsAction(snapshot, songPrivate({ canGuess: true, mcpControlled: true }))
    ).toBe(false);
    expect(sonGuessrNeedsAction(null, songPrivate({ canGuess: true }))).toBe(false);
    expect(sonGuessrNeedsAction(snapshot, null)).toBe(false);
  });
});
