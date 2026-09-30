import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubMatchMedia } from "@/test/MatchMedia";
import { useCloseFrom } from "./UseCloseFrom";

describe("useCloseFrom", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("打开期间视口越过断点时请求关闭", () => {
    const media = stubMatchMedia(false);
    const onOpenChange = vi.fn();
    renderHook(() => useCloseFrom(true, onOpenChange, "md"));
    expect(media.queries).toEqual(["(min-width: 48rem)"]);
    expect(onOpenChange).not.toHaveBeenCalled();
    media.crossBreakpoint(true);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("关闭时不订阅，卸载后移除监听", () => {
    const media = stubMatchMedia(false);
    const onOpenChange = vi.fn();
    const { rerender, unmount } = renderHook(({ open }) => useCloseFrom(open, onOpenChange, "xl"), { initialProps: { open: false } });
    expect(media.queries).toEqual([]);
    rerender({ open: true });
    expect(media.queries).toEqual(["(min-width: 80rem)"]);
    expect(media.listenerCount).toBe(1);
    unmount();
    expect(media.listenerCount).toBe(0);
  });
});
