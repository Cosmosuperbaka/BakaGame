import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCopyFeedback } from "./UseCopyFeedback";

describe("useCopyFeedback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const stubClipboard = (writeText: (text: string) => Promise<void>) =>
    vi.stubGlobal("navigator", { clipboard: { writeText } });

  it("复制成功后标记是哪一个，过了时长自动清掉", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const { result } = renderHook(() => useCopyFeedback(1_000));
    let ok = false;
    await act(async () => {
      ok = await result.current.copy("abc", "code");
    });
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("abc");
    expect(result.current.copied).toBe("code");
    act(() => vi.advanceTimersByTime(999));
    expect(result.current.copied).toBe("code");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.copied).toBeNull();
  });

  it("连续复制按最后一次重新计时，换一个键标记随之改变", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const { result } = renderHook(() => useCopyFeedback(1_000));
    await act(async () => {
      await result.current.copy("a", "first");
    });
    act(() => vi.advanceTimersByTime(800));
    await act(async () => {
      await result.current.copy("b", "second");
    });
    act(() => vi.advanceTimersByTime(800));
    expect(result.current.copied).toBe("second");
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.copied).toBeNull();
  });

  it("写入被拒绝或没有剪贴板接口时返回 false，不标记已复制，也不抛出", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const { result } = renderHook(() => useCopyFeedback());
    let ok = true;
    await act(async () => {
      ok = await result.current.copy("x");
    });
    expect(ok).toBe(false);
    expect(result.current.copied).toBeNull();

    vi.stubGlobal("navigator", {});
    await act(async () => {
      ok = await result.current.copy("x");
    });
    expect(ok).toBe(false);
    expect(result.current.copied).toBeNull();
  });

  it("卸载后不再改状态", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const { result, unmount } = renderHook(() => useCopyFeedback(1_000));
    await act(async () => {
      await result.current.copy("x");
    });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
