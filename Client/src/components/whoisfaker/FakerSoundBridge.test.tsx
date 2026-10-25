import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ChatMessage } from "@bakagame/shared";

const { playSound } = vi.hoisted(() => ({ playSound: vi.fn() }));

vi.mock("@/lib/SoundEffects", () => ({ playSound }));

import { FakerSoundBridge } from "@/components/whoisfaker/FakerSoundBridge";
import { WIF_PEOPLE, wifPrivate, wifSnapshot } from "@/stories/fixtures/WhoIsFaker";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";

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
  useWhoIsFakerStore.setState({ snapshot: null, privateState: null, roomId: null });
});

describe("FakerSoundBridge", () => {
  it("sounds when the local player becomes able to vote and on a new chat message", async () => {
    const snapshot = wifSnapshot("vote1");
    const privateState = wifPrivate("me", "vote1", {
      myCurrentVoteTargetId: WIF_PEOPLE.peach.id,
    });
    useWhoIsFakerStore.setState({ snapshot, privateState, roomId: snapshot.roomId });

    render(<FakerSoundBridge />);
    expect(playSound).not.toHaveBeenCalled();

    act(() => {
      useWhoIsFakerStore.setState({
        privateState: { ...privateState, myCurrentVoteTargetId: undefined },
      });
    });
    await waitFor(() => expect(playSound).toHaveBeenCalledWith("actionRequired"));
    expect(playSound).toHaveBeenCalledTimes(1);
    playSound.mockClear();

    act(() => {
      useWhoIsFakerStore.setState({
        snapshot: {
          ...snapshot,
          chat: [...snapshot.chat, message("faker-chat-new", WIF_PEOPLE.peach.id)],
        },
      });
    });
    await waitFor(() => expect(playSound).toHaveBeenCalledWith("chatMessage"));
    expect(playSound).toHaveBeenCalledTimes(1);
  });
});
