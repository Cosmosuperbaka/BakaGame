import { expect, test } from "bun:test";

import { LOBBY_MERGE_WINDOW_MS, LobbyFanout } from "../src/application/LobbyFanout";
import { WHOISFAKER_LOBBY_ROOMS_EVENT } from "../src/shared/WhoIsFaker";

/**
 * 尾沿调度注入后整条链按虚拟时钟走：真实定时器会把「虚拟 60 秒」的扇出摊到十几秒的真实抖动上，
 * 承载门禁与延迟上界都无法复现。实现保证同一时刻至多挂一个尾沿，所以这里也只存一个。
 */
const createHarness = (options: { windowMs?: number; summaries?: () => unknown } = {}) => {
  let now = 0;
  let due: { at: number; flush: () => void } | undefined;
  const broadcasts: unknown[] = [];
  const direct: Array<{ id: string; payload: unknown }> = [];
  const fanout = new LobbyFanout({
    event: WHOISFAKER_LOBBY_ROOMS_EVENT,
    now: () => now,
    broadcast: (payload) => broadcasts.push(payload),
    summaries: options.summaries ?? (() => ({ at: now })),
    ...(options.windowMs === undefined ? {} : { windowMs: options.windowMs }),
    schedule: (flush, delayMs) => {
      due = { at: now + delayMs, flush };
    },
  });
  const advance = (ms: number) => {
    now += ms;
    if (due && due.at <= now) {
      const timer = due;
      due = undefined;
      timer.flush();
    }
  };
  return { fanout, broadcasts, direct, dueAt: () => due?.at, advance };
};

test("窗口外的变更立刻下发，窗口内的多次变更并为一次", () => {
  const h = createHarness();

  h.fanout.request();
  expect(h.broadcasts).toHaveLength(1);

  h.advance(100);
  h.fanout.request();
  h.advance(50);
  h.fanout.request();
  expect(h.broadcasts).toHaveLength(1);

  // 尾沿锚在上一次下发 + 一个窗口处收敛，一次带走整段突发。
  expect(h.dueAt()).toBe(LOBBY_MERGE_WINDOW_MS);
  h.advance(LOBBY_MERGE_WINDOW_MS - 150);
  expect(h.broadcasts).toHaveLength(2);

  // 尾沿不是节拍器：没有新变更就不该再产生第二份。
  h.advance(LOBBY_MERGE_WINDOW_MS * 2);
  expect(h.broadcasts).toHaveLength(2);
});

test("变更到大厅可见的延迟不超过一个合并窗", () => {
  const h = createHarness();
  h.fanout.request();
  expect(h.broadcasts).toHaveLength(1);

  // 窗口起点刚过的那次变更等得最久：到点即发，且不超过窗口本身。
  h.advance(1);
  h.fanout.request();
  expect(h.dueAt()).toBe(LOBBY_MERGE_WINDOW_MS);
  h.advance(LOBBY_MERGE_WINDOW_MS - 2);
  expect(h.broadcasts).toHaveLength(1);
  h.advance(1);
  expect(h.broadcasts).toHaveLength(2);
});

test("订阅只回给这一条连接：既不重发全服，也不占用合并窗", () => {
  const h = createHarness();
  const connection = {
    id: "lobby-1",
    send: (payload: unknown) => h.direct.push({ id: "lobby-1", payload }),
  };

  h.fanout.request();
  h.fanout.sendTo(connection);
  h.fanout.sendTo(connection);

  expect(h.broadcasts).toHaveLength(1);
  expect(h.direct).toHaveLength(2);
  expect(h.direct[0].payload).toMatchObject({
    type: "event",
    event: WHOISFAKER_LOBBY_ROOMS_EVENT,
  });

  // 订阅没有推进 publishedAt：紧随其后的变更仍按原窗口判定，不会因为「有人进大厅」而延后。
  h.advance(LOBBY_MERGE_WINDOW_MS);
  h.fanout.request();
  expect(h.broadcasts).toHaveLength(2);
});

test("下发的是当前列表，不是排期时刻的旧值", () => {
  let revision = 0;
  const h = createHarness({ summaries: () => ({ revision }) });

  h.fanout.request();
  expect(h.broadcasts.at(-1)).toMatchObject({ payload: { revision: 0 } });

  revision = 7;
  h.advance(1);
  h.fanout.request();
  h.advance(LOBBY_MERGE_WINDOW_MS);
  expect(h.broadcasts.at(-1)).toMatchObject({ payload: { revision: 7 } });
});
