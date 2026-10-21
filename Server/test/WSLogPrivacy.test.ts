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
  let pending:
    | {
        matches: (packet: Packet) => boolean;
        resolve: (packet: Packet) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  let resolveOpen!: () => void;
  let rejectOpen!: (error: Error) => void;
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  const deadline = setTimeout(() => rejectOpen(new Error("自有 WS 连接超时")), 3_000);
  socket.addEventListener("open", () => resolveOpen(), { once: true });
  socket.addEventListener("error", () => {
    const error = new Error("自有 WS 连接异常");
    rejectOpen(error);
    pending?.reject(error);
  });
  socket.addEventListener("close", () => pending?.reject(new Error("收到关联应答前 WS 已关闭")));
  socket.addEventListener("message", (event) => {
    let packet: Packet;
    try {
      packet = JSON.parse(String(event.data)) as Packet;
    } catch (error) {
      pending?.reject(new Error("自有 WS 返回非 JSON 应答", { cause: error }));
      return;
    }
    if (pending?.matches(packet)) {
      pending.resolve(packet);
      pending = undefined;
    }
  });
  try {
    await opened;
  } catch (error) {
    socket.close();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
  return {
    socket,
    async exchange(
      frame: string | Uint8Array<ArrayBuffer>,
      matches: (packet: Packet) => boolean
    ): Promise<Packet> {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<Packet>((resolve, reject) => {
          pending = { matches, resolve, reject };
          timeout = setTimeout(() => reject(new Error("自有 WS 应答超时")), 3_000);
          socket.send(frame);
        });
      } finally {
        clearTimeout(timeout);
        pending = undefined;
      }
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

/** 三协议入口与各自的订阅/加入命令名。 */
const PROTOCOLS = [
  {
    path: "/api/whoisfaker/ws",
    subscribe: "lobby.subscribeRooms",
    join: "room.join",
    service: "WhoIsFaker",
  },
  {
    path: "/api/songuessr/ws",
    subscribe: "song.lobby.subscribeRooms",
    join: "song.room.join",
    service: "SonGuessr",
  },
  {
    path: "/api/cee/ws",
    subscribe: "cee.lobby.subscribeRooms",
    join: "cee.room.join",
    service: "CEE",
  },
];

type Protocol = (typeof PROTOCOLS)[number];
type WsClient = Awaited<ReturnType<typeof connect>>;

/** 一个协议要收齐的证据：停机后整份日志逐条比对，任一命中即失败。 */
interface PrivacyEvidence {
  secrets: string[];
  markers: string[];
  bodies: string[];
  traces: Array<{ command: string; traceId: string }>;
}

/** 拉起进程后等 owner 探针回 200 且正文是本次 owner，才算服务就绪。 */
async function waitForIsolatedService(
  child: { exitCode: number | null },
  baseUrl: string,
  owner: string
): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`自有隔离服务提前退出 (${child.exitCode})`);
    let response: Response | undefined;
    try {
      response = await fetch(`${baseUrl}/__bakagame_test_owner`, {
        signal: AbortSignal.timeout(500),
      });
    } catch (error) {
      if (Date.now() >= deadline) throw new Error("自有隔离服务启动超时", { cause: error });
    }
    if (response) {
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(owner);
      return;
    }
    await Bun.sleep(100);
  }
}

/**
 * 对单个协议依次压入畸形与越界输入：秘密同时埋进正文、字段名、身份与类型；
 * 合法 schema 走「未创建房间」的业务拒绝。应答关联就地断言，证据交给停机后的日志比对。
 */
async function probeProtocol(
  client: WsClient,
  protocol: Protocol,
  evidence: PrivacyEvidence
): Promise<void> {
  const exchangeEnvelope = (
    type: string,
    payload: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ) => {
    const id = crypto.randomUUID();
    const traceId = crypto.randomUUID().replaceAll("-", "");
    const frame = JSON.stringify({ id, type, traceId, payload, ...extra });
    return {
      id,
      traceId,
      frame,
      response: client.exchange(
        frame,
        (packet) => packet.id === id && (packet.type === "ack" || packet.type === "error")
      ),
    };
  };
  const subscribed = exchangeEnvelope(protocol.subscribe, {});
  expect(await subscribed.response).toMatchObject({
    type: "ack",
    id: subscribed.id,
    requestType: protocol.subscribe,
    traceId: subscribed.traceId,
  });
  evidence.traces.push({ command: protocol.subscribe, traceId: subscribed.traceId });
  const secretPayload = {
    cookie: `cookie_secret_${crypto.randomUUID()}`,
    password: `password_secret_${crypto.randomUUID()}`,
    authorization: `Bearer authorization_secret_${crypto.randomUUID()}`,
    body: `WS_BODY_MARKER_${crypto.randomUUID()}`,
  };
  evidence.secrets.push(
    secretPayload.cookie,
    secretPayload.password,
    secretPayload.authorization,
    secretPayload.authorization.slice(7)
  );
  evidence.markers.push(secretPayload.body);
  const malformed = JSON.stringify({
    ...secretPayload,
    id: crypto.randomUUID(),
    type: protocol.subscribe,
  }).slice(0, -1);
  evidence.bodies.push(malformed);
  // 畸形 JSON 无可恢复身份；要求稳定错误应答而不是泄露解析器原文或断开连接。
  for (const frame of [malformed, new TextEncoder().encode(malformed)]) {
    expect(await client.exchange(frame, (packet) => packet.type === "error")).toMatchObject({
      type: "error",
      id: "unknown",
      error: { code: expect.any(String) },
    });
  }
  // 可解析但不符合 schema 的载荷仍需保留 id/trace；覆盖普通与带前置空白帧。
  for (const whitespace of ["", " \n\t"]) {
    const id = crypto.randomUUID();
    const traceId = crypto.randomUUID().replaceAll("-", "");
    const invalid = `${whitespace}${JSON.stringify({ id, type: protocol.subscribe, traceId, payload: secretPayload })}`;
    evidence.bodies.push(invalid);
    expect(await client.exchange(invalid, (packet) => packet.id === id)).toMatchObject({
      type: "error",
      id,
      traceId,
      error: { code: expect.any(String) },
    });
  }
  // 攻击者也可把秘密塞进字段名或无效信封身份；诊断只计数，回包关联仍保留。
  const keySecret = `KEY_SECRET_MARKER_${crypto.randomUUID()}`;
  const idSecret = `ID_SECRET_MARKER_${crypto.randomUUID()}`;
  const typeSecret = `TYPE_SECRET_MARKER_${crypto.randomUUID()}`;
  const traceSecret = `TRACE_SECRET_MARKER_${crypto.randomUUID()}`;
  evidence.secrets.push(keySecret, idSecret, typeSecret, traceSecret);
  for (const frame of [
    JSON.stringify({
      id: idSecret,
      type: protocol.subscribe,
      traceId: traceSecret,
      payload: {},
      [keySecret]: true,
    }),
    JSON.stringify({ id: idSecret, type: typeSecret, traceId: traceSecret, payload: {} }),
  ]) {
    expect(await client.exchange(frame, (packet) => packet.id === idSecret)).toMatchObject({
      type: "error",
      id: idSecret,
      traceId: traceSecret,
    });
  }
  // 合法 schema、预期业务拒绝：未创建的房间不触发上游 I/O，关联信息不能因隐私收敛丢失。
  const denied = exchangeEnvelope(protocol.join, { userName: "隔离玩家" }, { roomId: "9864" });
  const rejection = await denied.response;
  expect(rejection).toMatchObject({
    type: "error",
    id: denied.id,
    traceId: denied.traceId,
    error: { code: expect.any(String) },
  });
  expect(rejection.error?.code).not.toBe("INTERNAL_ERROR");
  evidence.traces.push({ command: protocol.join, traceId: denied.traceId });
  const afterErrors = exchangeEnvelope(protocol.subscribe, {});
  expect(await afterErrors.response).toMatchObject({
    type: "ack",
    id: afterErrors.id,
    requestType: protocol.subscribe,
    traceId: afterErrors.traceId,
  });
}

test("security-baseline-001：真实隔离三协议畸形WS正文与凭据不落全日志，错误仍关联id/trace", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bakagame-ws-privacy-"));
  const target = path.resolve(directory);
  // 唯一可删目标是本用例 mkdtemp 返回的直接子目录；不碰工作区或实际存储。
  // 越界必须在拉起隔离服务之前失败，否则 finally 抛错会盖掉用例自身的断言。
  if (
    path.dirname(target) !== path.resolve(tmpdir()) ||
    !path.basename(target).startsWith("bakagame-ws-privacy-")
  )
    throw new Error("隔离临时目录路径越界");
  const sockets: WebSocket[] = [];
  const port = await availablePort();
  const owner = crypto.randomUUID();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      path.resolve(import.meta.dir, "../scripts/fixtures/IsolatedPreload.ts"),
      path.resolve(import.meta.dir, "../src/Index.ts"),
    ],
    {
      cwd: directory,
      env: isolatedEnvironment(process.env, port, directory, owner),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const stdout = collectAll(child.stdout);
  const stderr = collectAll(child.stderr);
  const output = Promise.all([stdout, stderr]);
  // 捕获期间立即安装拒绝处理；最终仍 await 原始 Promise，让日志溢出成为明确失败。
  void output.catch(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 25_000);
  const evidence: PrivacyEvidence = { secrets: [], markers: [], bodies: [], traces: [] };
  const httpTraceId = crypto.randomUUID().replaceAll("-", "");
  try {
    await waitForIsolatedService(child, baseUrl, owner);
    const ready = await fetch(`${baseUrl}/readyz`, {
      headers: { "x-trace-id": httpTraceId },
      signal: AbortSignal.timeout(2_000),
    });
    expect(ready.status).toBe(200);
    expect(ready.headers.get("x-trace-id")).toBe(httpTraceId);
    for (const protocol of PROTOCOLS) {
      const client = await connect(`${baseUrl.replace("http:", "ws:")}${protocol.path}`);
      sockets.push(client.socket);
      await probeProtocol(client, protocol, evidence);
      // F05：一次性建连凭据写在握手查询串上，SDK 的自动 URL 采集会整串保存；
      // 这里同时验收进程日志这一路——票据明文不得出现在停机后的整份 stdout/stderr 里。
      const handshakeTicket = `TICKET_SECRET_MARKER_${crypto.randomUUID()}`;
      evidence.secrets.push(handshakeTicket, "TICKET_SECRET_MARKER_");
      const ticketed = await connect(
        `${baseUrl.replace("http:", "ws:")}${protocol.path}?clientType=web&ticket=${handshakeTicket}`
      );
      sockets.push(ticketed.socket);
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
    for (const secret of [
      ...evidence.secrets,
      ...evidence.markers,
      ...evidence.bodies,
      "cookie_secret_",
      "password_secret_",
      "authorization_secret_",
      "WS_BODY_MARKER_",
    ])
      expect(fullLog).not.toContain(secret);
    for (const protocol of PROTOCOLS)
      expect(fullLog).toContain(`${protocol.service} WS 消息解析失败`);
    const lines = fullLog.split(/\r?\n/);
    const parsed = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as { msg?: unknown; context?: { traceId?: unknown } }];
      } catch {
        return [];
      }
    });
    expect(
      parsed.some(
        (line) =>
          line.msg === "HTTP GET /readyz" && line.context?.traceId === httpTraceId
      )
    ).toBe(true);
    for (const { command, traceId } of evidence.traces) {
      expect(
        parsed.some(
          (line) => line.msg === `WS ${command}` && line.context?.traceId === traceId
        )
      ).toBe(true);
    }
  } finally {
    clearTimeout(watchdog);
    for (const socket of sockets) socket.close();
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await output;
    await rm(target, { recursive: true, force: true });
  }
}, 30_000);
