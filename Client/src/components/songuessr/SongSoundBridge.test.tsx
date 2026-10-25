import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ChatMessage } from "@bakagame/shared";

const { playSound } = vi.hoisted(() => ({ playSound: vi.fn() }));

vi.mock("@/lib/SoundEffects", () => ({ playSound }));

import { SongSoundBridge } from "@/components/songuessr/SongSoundBridge";
import { SONG_PEOPLE, songChat, songPrivate, songSnapshot } from "@/stories/fixtures/SonGuessr";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";

const message = (id: string, playerId: string): ChatMessage => ({
  id,
  playerId,
  playerName: playerId,
  text: id,
  createdAt: 1,
  system: false,
});

beforeEach(() => {
  playSound.mockClear();
});

afterEach(() => {
  cleanup();
  useSonGuessrStore.setState({ snapshot: null, privateState: null, roomId: null });
});

describe("SongSoundBridge", () => {
  it("sounds when singing turns into the local player's turn and on a new chat message", async () => {
    const history = songChat({ playing: true });
    const snapshot = songSnapshot({ phase: "playing", roundNumber: 1, chat: history });
    const privateState = songPrivate({ canGuess: false });
    useSonGuessrStore.setState({ snapshot, privateState, roomId: snapshot.roomId });

    render(<SongSoundBridge />);
    expect(playSound).not.toHaveBeenCalled();

    act(() => {
      useSonGuessrStore.setState({ privateState: { ...privateState, canGuess: true } });
    });
    await waitFor(() => expect(playSound).toHaveBeenCalledWith("actionRequired"));
    expect(playSound).toHaveBeenCalledTimes(1);
    playSound.mockClear();

    act(() => {
      useSonGuessrStore.setState({
        snapshot: {
          ...snapshot,
          chat: [...history, message("song-chat-new", SONG_PEOPLE.peach.id)],
        },
      });
    });
    await waitFor(() => expect(playSound).toHaveBeenCalledWith("chatMessage"));
    expect(playSound).toHaveBeenCalledTimes(1);
  });
});
