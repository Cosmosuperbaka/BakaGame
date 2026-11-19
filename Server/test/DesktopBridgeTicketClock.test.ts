import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

/**
 * 桌面壳注入脚本里票据到期的判定：脚本内嵌在 Rust 源码里，跑不进前端测试，
 * 这里把原文取出来在隔离上下文里真跑一遍，钉住「时钟偏差不影响票的可用判定」。
 */
const BRIDGE_SOURCE = readFileSync(
  resolve(import.meta.dir, "../../Desktop/src-tauri/src/bridge.rs"),
  "utf8"
);
const SCRIPT = (() => {
  const match = /const BRIDGE_JS: &str = r#"([\s\S]*?)"#;/.exec(BRIDGE_SOURCE);
  if (!match) throw new Error("没有在 bridge.rs 里找到桥接脚本原文");
  return match[1].replaceAll("__BAKA_CLIENT_VERSION__", "0.0.0");
})();

type TicketReply = { ticket: string; ttlMs?: number; expiresAt?: number };

function harness(options: { wallNow: number; reply: () => TicketReply }) {
  const clock = { wall: options.wallNow, mono: 1_000 };
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const invokes: string[] = [];
  const sandbox: Record<string, unknown> = {
    Date: { now: () => clock.wall },
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    setInterval: (fn: () => void, ms: number) => timers.push({ fn, ms }),
  };
  const windowObject: Record<string, unknown> = {
    performance: { now: () => clock.mono },
    __TAURI_INTERNALS__: {
      invoke: async (command: string) => {
        invokes.push(command);
        return options.reply();
      },
    },
  };
  windowObject.top = windowObject;
  sandbox.window = windowObject;
  runInNewContext(SCRIPT, sandbox, { filename: "bridge.rs(js)" });
  const settle = async () => {
    for (let index = 0; index < 5; index += 1) await new Promise((r) => setImmediate(r));
  };
  const poll = () => timers.find((timer) => timer.ms === 4000)?.fn();
  const channel = () =>
    (windowObject.__BAKA_CHANNEL__ ?? {}) as {
      channelTicket: string;
    };
  return { clock, invokes, settle, poll, channel };
}

const ticketCalls = (invokes: string[]) => invokes.filter((name) => name === "baka_ticket").length;

test("本机时钟比服务端快：新票照样可用，轮询不会反复重签", async () => {
  const serverNow = 5_000_000;
  const localNow = serverNow + 100_000;
  const h = harness({
    wallNow: localNow,
    reply: () => ({ ticket: "T1", ttlMs: 30_000, expiresAt: serverNow + 30_000 }),
  });
  await h.settle();
  const before = ticketCalls(h.invokes);
  h.poll();
  await h.settle();
  expect(ticketCalls(h.invokes)).toBe(before);
  expect(h.channel().channelTicket).toBe("T1");
});

test("过了有效期的票会被轮询换掉，改时间或休眠都不会让旧票复活", async () => {
  const h = harness({ wallNow: 9_000_000, reply: () => ({ ticket: "T", ttlMs: 30_000 }) });
  await h.settle();
  const before = ticketCalls(h.invokes);
  // 过去 26 秒：离过期已不足余量，必须重签。
  h.clock.mono += 26_000;
  h.clock.wall += 26_000;
  h.poll();
  await h.settle();
  expect(ticketCalls(h.invokes)).toBe(before + 1);
  // 休眠：单调时钟几乎没走，墙上时钟差值走了十分钟，也必须重签。
  const afterRefresh = ticketCalls(h.invokes);
  h.clock.mono += 1_000;
  h.clock.wall += 600_000;
  h.poll();
  await h.settle();
  expect(ticketCalls(h.invokes)).toBe(afterRefresh + 1);
});
