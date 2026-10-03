import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { availablePort, isolatedEnvironment } from "./IsolatedServer";

/** 真实 Index/Provider/SQLite/HTTP/WS，临时存储、合成维护 token、硬拒绝主动网络出口。 */
const directory = await mkdtemp(path.join(tmpdir(), "bakagame-shutdown-"));
const port = await availablePort();
const owner = crypto.randomUUID();
const token = crypto.randomUUID();
const baseUrl = `http://127.0.0.1:${port}`;
const environment = { ...isolatedEnvironment(process.env, port, directory, owner), MAINTENANCE_TOKEN: token };
const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", path.join(import.meta.dir, "fixtures/ShutdownSmokePreload.ts"), path.resolve(import.meta.dir, "../src/Index.ts")], {
  cwd: directory, env: environment, stdout: "pipe", stderr: "pipe",
});
// 持续排空并保留有界尾日志，避免管道反压；这些日志不包含维护 token。
async function tail(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const result = await reader.read();
    if (result.done) return text;
    text = (text + decoder.decode(result.value)).slice(-32_768);
  }
}
const stdout = tail(child.stdout);
const stderr = tail(child.stderr);
const sockets: WebSocket[] = [];
let timedOut = false;
const deadline = setTimeout(() => { timedOut = true; if (child.exitCode === null) child.kill("SIGKILL"); }, 25_000);

async function request(endpoint: string, options?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${endpoint}`, { ...options, signal: AbortSignal.timeout(2_000) });
}

async function subscribe(endpoint: string, requestType: string) {
  const socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}${endpoint}`);
  sockets.push(socket);
  const id = crypto.randomUUID();
  let notifications = 0;
  let waiting: { count: number; resolve: () => void; reject: (error: Error) => void } | undefined;
  let resolveAck!: () => void;
  let rejectAck!: (error: Error) => void;
  const ack = new Promise<void>((resolve, reject) => { resolveAck = resolve; rejectAck = reject; });
  const timer = setTimeout(() => rejectAck(new Error(`${endpoint} ACK 超时`)), 3_000);
  socket.addEventListener("open", () => socket.send(JSON.stringify({ id, type: requestType, payload: {} })), { once: true });
  socket.addEventListener("error", () => rejectAck(new Error(`${endpoint} 连接异常`)), { once: true });
  socket.addEventListener("close", () => {
    rejectAck(new Error(`${endpoint} 提前关闭`));
    waiting?.reject(new Error(`${endpoint} 停机事件前已关闭`));
  });
  socket.addEventListener("message", event => {
    const packet = JSON.parse(String(event.data)) as { type?: string; id?: string; requestType?: string; event?: string };
    if (packet.id === id) {
      if (packet.type === "ack" && packet.requestType === requestType) resolveAck();
      else rejectAck(new Error(`${endpoint} 无效 ACK`));
    }
    if (packet.event === "server.shutdown") {
      notifications++;
      if (waiting && notifications >= waiting.count) { waiting.resolve(); waiting = undefined; }
    }
  });
  try { await ack; } finally { clearTimeout(timer); }
  return {
    get notifications() { return notifications; },
    async waitFor(count: number) {
      if (notifications >= count) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          waiting = { count, resolve, reject };
          timeout = setTimeout(() => reject(new Error(`${endpoint} 缺少第 ${count} 个停机事件`)), 4_000);
        });
      } finally { clearTimeout(timeout); waiting = undefined; }
    },
  };
}

try {
  const readyDeadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`自有进程提前退出 (${child.exitCode})`);
    let proof: Response | undefined;
    try { proof = await request("/__bakagame_test_owner"); }
    catch (error) {
      if (Date.now() >= readyDeadline) throw new Error("自有进程启动超时", { cause: error });
    }
    if (proof) { assert.equal(await proof.text(), owner); break; }
    await Bun.sleep(100);
  }
  const ready = await request("/readyz");
  assert.equal(ready.status, 200);
  assert.equal((await ready.json() as { ready: boolean }).ready, true);
  const subscriptions = [];
  for (const [endpoint, type] of [["/api/whoisfaker/ws", "lobby.subscribeRooms"], ["/api/songuessr/ws", "song.lobby.subscribeRooms"], ["/api/ccb/ws", "ccb.lobby.subscribeRooms"]]) {
    subscriptions.push(await subscribe(endpoint, type));
  }
  const notify = await request("/api/system/notify-shutdown", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  assert.equal(notify.status, 200);
  assert.equal((await notify.json() as { ok: boolean }).ok, true);
  await Promise.all(subscriptions.map(subscription => subscription.waitFor(1)));
  const removed = await request("/readyz");
  assert.equal(removed.status, 503);
  assert.deepEqual(await removed.json(), { status: "shutting_down", ready: false });
  assert.equal((await request("/livez")).status, 200);
  assert.equal(child.exitCode, null, "预通知不得退出生产进程");

  const started = performance.now();
  const delivery = process.platform === "win32" ? "process.emit (Windows listener integration, not OS signal)" : "OS signal";
  if (process.platform === "win32") {
    const trigger = await request("/__bakagame_test_signal", { method: "POST", headers: { authorization: `Bearer ${owner}` } });
    assert.equal(trigger.status, 200);
    assert.equal((await trigger.json() as { delivery: string }).delivery, "process.emit");
  } else {
    child.kill("SIGTERM"); child.kill("SIGTERM"); child.kill("SIGINT");
  }
  await Promise.all(subscriptions.map(subscription => subscription.waitFor(2)));
  const exitCode = await child.exited;
  const elapsedMs = Math.round(performance.now() - started);
  const output = `${await stdout}\n${await stderr}`;
  assert.equal(timedOut, false, "父进程不应强杀 smoke");
  assert.equal(exitCode, 0, output);
  assert.ok(elapsedMs >= 2_900, `必须执行真实 3 秒缓冲：${elapsedMs}ms`);
  assert.ok(elapsedMs < 15_000, `必须在总看门狗之前退出：${elapsedMs}ms`);
  assert.deepEqual(subscriptions.map(subscription => subscription.notifications), [2, 2, 2], "预通知和唯一 signal 编排各广播一次，重复 signal 不再广播");
  assert.equal(output.split("收到停机信号，开始优雅停机").length - 1, 1);
  assert.equal(output.split("服务已完成优雅停机").length - 1, 1);
  assert.equal(output.includes("优雅停机步骤失败"), false, output);
  assert.equal(output.includes("优雅停机超时"), false, output);
  console.log(JSON.stringify({ ok: true, runtime: Bun.version, platform: process.platform, delivery, initialReadiness: 200, preNotifyReadiness: 503, livenessAfterPreNotify: 200, subscriptions: 3, notifications: subscriptions.map(subscription => subscription.notifications), shutdownStarted: 1, shutdownCompleted: 1, exitCode, elapsedMs, externalEgress: "denied by inherited preload", otlp: "disabled; failure ordering validated in VM", sentry: "disabled; failure ordering validated in VM" }));
} catch (error) {
  if (child.exitCode === null) child.kill("SIGKILL");
  await child.exited;
  console.error(`${await stdout}\n${await stderr}`);
  throw error;
} finally {
  clearTimeout(deadline);
  for (const socket of sockets) socket.close();
  if (child.exitCode === null) child.kill("SIGKILL");
  await child.exited;
  // directory 由 mkdtemp 创建并仅作为本次隔离存储；不触碰仓库或用户已有文件。
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.ok(path.basename(resolved).startsWith("bakagame-shutdown-"));
  await rm(resolved, { recursive: true, force: true });
}
