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

  it("does not trigger save when object keys are reordered (fast-deep-equal)", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ value }) => useAutoSave(value, save), {
      initialProps: { value: { a: 1, b: 2 } as Record<string, number> },
    });

    // 重新排序 key，但内容实质相等
    rerender({ value: { b: 2, a: 1 } });
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

  it("clears pending debounced draft and cancels timer when enabled changes from true to false", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ value, enabled }) => useAutoSave(value, save, { enabled }),
      {
        initialProps: { value: 0, enabled: true },
      },
    );

    // 产生新草稿（在防抖等待期内）
    rerender({ value: 1, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(save).not.toHaveBeenCalled();

    // 阶段切换，enabled 从 true 变为 false
    rerender({ value: 1, enabled: false });

    // 时间推进超过防抖延迟及更久
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });

    // 待处理防抖草稿已被清除，定时器取消，不向外发送请求
    expect(save).not.toHaveBeenCalled();
  });

  it("does not trigger save on unmount when enabled is false", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(
      ({ value, enabled }) => useAutoSave(value, save, { enabled }),
      {
        initialProps: { value: 0, enabled: false },
      },
    );

    // 在 enabled === false 状态下更新值
    rerender({ value: 1, enabled: false });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(save).not.toHaveBeenCalled();

    // 卸载组件
    unmount();
    await act(async () => {
      await Promise.resolve();
    });

    // 绝对不向外触发保存
    expect(save).not.toHaveBeenCalled();
  });

  it("discards subsequent draft queued during in-flight save when enabled becomes false", async () => {
    vi.useFakeTimers();
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const save = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(undefined);
    const { rerender } = renderHook(
      ({ value, enabled }) => useAutoSave(value, save, { enabled }),
      {
        initialProps: { value: 0, enabled: true },
      },
    );

    // 触发第一次保存，进入飞行中（in-flight）
    rerender({ value: 1, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(1);

    // 第一次保存仍在飞行中，产生新值 2
    rerender({ value: 2, enabled: true });

    // 阶段切换，enabled 变为 false
    rerender({ value: 2, enabled: false });

    // 第一次保存完成
    await act(async () => {
      resolveFirst();
      await vi.advanceTimersByTimeAsync(500);
    });

    // 后续草稿已被丢弃，不会发送后续保存
    expect(save).toHaveBeenCalledTimes(1);
  });
});
