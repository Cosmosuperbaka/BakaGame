import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IDLE_SEARCH_MS, useIdleSearch } from "./UseIdleSearch";

const describeError = () => "失败";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("停止输入后才发起查询", async () => {
  const search = vi.fn().mockResolvedValue(["a"]);
  renderHook(() => useIdleSearch("角色", search, describeError));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(IDLE_SEARCH_MS - 1);
  });
  expect(search).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(search).toHaveBeenCalledWith("角色");
});

it("空关键词时点查询不会让下一次输入跳过防抖", async () => {
  const search = vi.fn().mockResolvedValue([]);
  const { result, rerender } = renderHook(
    ({ keyword }) => useIdleSearch(keyword, search, describeError),
    {
      initialProps: { keyword: "" },
    }
  );
  act(() => result.current.flush());
  rerender({ keyword: "a" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(IDLE_SEARCH_MS - 1);
  });
  expect(search).not.toHaveBeenCalled();
});

it("有关键词时 flush 立即查询", async () => {
  const search = vi.fn().mockResolvedValue([]);
  const { result } = renderHook(() => useIdleSearch("a", search, describeError));
  act(() => result.current.flush());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(search).toHaveBeenCalledTimes(1);
});
