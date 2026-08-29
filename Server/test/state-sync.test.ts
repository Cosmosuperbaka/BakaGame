import { expect, test } from "bun:test";

import { createEvent } from "../src/transport/protocol";
import { buildStatePatch, StateSyncEncoder } from "../src/transport/state-sync";

test("状态补丁只编码变化路径与数组追加项", () => {
  expect(buildStatePatch(
    { players: [{ id: "p1", ready: false }], chat: [] },
    { players: [{ id: "p1", ready: true }], chat: [{ id: "c1", text: "你好" }] },
  )).toEqual([
    { op: "set", path: ["players", 0, "ready"], value: true },
    { op: "set", path: ["chat", 0], value: { id: "c1", text: "你好" } },
  ]);
});

test("数组缩短时直接发送数组整体替换操作", () => {
  expect(buildStatePatch(
    { players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] },
    { players: [{ id: "p1" }] },
  )).toEqual([
    { op: "set", path: ["players"], value: [{ id: "p1" }] },
  ]);
});

test("编码器发送首个全量、连续补丁并省略无变化私有状态", () => {
  const encoder = new StateSyncEncoder();
  const filler = "x".repeat(1_000);
  const first = encoder.encode(createEvent("room.snapshot", { value: 1, filler }));
  const unchanged = encoder.encode(createEvent("room.snapshot", { value: 1, filler }));
  const changed = encoder.encode(createEvent("room.snapshot", { value: 2, filler }));

  expect(first[0]).toMatchObject({ payload: { mode: "full", revision: 1 } });
  expect(unchanged).toEqual([]);
  expect(changed[0]).toMatchObject({
    payload: {
      mode: "patch",
      baseRevision: 1,
      revision: 2,
      operations: [{ op: "set", path: ["value"], value: 2 }],
    },
  });
});

test("编码器每分钟用全量状态校准补丁链", () => {
  let now = 0;
  const encoder = new StateSyncEncoder({ now: () => now });
  encoder.encode(createEvent("room.snapshot", { value: 1, filler: "x".repeat(1_000) }));
  now = 60_000;

  expect(encoder.encode(createEvent("room.snapshot", {
    value: 2,
    filler: "x".repeat(1_000),
  }))[0]).toMatchObject({ payload: { mode: "full", revision: 2 } });
});

test("校准调用会在无业务变化时按周期重发全量状态", () => {
  let now = 0;
  const encoder = new StateSyncEncoder({ now: () => now });
  const state = createEvent("room.snapshot", { value: 1 });
  encoder.encode(state);

  now = 59_999;
  expect(encoder.encode(state, { calibration: true })).toEqual([]);
  now = 60_000;
  expect(encoder.encode(state, { calibration: true })[0]).toMatchObject({
    payload: { mode: "full", revision: 1, state: { value: 1 } },
  });
  expect(encoder.encode(state, { calibration: true })).toEqual([]);
});
