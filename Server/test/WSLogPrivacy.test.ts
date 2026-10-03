import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { availablePort, isolatedEnvironment } from "../scripts/IsolatedServer";

interface Packet {
  type?: string;
  id?: string;
  requestType?: string;
  traceId?: string;
  error?: { code?: string };
}

async function connect(url: string) {
  const socket = new WebSocket(url);
  let pending: { matches: (packet: Packet) => boolean; resolve: (packet: Packet) => void; reject: (error: Error) => void } | undefined;
  let resolveOpen!: () => void;
  let rejectOpen!: (error: Error) => void;
  const opened = new Promise<void>((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
  const deadline = setTimeout(() => rejectOpen(new Error("自有 WS 连接超时")), 3_000);
  socket.addEventListener("open", () => resolveOpen(), { once: true });
  socket.addEventListener("error", () => {
    const error = new Error("自有 WS 连接异常"); rejectOpen(error); pending?.reject(error);
  });
  socket.addEventListener("close", () => pending?.reject(new Error("收到关联应答前 WS 已关闭")));
  socket.addEventListener("message", event => {
    let packet: Packet;
    try { packet = JSON.parse(String(event.data)) as Packet; }
    catch (error) { pending?.reject(new Error("自有 WS 返回非 JSON 应答", { cause: error })); return; }
    if (pending?.matches(packet)) { pending.resolve(packet); pending = undefined; }
  });
  try { await opened; }
  catch (error) { socket.close(); throw error; }
  finally { clearTimeout(deadline); }
  return {
    socket,
    async exchange(frame: string | Uint8Array, matches: (packet: Packet) => boolean): Promise<Packet> {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<Packet>((resolve, reject) => {
          pending = { matches, resolve, reject };
          timeout = setTimeout(() => reject(new Error("自有 WS 应答超时")), 3_000);
          socket.send(frame);
        });
      } finally { clearTimeout(timeout); pending = undefined; }
    },
  };
}

/** 完整收集两条日志管道；达到上限直接失败，不能截尾后声称所有日志无泄漏。 */
async function collectAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const result = await reader.read();
    if (result.done) return text + decoder.decode();
    text += decoder.decode(result.value, { stream: true });
    if (text.length > 1_000_000) throw new Error("隐私验收日志超过完整捕获上限，不能接受截尾证据");
  }
}

test("security-baseline-001：真实隔离三协议畸形WS正文与凭据不落全日志，错误仍关联id/trace", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bakagame-ws-privacy-"));
  const sockets: WebSocket[] = [];
  const port = await availablePort();
  const owner = crypto.randomUUID();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", path.resolve(import.meta.dir, "../scripts/fixtures/IsolatedPreload.ts"), path.resolve(import.meta.dir, "../src/Index.ts")], {
    cwd: directory, env: isolatedEnvironment(process.env, port, directory, owner), stdout: "pipe", stderr: "pipe",
  });
  const stdout = collectAll(child.stdout);
  const stderr = collectAll(child.stderr);
  const output = Promise.all([stdout, stderr]);
  // 捕获期间立即安装拒绝处理；最终仍 await 原始 Promise，让日志溢出成为明确失败。
  void output.catch(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; if (child.exitCode === null) child.kill("SIGKILL"); }, 25_000);
  const secrets: string[] = [];
  const bodies: string[] = [];
  const markers: string[] = [];
  const operationTraces: Array<{ command: string; traceId: string }> = [];
  const httpTraceId = crypto.randomUUID().replaceAll("-", "");
  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`自有隔离服务提前退出 (${child.exitCode})`);
      let response: Response | undefined;
      try { response = await fetch(`${baseUrl}/__bakagame_test_owner`, { signal: AbortSignal.timeout(500) }); }
      catch (error) { if (Date.now() >= deadline) throw new Error("自有隔离服务启动超时", { cause: error }); }
      if (response) { expect(response.status).toBe(200); expect(await response.text()).toBe(owner); break; }
      await Bun.sleep(100);
    }
    const ready = await fetch(`${baseUrl}/readyz`, { headers: { "x-trace-id": httpTraceId }, signal: AbortSignal.timeout(2_000) });
    expect(ready.status).toBe(200);
    expect(ready.headers.get("x-trace-id")).toBe(httpTraceId);
    const protocols = [
      { path: "/api/whoisfaker/ws", subscribe: "lobby.subscribeRooms", join: "room.join", service: "WhoIsFaker" },
      { path: "/api/songuessr/ws", subscribe: "song.lobby.subscribeRooms", join: "song.room.join", service: "SonGuessr" },
      { path: "/api/ccb/ws", subscribe: "ccb.lobby.subscribeRooms", join: "ccb.room.join", service: "CCB" },
    ];
    for (const protocol of protocols) {
      const client = await connect(`${baseUrl.replace("http:", "ws:")}${protocol.path}`);
      sockets.push(client.socket);
      const exchangeEnvelope = (type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
        const id = crypto.randomUUID();
        const traceId = crypto.randomUUID().replaceAll("-", "");
        const frame = JSON.stringify({ id, type, traceId, payload, ...extra });
        return { id, traceId, frame, response: client.exchange(frame, packet => packet.id === id && (packet.type === "ack" || packet.type === "error")) };
      };
      const subscribed = exchangeEnvelope(protocol.subscribe, {});
      expect(await subscribed.response).toMatchObject({ type: "ack", id: subscribed.id, requestType: protocol.subscribe, traceId: subscribed.traceId });
      operationTraces.push({ command: protocol.subscribe, traceId: subscribed.traceId });
      const secretPayload = {
        cookie: `cookie_secret_${crypto.randomUUID()}`,
        password: `password_secret_${crypto.randomUUID()}`,
        authorization: `Bearer authorization_secret_${crypto.randomUUID()}`,
        body: `WS_BODY_MARKER_${crypto.randomUUID()}`,
      };
      secrets.push(secretPayload.cookie, secretPayload.password, secretPayload.authorization, secretPayload.authorization.slice(7));
      markers.push(secretPayload.body);
      const malformed = JSON.stringify({ ...secretPayload, id: crypto.randomUUID(), type: protocol.subscribe }).slice(0, -1);
      bodies.push(malformed);
      // 畸形 JSON 无可恢复身份；要求稳定错误应答而不是泄露解析器原文或断开连接。
      for (const frame of [malformed, new TextEncoder().encode(malformed)]) {
        expect(await client.exchange(frame, packet => packet.type === "error")).toMatchObject({ type: "error", id: "unknown", error: { code: expect.any(String) } });
      }
      // 可解析但不符合 schema 的载荷仍需保留 id/trace；覆盖普通与带前置空白帧。
      for (const whitespace of ["", " \n\t"]) {
        const id = crypto.randomUUID();
        const traceId = crypto.randomUUID().replaceAll("-", "");
        const invalid = `${whitespace}${JSON.stringify({ id, type: protocol.subscribe, traceId, payload: secretPayload })}`;
        bodies.push(invalid);
        expect(await client.exchange(invalid, packet => packet.id === id)).toMatchObject({ type: "error", id, traceId, error: { code: expect.any(String) } });
      }
      // 攻击者也可把秘密塞进字段名或无效信封身份；诊断只计数，回包关联仍保留。
      const keySecret = `KEY_SECRET_MARKER_${crypto.randomUUID()}`;
      const idSecret = `ID_SECRET_MARKER_${crypto.randomUUID()}`;
      const typeSecret = `TYPE_SECRET_MARKER_${crypto.randomUUID()}`;
      const traceSecret = `TRACE_SECRET_MARKER_${crypto.randomUUID()}`;
      secrets.push(keySecret, idSecret, typeSecret, traceSecret);
      for (const frame of [
        JSON.stringify({ id: idSecret, type: protocol.subscribe, traceId: traceSecret, payload: {}, [keySecret]: true }),
        JSON.stringify({ id: idSecret, type: typeSecret, traceId: traceSecret, payload: {} }),
      ]) {
        expect(await client.exchange(frame, packet => packet.id === idSecret)).toMatchObject({ type: "error", id: idSecret, traceId: traceSecret });
      }
      // 合法 schema、预期业务拒绝：未创建的房间不触发上游 I/O，关联信息不能因隐私收敛丢失。
      const denied = exchangeEnvelope(protocol.join, { userName: "隔离玩家" }, { roomId: "9864" });
      const rejection = await denied.response;
      expect(rejection).toMatchObject({ type: "error", id: denied.id, traceId: denied.traceId, error: { code: expect.any(String) } });
      expect(rejection.error?.code).not.toBe("INTERNAL_ERROR");
      operationTraces.push({ command: protocol.join, traceId: denied.traceId });
      const afterErrors = exchangeEnvelope(protocol.subscribe, {});
      expect(await afterErrors.response).toMatchObject({ type: "ack", id: afterErrors.id, requestType: protocol.subscribe, traceId: afterErrors.traceId });
    }
    // 停机信号不是此用例验收目标；只强制回收已核对 owner 的自有进程，Windows 不冒充 OS listener 验收。
    for (const socket of sockets) socket.close();
    child.kill("SIGKILL");
    await child.exited;
    const [out, err] = await output;
    const fullLog = `${out}\n${err}`;
    expect(timedOut).toBe(false);
    expect(fullLog.length).toBeGreaterThan(0);
    // 同时禁止稳定正文/凭据前缀，避免截断样本未包含完整 UUID 时误判为无正文。
    for (const secret of [...secrets, ...markers, ...bodies, "cookie_secret_", "password_secret_", "authorization_secret_", "WS_BODY_MARKER_"]) expect(fullLog).not.toContain(secret);
    for (const protocol of protocols) expect(fullLog).toContain(`${protocol.service} WS 消息解析失败`);
    const lines = fullLog.split(/\r?\n/);
    expect(lines.some(line => line.includes("HTTP GET /readyz") && line.includes(JSON.stringify({ traceId: httpTraceId })))).toBe(true);
    for (const { command, traceId } of operationTraces) {
      expect(lines.some(line => line.includes(`WS ${command}`) && line.includes(JSON.stringify({ traceId })))).toBe(true);
    }
  } finally {
    clearTimeout(watchdog);
    for (const socket of sockets) socket.close();
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await output;
    // 唯一可删目标是本用例 mkdtemp 返回的直接子目录；不碰工作区或实际存储。
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith("bakagame-ws-privacy-")) throw new Error("隔离临时目录路径越界");
    await rm(target, { recursive: true, force: true });
  }
}, 30_000);
