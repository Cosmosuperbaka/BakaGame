import { describe, expect, it } from "vitest";

import { applyStatePatch, consumeStateSync } from "./StateSync";

describe("state sync", () => {
  it("applies nested changes, appends and deletes without mutating the baseline", () => {
    const baseline = { players: [{ id: "p1", online: true }], status: { phase: "waiting" }, old: 1 };
    const next = applyStatePatch(baseline, [
      { op: "set", path: ["players", 0, "online"], value: false },
      { op: "set", path: ["players", 1], value: { id: "p2", online: true } },
      { op: "set", path: ["status", "phase"], value: "description" },
      { op: "delete", path: ["old"] },
    ]);

    expect(next).toEqual({
      players: [{ id: "p1", online: false }, { id: "p2", online: true }],
      status: { phase: "description" },
    });
    expect(baseline.players).toEqual([{ id: "p1", online: true }]);
  });

  it("rejects a patch with a missing revision and recovers from a full sync", () => {
    expect(consumeStateSync({ value: 1 }, 4, {
      mode: "patch",
      baseRevision: 5,
      revision: 6,
      operations: [{ op: "set", path: ["value"], value: 2 }],
    }).needsFullSync).toBe(true);

    expect(consumeStateSync(null, undefined, {
      mode: "full",
      revision: 8,
      state: { value: 3 },
    })).toEqual({ state: { value: 3 }, revision: 8, needsFullSync: false });
  });

  it("rejects unversioned state instead of guessing the protocol", () => {
    expect(consumeStateSync({ value: 1 }, 1, { value: 2 })).toEqual({
      needsFullSync: true,
    });
  });

  it("正确处理数组元素删除，不生成稀疏数组", () => {
    const baseline = { list: ["a", "b", "c"] };
    const next = applyStatePatch(baseline, [
      { op: "delete", path: ["list", 1] },
    ]);
    expect(next.list).toEqual(["a", "c"]);
    expect(next.list.length).toBe(2);
  });
});
