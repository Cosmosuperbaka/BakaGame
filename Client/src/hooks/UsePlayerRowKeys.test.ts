import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePlayerRowKeys } from "./UsePlayerRowKeys";

type Entries = Array<{ id: string; group: string }>;

describe("usePlayerRowKeys", () => {
  it("换组一次 key 变一次，换回原组也不复用旧 key", () => {
    const { result, rerender } = renderHook(({ entries }: { entries: Entries }) => usePlayerRowKeys(entries), {
      initialProps: { entries: [{ id: "a", group: "active" }, { id: "b", group: "active" }] },
    });
    const first = result.current("a");
    rerender({ entries: [{ id: "a", group: "spectator" }, { id: "b", group: "active" }] });
    const second = result.current("a");
    rerender({ entries: [{ id: "a", group: "active" }, { id: "b", group: "active" }] });
    const third = result.current("a");

    expect(new Set([first, second, third]).size).toBe(3);
    // 没换组的人 key 不变，不会被无故重挂载。
    expect(result.current("b")).toBe("b:0");
  });

  it("离开后再回来算一次换组", () => {
    const { result, rerender } = renderHook(({ entries }: { entries: Entries }) => usePlayerRowKeys(entries), {
      initialProps: { entries: [{ id: "a", group: "active" }] },
    });
    const before = result.current("a");
    rerender({ entries: [] });
    rerender({ entries: [{ id: "a", group: "active" }] });
    expect(result.current("a")).not.toBe(before);
  });
});
