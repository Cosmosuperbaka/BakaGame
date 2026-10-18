import { StrictMode } from "react";

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  markPendingRestore,
  peekPendingRestore,
  saveRoomSettingsMemory,
  type FakerRoomSettingsMemory,
  type SongRoomSettingsMemory,
} from "@/lib/RoomSettingsMemory";
import { useRoomSettingsRestore } from "./UseRoomSettingsRestore";

const fakerMemory: FakerRoomSettingsMemory = {
  revealRoleOnDeath: true,
  roleConfig: { undercoverCount: 2, hasAngel: false, hasBlank: true },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

describe("useRoomSettingsRestore", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("没有标记时直接放行，不发送任何命令", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(() => useRoomSettingsRestore("faker", "ROOM1", send));

    expect(hook.result.current).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("标记匹配时重放设置、消费标记，完成后放行", async () => {
    saveRoomSettingsMemory("faker", fakerMemory);
    markPendingRestore("faker", "ROOM1");
    const ack = deferred<void>();
    const send = vi.fn(() => ack.promise);
    const hook = renderHook(() => useRoomSettingsRestore("faker", "ROOM1", send));

    // 发送在途期间保持占位，避免设置面板的草稿先于恢复落定。
    expect(send).toHaveBeenCalledExactlyOnceWith(fakerMemory, "ROOM1");
    expect(hook.result.current).toBe(true);
    expect(peekPendingRestore("faker")).toBeNull();

    await act(async () => {
      ack.resolve();
    });
    expect(hook.result.current).toBe(false);
  });

  it("发送失败也放行界面，标记已消费不再重试", async () => {
    saveRoomSettingsMemory("faker", fakerMemory);
    markPendingRestore("faker", "ROOM1");
    const send = vi.fn().mockRejectedValue(new Error("离线"));
    const hook = renderHook(() => useRoomSettingsRestore("faker", "ROOM1", send));

    await waitFor(() => expect(hook.result.current).toBe(false));
    expect(peekPendingRestore("faker")).toBeNull();
  });

  it("标记属于别的房间时不触发也不消费", () => {
    const songMemory: SongRoomSettingsMemory = {
      game: {
        lyricsLineCount: 2,
        showLyrics: true,
        maxGuessesPerRound: 3,
        guessDurationSeconds: 20,
        showGuessTimer: false,
        bloodMode: true,
      },
    };
    saveRoomSettingsMemory("song", songMemory);
    markPendingRestore("song", "ROOM-A");
    const send = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(() => useRoomSettingsRestore("song", "ROOM-B", send));

    expect(hook.result.current).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(peekPendingRestore("song")).toBe("ROOM-A");
  });

  it("有标记但还没有任何设置记忆时直接放行", () => {
    markPendingRestore("faker", "ROOM2");
    const send = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(() => useRoomSettingsRestore("faker", "ROOM2", send));

    expect(hook.result.current).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("StrictMode 重挂载共享同一次恢复，不重复发送", async () => {
    saveRoomSettingsMemory("faker", fakerMemory);
    markPendingRestore("faker", "ROOM1");
    const send = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(() => useRoomSettingsRestore("faker", "ROOM1", send), {
      wrapper: StrictMode,
    });

    await waitFor(() => expect(hook.result.current).toBe(false));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
