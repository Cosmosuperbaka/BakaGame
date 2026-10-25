import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ChatMessage } from "@bakagame/shared";

const { playSound } = vi.hoisted(() => ({ playSound: vi.fn() }));

vi.mock("@/lib/SoundEffects", () => ({ playSound }));

import { CEESoundBridge } from "@/components/cee/CEESoundBridge";
import { ceePrivateState, ceeSnapshot } from "@/stories/fixtures/CEE";
import { useCEEStore } from "@/stores/UseCEEStore";

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
  useCEEStore.setState({ snapshot: null, privateState: null, roomId: null });
});

describe("CEESoundBridge", () => {
  it("sounds for a new chat message from another player", () => {
    const history = [message("cee-chat-old", "other")];
    const snapshot = ceeSnapshot({ roomId: "1234", chat: history });
    const privateState = ceePrivateState({ playerId: "me" });
    useCEEStore.setState({ snapshot, privateState, roomId: snapshot.roomId });

    render(<CEESoundBridge />);
    expect(playSound).not.toHaveBeenCalled();

    act(() => {
      useCEEStore.setState({
        snapshot: { ...snapshot, chat: [...history, message("cee-chat-new", "other")] },
      });
    });
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith("chatMessage");
  });
});
