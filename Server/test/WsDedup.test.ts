import { expect, test } from "bun:test";

import { AppError } from "../src/domain/Errors";
import type { EventLogger } from "../src/infrastructure/EventLogger";
import type { ServerMessage } from "../src/shared/Protocol";
import { createCommandDeduplicator } from "../src/transport/ws/Dedup";
import { deferred } from "./support/Deferred";

const logger = {
  logOperation: () => {},
  error: () => {},
  warn: () => {},
} as unknown as EventLogger;

const createSocket = () => {
  const sent: ServerMessage[] = [];
  return { sent, ws: { send: (data: ServerMessage) => sent.push(data) } };
};

const options = { ackTtlMs: 60_000, ackMax: 8, inFlightMax: 8, logger };

const message = (id: string) => ({ id, type: "demo", traceId: `trace-${id}` });

test("同一连接重复发同一命令：只执行一次，第二次回放同一个 ACK", async () => {
  const dedup = createCommandDeduplicator(options);
  const { ws, sent } = createSocket();
  let runs = 0;
  const execute = async () => ({ n: ++runs });
  const input = { ws, connectionId: "c1", parsed: message("m1"), startTime: 0, execute };

  await dedup.run(input);
  await dedup.run(input);

  expect(runs).toBe(1);
  expect(sent).toHaveLength(2);
  expect(sent[0]).toMatchObject({ type: "ack", id: "m1", payload: { n: 1 } });
  expect(sent[1]).toMatchObject({ type: "ack", id: "m1", payload: { n: 1 } });
});

test("执行中再来同一命令：等待首次结果并回放，成功与失败都一样", async () => {
  const dedup = createCommandDeduplicator(options);
  const { ws, sent } = createSocket();
  const gate = deferred();
  let runs = 0;
  const first = dedup.run({
    ws,
    connectionId: "c1",
    parsed: message("m1"),
    startTime: 0,
    execute: () => {
      runs += 1;
      return gate.promise;
    },
  });
  const second = dedup.run({
    ws,
    connectionId: "c1",
    parsed: message("m1"),
    startTime: 0,
    execute: async () => {
      runs += 1;
      return "不该执行";
    },
  });
  gate.reject(new AppError("ROOM_FULL", "房间已满"));
  await Promise.all([first, second]);

  expect(runs).toBe(1);
  expect(sent).toHaveLength(2);
  for (const packet of sent) {
    expect(packet).toMatchObject({ type: "error", id: "m1", error: { code: "ROOM_FULL" } });
  }
});

test("失败的命令不进完成缓存：重发会重新执行", async () => {
  const dedup = createCommandDeduplicator(options);
  const { ws } = createSocket();
  let runs = 0;
  const input = {
    ws,
    connectionId: "c1",
    parsed: message("m1"),
    startTime: 0,
    execute: async () => {
      runs += 1;
      throw new AppError("ROOM_FULL", "房间已满");
    },
  };
  await dedup.run(input);
  await dedup.run(input);
  expect(runs).toBe(2);
});

test("相同消息号跨连接互不命中：各自执行各自回包", async () => {
  const dedup = createCommandDeduplicator(options);
  const a = createSocket();
  const b = createSocket();
  let runs = 0;
  const execute = async () => ({ n: ++runs });
  await dedup.run({ ws: a.ws, connectionId: "c1", parsed: message("m1"), startTime: 0, execute });
  await dedup.run({ ws: b.ws, connectionId: "c2", parsed: message("m1"), startTime: 0, execute });

  expect(runs).toBe(2);
  expect(a.sent[0]).toMatchObject({ payload: { n: 1 } });
  expect(b.sent[0]).toMatchObject({ payload: { n: 2 } });
});

test("断线重连换了连接号：旧连接上的结果不会回放给新连接", async () => {
  const dedup = createCommandDeduplicator(options);
  const { ws } = createSocket();
  let runs = 0;
  const execute = async () => ({ n: ++runs });
  await dedup.run({ ws, connectionId: "old", parsed: message("m1"), startTime: 0, execute });
  await dedup.run({ ws, connectionId: "new", parsed: message("m1"), startTime: 0, execute });
  expect(runs).toBe(2);
});

test("完成缓存按容量淘汰最久未用的条目，被淘汰的重发会重新执行", async () => {
  const dedup = createCommandDeduplicator({ ...options, ackMax: 2 });
  const { ws } = createSocket();
  const runs = new Map<string, number>();
  const send = (id: string) =>
    dedup.run({
      ws,
      connectionId: "c1",
      parsed: message(id),
      startTime: 0,
      execute: async () => runs.set(id, (runs.get(id) ?? 0) + 1),
    });
  await send("a");
  await send("b");
  await send("c");
  await send("b");
  await send("a");
  expect(runs.get("b")).toBe(1);
  expect(runs.get("a")).toBe(2);
});

test("完成缓存到期后不再回放", async () => {
  const dedup = createCommandDeduplicator({ ...options, ackTtlMs: 20 });
  const { ws } = createSocket();
  let runs = 0;
  const input = {
    ws,
    connectionId: "c1",
    parsed: message("m1"),
    startTime: 0,
    execute: async () => ++runs,
  };
  await dedup.run(input);
  await Bun.sleep(60);
  await dedup.run(input);
  expect(runs).toBe(2);
});

test("飞行中表封顶：挤掉最旧的条目后，该命令的重发不再被去重", async () => {
  const dedup = createCommandDeduplicator({ ...options, inFlightMax: 2 });
  const { ws } = createSocket();
  const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
  let oldestRuns = 0;
  const pending = [
    dedup.run({
      ws,
      connectionId: "c1",
      parsed: message("m0"),
      startTime: 0,
      execute: () => {
        oldestRuns += 1;
        return gates[0].promise;
      },
    }),
    dedup.run({
      ws,
      connectionId: "c1",
      parsed: message("m1"),
      startTime: 0,
      execute: () => gates[1].promise,
    }),
    dedup.run({
      ws,
      connectionId: "c1",
      parsed: message("m2"),
      startTime: 0,
      execute: () => gates[2].promise,
    }),
  ];
  const retry = dedup.run({
    ws,
    connectionId: "c1",
    parsed: message("m0"),
    startTime: 0,
    execute: () => {
      oldestRuns += 1;
      return gates[0].promise;
    },
  });
  for (const gate of gates) gate.resolve("ok");
  await Promise.all([...pending, retry]);
  expect(oldestRuns).toBe(2);
});

test("去重状态归实例：两个实例互不可见，clear 之后清空", async () => {
  const one = createCommandDeduplicator(options);
  const two = createCommandDeduplicator(options);
  const { ws } = createSocket();
  let runs = 0;
  const input = {
    ws,
    connectionId: "c1",
    parsed: message("m1"),
    startTime: 0,
    execute: async () => ++runs,
  };
  await one.run(input);
  await two.run(input);
  expect(runs).toBe(2);
  one.clear();
  await one.run(input);
  expect(runs).toBe(3);
});
