import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAutoSave } from "./UseAutoSave";

describe("useAutoSave", () => {
  afterEach(() => vi.useRealTimers());

  it("debounces edits and only submits the latest draft", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ value }) => useAutoSave({ value }, save), {
      initialProps: { value: 0 },
    });

    rerender({ value: 1 });
    rerender({ value: 2 });
    await act(async () => {
      vi.advanceTimersByTime(399);
    });
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ value: 2 });
  });

  it("does not submit a stale draft after editing back to the saved value", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ value }) => useAutoSave({ value }, save), {
      initialProps: { value: 0 },
    });

    rerender({ value: 1 });
    rerender({ value: 0 });
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("queues the latest value while a save is in flight", async () => {
    vi.useFakeTimers();
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const save = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(undefined);
    const { rerender } = renderHook(({ value }) => useAutoSave(value, save), {
      initialProps: { value: 0 },
    });

    rerender({ value: 1 });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(save).toHaveBeenCalledWith(1);

    rerender({ value: 2 });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst();
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(2);
  });

  it("does not retry a failed value until it changes", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const save = vi.fn().mockRejectedValue(new Error("offline"));
    const { rerender } = renderHook(({ value }) => useAutoSave(value, save, { onError }), {
      initialProps: { value: 0 },
    });

    rerender({ value: 1 });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(save).toHaveBeenCalledTimes(1);

    rerender({ value: 2 });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("flushes the latest draft when unmounted", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(({ value }) => useAutoSave(value, save), {
      initialProps: { value: 0 },
    });

    rerender({ value: 1 });
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(1);
  });

  it("flushes edits made during an in-flight save after unmount", async () => {
    vi.useFakeTimers();
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const save = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(undefined);
    const { rerender, unmount } = renderHook(({ value }) => useAutoSave(value, save), {
      initialProps: { value: 0 },
    });

    rerender({ value: 1 });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    rerender({ value: 2 });
    unmount();

    await act(async () => {
      resolveFirst();
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(2);
  });
});
