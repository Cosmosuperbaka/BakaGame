import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ChatMessage } from "@bakagame/shared";

const { playSound } = vi.hoisted(() => ({ playSound: vi.fn() }));

vi.mock("@/lib/SoundEffects", () => ({ playSound }));

import { useActionRequiredSound, useChatMessageSound } from "@/hooks/UseNotificationSounds";

const message = (id: string, playerId: string, system = false): ChatMessage => ({
  id,
  playerId,
  playerName: playerId,
  text: id,
  createdAt: 1,
  system,
});

beforeEach(() => {
  playSound.mockClear();
});

describe("useActionRequiredSound", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const flush = () => act(() => vi.advanceTimersByTime(200));

  type Props = { needsAction: boolean; ready: boolean; roomKey: string | null };
  const render = (initialProps: Props) =>
    renderHook(
      (props: Props) => useActionRequiredSound(props.needsAction, props.roomKey, props.ready),
      { initialProps }
    );

  it("does not sound for the state already present on mount", () => {
    render({ needsAction: true, ready: true, roomKey: "r1" });
    flush();
    expect(playSound).not.toHaveBeenCalled();
  });

  it("sounds only on the false-to-true edge", () => {
    const { rerender } = render({ needsAction: false, ready: true, roomKey: "r1" });
    rerender({ needsAction: true, ready: true, roomKey: "r1" });
    flush();
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith("actionRequired");

    rerender({ needsAction: true, ready: true, roomKey: "r1" });
    flush();
    expect(playSound).toHaveBeenCalledTimes(1);

    rerender({ needsAction: false, ready: true, roomKey: "r1" });
    flush();
    rerender({ needsAction: true, ready: true, roomKey: "r1" });
    flush();
    expect(playSound).toHaveBeenCalledTimes(2);
  });

  it("takes a new baseline when the room changes", () => {
    const { rerender } = render({ needsAction: false, ready: true, roomKey: "r1" });
    rerender({ needsAction: true, ready: true, roomKey: "r2" });
    flush();
    expect(playSound).not.toHaveBeenCalled();

    rerender({ needsAction: false, ready: true, roomKey: "r2" });
    flush();
    rerender({ needsAction: true, ready: true, roomKey: "r2" });
    flush();
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  it("does not sound for a restore that becomes ready while already actionable", () => {
    const { rerender } = render({ needsAction: false, ready: false, roomKey: "r1" });
    rerender({ needsAction: true, ready: false, roomKey: "r1" });
    flush();
    expect(playSound).not.toHaveBeenCalled();

    rerender({ needsAction: true, ready: true, roomKey: "r1" });
    flush();
    expect(playSound).not.toHaveBeenCalled();

    rerender({ needsAction: false, ready: true, roomKey: "r1" });
    flush();
    rerender({ needsAction: true, ready: true, roomKey: "r1" });
    flush();
    expect(playSound).toHaveBeenCalledTimes(1);
  });
});

describe("useChatMessageSound", () => {
  type Props = {
    messages: readonly ChatMessage[] | null;
    selfPlayerId: string | null;
    roomKey: string | null;
  };
  const render = (initialProps: Props) =>
    renderHook(
      (props: Props) => useChatMessageSound(props.messages, props.selfPlayerId, props.roomKey),
      { initialProps }
    );

  const history = [message("a", "other"), message("b", "me")];
  const base: Props = { messages: history, selfPlayerId: "me", roomKey: "r1" };

  it("treats the first snapshot as history, not a new notification", () => {
    render(base);
    expect(playSound).not.toHaveBeenCalled();
  });

  it("sounds once for new messages from other players", () => {
    const { rerender } = render(base);
    rerender({ ...base, messages: [...history, message("c", "other")] });
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith("chatMessage");

    rerender({ ...base, messages: [...history, message("c", "other")] });
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  it("ignores own messages and system notices", () => {
    const { rerender } = render(base);
    const withNoise = [...history, message("c", "me"), message("d", "system", true)];
    rerender({ ...base, messages: withNoise });
    expect(playSound).not.toHaveBeenCalled();

    rerender({ ...base, messages: [...withNoise, message("e", "other")] });
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  it("plays one sound when several other-player messages arrive together", () => {
    const { rerender } = render(base);
    rerender({
      ...base,
      messages: [...history, message("c", "other"), message("d", "other2")],
    });
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  it("resets the baseline while the room is not ready", () => {
    const { rerender } = render(base);
    rerender({ ...base, messages: null, roomKey: null });
    rerender(base);
    expect(playSound).not.toHaveBeenCalled();

    rerender({ ...base, messages: [...history, message("c", "other")] });
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  it("does not attribute messages to self until the seat is known", () => {
    const { rerender } = render({ ...base, selfPlayerId: null });
    rerender({ ...base, selfPlayerId: null, messages: [...history, message("c", "other")] });
    expect(playSound).not.toHaveBeenCalled();

    rerender({ ...base, messages: [...history, message("c", "other")] });
    rerender({
      ...base,
      messages: [...history, message("c", "other"), message("d", "other")],
    });
    expect(playSound).toHaveBeenCalledTimes(1);
  });
});
