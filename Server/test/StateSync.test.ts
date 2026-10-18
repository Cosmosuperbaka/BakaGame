import { expect, test } from "bun:test";
import { applyPatch } from "fast-json-patch";

import { createEvent } from "../src/transport/Packets";
import {
  buildStatePatch,
  createStateSyncSender,
  STATE_BACKLOG_RESUME_BYTES,
  STATE_BACKLOG_SHED_BYTES,
  StateSyncEncoder,
} from "../src/transport/StateSync";

test("状态补丁只编码变化路径与数组追加项", () => {
  expect(
    buildStatePatch(
      { players: [{ id: "p1", ready: false }], chat: [] },
      { players: [{ id: "p1", ready: true }], chat: [{ id: "c1", text: "你好" }] }
    )
  ).toEqual([
    { op: "add", path: "/chat/0", value: { id: "c1", text: "你好" } },
    { op: "replace", path: "/players/0/ready", value: true },
  ]);
});

test("数组缩短时精准生成 remove 逆向删除操作", () => {
  expect(
    buildStatePatch(
      { players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] },
      { players: [{ id: "p1" }] }
    )
  ).toEqual([
    { op: "remove", path: "/players/2" },
    { op: "remove", path: "/players/1" },
  ]);
});

test("聊天窗口挤掉最旧一条时只发两条操作", () => {
  const message = (index: number) => ({
    id: `c${index}`,
    text: `第${index}条`,
    at: 1_700_000_000_000 + index,
  });
  const window = (end: number) =>
    Array.from({ length: 20 }, (_, index) => message(end - 19 + index));
  const previous = { chat: window(20), status: { phase: "description" } };
  const next = { chat: window(21), status: { phase: "description" } };
  const operations = buildStatePatch(previous, next);

  expect(operations).toEqual([
    { op: "remove", path: "/chat/0" },
    { op: "add", path: "/chat/19", value: message(21) },
  ]);
  // 与客户端同一套用补丁方式（validate=true）：套完必须正好等于新状态。
  const applied = applyPatch(
    JSON.parse(JSON.stringify(previous)) as object,
    operations as never,
    true
  ).newDocument;
  expect(applied).toEqual(next);
});

test("窗口挤动不再退化成整份重发", () => {
  const encoder = new StateSyncEncoder();
  const message = (index: number) => ({ id: `c${index}`, text: "x".repeat(60), at: index });
  const window = (end: number) => ({
    chat: Array.from({ length: 20 }, (_, index) => message(end - 19 + index)),
  });
  encoder.encode(createEvent("room.snapshot", window(20)));
  const shifted = encoder.encode(createEvent("room.snapshot", window(21)));

  // 通用差分在这里会产出比整份快照还大的补丁（20 条消息逐个改写下标），于是退回全量；
  // 走窗口快路径后只剩两条操作，仍然发补丁。
  expect(shifted[0]).toMatchObject({ payload: { mode: "patch", operations: { length: 2 } } });
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
      operations: [{ op: "replace", path: "/value", value: 2 }],
    },
  });
});

test("编码器每分钟用全量状态校准补丁链", () => {
  let now = 0;
  const encoder = new StateSyncEncoder({ now: () => now });
  encoder.encode(createEvent("room.snapshot", { value: 1, filler: "x".repeat(1_000) }));
  now = 60_000;

  expect(
    encoder.encode(
      createEvent("room.snapshot", {
        value: 2,
        filler: "x".repeat(1_000),
      })
    )[0]
  ).toMatchObject({ payload: { mode: "full", revision: 2 } });
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

test("快照内嵌活动领域对象时，补丁基线仍是准备时刻的值", () => {
  const encoder = new StateSyncEncoder();
  // 视图构建器可能把领域对象直接挂进快照；准备时必须留下当时值的副本，
  // 否则下一次发布拿到的基线已经被原地改写，客户端永远收不到这处变化。
  const settings = { rounds: 5, anonymous: true };
  const bulk = { chat: Array.from({ length: 40 }, (_, index) => ({ id: `c${index}` })) };

  encoder.encode(createEvent("room.snapshot", { ...bulk, phase: "describing", settings }));
  settings.rounds = 9;

  const encoded = encoder.encode(
    createEvent("room.snapshot", { ...bulk, phase: "voting", settings })
  )[0];
  expect(encoded).toMatchObject({ payload: { mode: "patch", baseRevision: 1, revision: 2 } });
  const operations = (encoded as { payload: { operations: unknown[] } }).payload.operations;
  expect(operations).toHaveLength(2);
  expect(operations).toEqual(
    expect.arrayContaining([
      { op: "replace", path: "/phase", value: "voting" },
      { op: "replace", path: "/settings/rounds", value: 9 },
    ])
  );
});

test("补丁规模接近全量时改发全量，小改动仍走补丁", () => {
  const encoder = new StateSyncEncoder();
  const fields = (suffix: string) =>
    Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`field${index}`, `value-${index}${suffix}`])
    );

  expect(encoder.encode(createEvent("room.snapshot", fields("")))[0]).toMatchObject({
    payload: { mode: "full", revision: 1 },
  });
  // 60 个字段全被改写：补丁已经不比全量小，直接发全量。
  expect(encoder.encode(createEvent("room.snapshot", fields("-rewritten")))[0]).toMatchObject({
    payload: { mode: "full", revision: 2 },
  });
  expect(
    encoder.encode(createEvent("room.snapshot", { ...fields("-rewritten"), extra: 1 }))[0]
  ).toMatchObject({
    payload: { mode: "patch", revision: 3, baseRevision: 2 },
  });
});

test("出站积压越过水位时只丢状态帧，回落后以全量恢复", () => {
  let backlog = 0;
  const sent: unknown[] = [];
  const sender = createStateSyncSender(
    (payload) => sent.push(payload),
    () => backlog
  );

  sender.send(createEvent("room.snapshot", { value: 1 }));
  expect(sent).toHaveLength(1);

  backlog = STATE_BACKLOG_SHED_BYTES + 1;
  sender.send(createEvent("room.snapshot", { value: 2 }));
  expect(sent).toHaveLength(1);
  // ACK 与聊天是有去无回的业务消息，积压再高也不能丢。
  sender.send(createEvent("room.chat", { text: "照常发送" }));
  expect(sent[1]).toMatchObject({ event: "room.chat" });

  backlog = STATE_BACKLOG_RESUME_BYTES - 1;
  sender.send(createEvent("room.snapshot", { value: 3 }));
  expect(sent.at(-1)).toMatchObject({
    payload: { mode: "full", revision: 1, state: { value: 3 } },
  });
});
