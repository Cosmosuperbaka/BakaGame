import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ChatMessage } from "@bakagame/shared";

const { playSound } = vi.hoisted(() => ({ playSound: vi.fn() }));

vi.mock("@/lib/SoundEffects", () => ({ playSound }));

import { useRoomSounds } from "@/hooks/UseRoomSounds";

const message = (id: string, playerId: string): ChatMessage => ({
  id,
  playerId,
  playerName: playerId,
  text: id,
  createdAt: 1,
  system: false,
});

type Input = Parameters<typeof useRoomSounds>[0];

const base: Input = {
  roomId: "r1",
  storeRoomId: "r1",
  chat: [message("a", "other")],
  selfPlayerId: "me",
  hasSnapshotAndPrivate: true,
  needsAction: false,
};

beforeEach(() => {
  playSound.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// act 返回 thenable，而这里只推进定时器、不等异步副作用；显式 void 表明是有意忽略。
const flush = () => void act(() => vi.advanceTimersByTime(200));

const render = (initialProps: Input) =>
  renderHook((props: Input) => useRoomSounds(props), { initialProps });

describe("useRoomSounds", () => {
  it("挂载时已有的行动态只作基线，不补响", () => {
    render({ ...base, needsAction: true });
    flush();
    expect(playSound).not.toHaveBeenCalled();
  });

  it("行动态从无到有时响一次，重复为真不再响", () => {
    const { rerender } = render(base);
    rerender({ ...base, needsAction: true });
    flush();
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith("actionRequired");

    rerender({ ...base, needsAction: true });
    flush();
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  it("needsAction 为 null 时永远不响行动提示，聊天照常", () => {
    const { rerender } = render({ ...base, needsAction: null });
    rerender({ ...base, needsAction: null, chat: [...base.chat!, message("b", "other")] });
    flush();
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith("chatMessage");
    expect(playSound).not.toHaveBeenCalledWith("actionRequired");
  });

  it("快照与私有态未齐或房间不一致时不响行动提示", () => {
    const { rerender } = render({ ...base, storeRoomId: "other", needsAction: false });
    rerender({ ...base, storeRoomId: "other", needsAction: true });
    flush();
    expect(playSound).not.toHaveBeenCalled();

    // 就绪时当前值只作基线；之后再一次从无到有才响。
    rerender({ ...base, needsAction: true });
    flush();
    expect(playSound).not.toHaveBeenCalled();
    rerender({ ...base, needsAction: false });
    flush();
    rerender({ ...base, needsAction: true });
    flush();
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith("actionRequired");
  });

  it("聊天只对他人新消息响一次，重复快照不重响", () => {
    const { rerender } = render(base);
    const withNew = [...base.chat!, message("b", "other")];
    rerender({ ...base, chat: withNew });
    flush();
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith("chatMessage");

    rerender({ ...base, chat: withNew });
    flush();
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  it("没有行动提示的玩法（传 null）始终不响行动提示", () => {
    const { rerender } = render({ ...base, needsAction: null });
    rerender({ ...base, needsAction: null, chat: base.chat });
    flush();
    expect(playSound).not.toHaveBeenCalledWith("actionRequired");

    // 中途变成「就绪」也不响：null 不是「需要行动」
    rerender({ ...base, needsAction: null, hasSnapshotAndPrivate: false });
    rerender({ ...base, needsAction: null, hasSnapshotAndPrivate: true });
    flush();
    expect(playSound).not.toHaveBeenCalledWith("actionRequired");
  });
});
