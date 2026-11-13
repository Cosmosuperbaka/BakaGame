import type { Span } from "@sentry/react";
import type { AckPacket, ErrorPacket, ServerMessage } from "@bakagame/shared";
import {
  CONNECT_WAIT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_RECONNECT_DELAY_MS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MIN_DELAY_MS,
  RECONNECT_MIN_INTERVAL_MS,
  RECONNECT_STABLE_MS,
} from "@/config/Constants";
import { resolveServerBase } from "@/lib/ServerEndpoint";
import { rejectProtocol } from "@/lib/ProtocolFailure";
import type { PreludeExchange } from "@/lib/TabSession";
import { expireClockSample, recordClockSample } from "@/stores/UseServerClock";
import {
  captureClientLog,
  captureClientException,
  countClientMetric,
  recordClientMetric,
  withClientSpan,
} from "@/lib/Sentry";

type MessageHandler = (message: ServerMessage) => void;
type StatusHandler = (connected: boolean) => void;

/**
 * 协议层 error 包承载的业务错误体（密码错误、房间不存在、阶段不合法等）。
 * 它是服务端对客户端请求的正常业务拒绝，由调用方捕获后提示玩家，属于数据而非异常。
 */
export type ProtocolError = ErrorPacket["error"];

export const isProtocolError = (value: unknown): value is ProtocolError =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { code?: unknown }).code === "string" &&
  typeof (value as { message?: unknown }).message === "string";

/**
 * 三条游戏通道共用的发送选项。
 *
 * `timeout: 0` 表示**不设请求超时**：自动出题这类需要连续回源多个外部接口的命令，耗时完全由
 * 上游决定，客户端超时只会制造「后端还在选曲、前端已提示失败」的假失败。
 */
export interface SendOptions {
  roomId?: string;
  sessionToken?: string;
  timeout?: number;
}

/** 传输层只校验信封，事件的领域 payload 仍由对应消费者负责。 */
const isServerMessage = (value: unknown): value is ServerMessage => {
  if (typeof value !== "object" || value === null) return false;
  const packet = value as Record<string, unknown>;
  if (packet.type === "event") return typeof packet.event === "string" && "payload" in packet;
  if (typeof packet.id !== "string") return false;
  if (packet.traceId !== undefined && typeof packet.traceId !== "string") return false;
  if (packet.type === "error") return isProtocolError(packet.error);
  // 部分旧 ACK 未携带 requestType；请求归属由 pending 的 id 判定。
  return (
    packet.type === "ack" &&
    (packet.requestType === undefined || typeof packet.requestType === "string")
  );
};

interface PendingRequest {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: ProtocolError) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** 请求发出所在的连接：连接关闭只拒绝它自己的请求，不连累后建的新连接。 */
  socket: WebSocket;
  /** 写进连接前一刻的本机时刻：确认帧带回的服务端时刻据此估算时钟偏差。 */
  sentAt: number;
}

export function generateUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // 局域网 HTTP 等非安全上下文没有 randomUUID，但 getRandomValues 照常可用：按 RFC 4122 v4 手工拼。
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 命令的追踪号取当前活动跨度的追踪号，与同一跨度里的错误上报同号，排障时能从前端跨度直接串到
 * 服务端日志。没有活动跨度（SDK 未初始化时追踪号是全零）就自造 UUID，保持每条命令各有一个标识。
 */
const commandTraceId = (span: Span): string => {
  const { traceId } = span.spanContext();
  return /^[0-9a-f]{32}$/.test(traceId) && !/^0+$/.test(traceId) ? traceId : generateUuid();
};

/**
 * 连接打开后、对外宣告可用之前要走完的前置帧（领取或挂上标签页身份）。
 * 前置帧自身失败不拦业务，见 `lib/TabSession.ts`。
 */
export type ConnectionPrelude = (exchange: PreludeExchange) => Promise<void>;

/** 前置帧的请求超时：要覆盖服务端探测现持有者的等待。 */
const PRELUDE_REQUEST_TIMEOUT_MS = 5_000;

/** 一次命令发送：`send` 的非泛型形态，供拦截器包装。 */
export type RawSend = (
  type: string,
  payload: Record<string, unknown>,
  options?: SendOptions
) => Promise<Record<string, unknown>>;

export interface WebSocketClientOptions {
  /**
   * 包装发送：拿到底层发送函数，返回带玩法专属语义的发送函数（例如被拒后换票重试）。
   * `send` 的类型与运行时行为因此保持一致，不再靠覆盖实例方法加类型强转。
   */
  sendInterceptor?: (next: RawSend) => RawSend;
  /**
   * 每次建连时现算的握手查询串。一次性凭据（如反作弊房的 ticket）绝不能固定在构造时
   * 读一次，否则重连必然带上废票。日志与指标仍只记 `path`，避免把凭据写进遥测。
   */
  handshakeQuery?: () => string;
  prelude?: ConnectionPrelude;
}

/** 全部游戏连接：登录或退出后逐个重连，让服务端在握手时重新解析会话 Cookie。 */
const clients = new Set<WebSocketClient>();

export class WebSocketClient {
  private socket: WebSocket | null = null;
  private messageHandlers: MessageHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private reconnectDueAt = 0;
  /** 上一次发起建连的时刻：立即重连据此守住最小间隔。 */
  private lastAttemptAt = 0;
  /** 业务可用后的稳定计时：到点才清零退避，握手即断的服务端不会造成紧密重连。 */
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private connectWaiters: Array<{ resolve: () => void; reject: (error: ProtocolError) => void }> =
    [];
  private readonly path: string;
  private readonly handshakeQuery?: () => string;
  private readonly prelude?: ConnectionPrelude;
  private readonly dispatchSend: RawSend;
  /** 前置帧还没走完：业务命令绝不能抢在身份绑定之前发出。 */
  private preluding = false;

  constructor(path: string, options: WebSocketClientOptions = {}) {
    this.path = path;
    this.handshakeQuery = options.handshakeQuery;
    this.prelude = options.prelude;
    const rawSend: RawSend = (type, payload, sendOptions) =>
      this.sendRaw(type, payload, sendOptions);
    this.dispatchSend = options.sendInterceptor ? options.sendInterceptor(rawSend) : rawSend;
    clients.add(this);
    installNetworkListeners();
  }

  private isReady(): boolean {
    return !this.preluding && this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * 账号身份只在握手时解析（见 Server/docs/Account.md §5）：登录或退出后关掉现有连接，
   * 走与掉线相同的重连路径，各游戏的重连逻辑随之重新接管座位并带上新身份。未连接时不做任何事。
   */
  refreshIdentity(): void {
    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
  }

  connect(): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.lastAttemptAt = Date.now();
    try {
      // 生产走同源相对路径（由边缘中间件反代），本地开发由 VITE_SERVER_URL 指定端口。
      // WebSocket 相对地址无法直接构造，必须显式补全协议与主机。
      const base = resolveServerBase();
      const absoluteBase = base || `${location.protocol}//${location.host}`;
      this.socket = new WebSocket(
        absoluteBase.replace(/^http/, "ws") + this.path + (this.handshakeQuery?.() ?? "")
      );
    } catch {
      this.scheduleReconnect();
      return;
    }

    // 三个处理器都以闭包里的 socket 核对身份：`refreshIdentity` 之后旧连接还在关闭中，
    // 此时页面可能已建了新连接，旧连接迟到的事件一律不能碰当前连接的状态。
    const socket = this.socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      captureClientLog("WebSocket 已连接", "info", { path: this.path });
      countClientMetric("bakagame.websocket.connections", 1, { path: this.path });
      if (this.prelude) void this.runPrelude(this.prelude, socket);
      else this.announceOpen();
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let message: ServerMessage;
      try {
        const parsed: unknown = JSON.parse(event.data as string);
        if (!isServerMessage(parsed)) return;
        message = parsed;
      } catch {
        // 仅拒绝坏 JSON；消费者异常由独立边界上报，不伪装成坏帧。
        return;
      }
      if (message.type === "ack" || message.type === "error") {
        this.settlePending(message, Date.now());
      }
      for (const handler of [...this.messageHandlers]) {
        try {
          handler(message);
        } catch (error) {
          captureClientException(error, { path: this.path, messageType: message.type });
        }
      }
    };

    socket.onclose = () => {
      this.rejectPendingOf(socket);
      if (this.socket !== socket) return;
      this.socket = null;
      this.preluding = false;
      this.clearStableTimer();
      captureClientLog("WebSocket 已断开", "warning", { path: this.path });
      countClientMetric("bakagame.websocket.disconnects", 1, { path: this.path });
      this.statusHandlers.forEach((handler) => handler(false));
      // 偏差样本不立即丢：重连间隙里读秒继续用旧偏差，重连的第一个确认帧再取代它。
      expireClockSample();
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // 浏览器随后会触发 close，由统一路径处理重连与请求拒绝。
    };
  }

  /** 按帧号配对请求并落定；确认帧顺带带回服务端时刻，用来估算本机时钟偏差。 */
  private settlePending(message: AckPacket | ErrorPacket, receivedAt: number): void {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) return;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    this.pendingRequests.delete(message.id);
    if (message.type === "error") {
      pending.reject(message.error);
      return;
    }
    if (typeof message.serverNow === "number" && Number.isFinite(message.serverNow)) {
      recordClockSample(message.serverNow, pending.sentAt, receivedAt);
    }
    pending.resolve((message.payload ?? {}) as Record<string, unknown>);
  }

  /** 拒绝某条连接上还没应答的请求；其它连接的请求不受影响。 */
  private rejectPendingOf(socket: WebSocket): void {
    for (const [id, pending] of this.pendingRequests) {
      if (pending.socket !== socket) continue;
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      this.pendingRequests.delete(id);
      pending.reject({ code: "DISCONNECTED", message: "连接已断开" });
    }
  }

  /** 主动离开游戏页面：终止连接与待处理请求，不再自动重连。 */
  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.clearStableTimer();
    const socket = this.socket;
    this.socket = null;
    this.preluding = false;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
    for (const pending of this.pendingRequests.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject({ code: "DISCONNECTED", message: "连接已断开" });
    }
    this.pendingRequests.clear();
    expireClockSample();
    for (const waiter of this.connectWaiters)
      waiter.reject({ code: "DISCONNECTED", message: "连接已断开" });
    this.connectWaiters = [];
    this.statusHandlers.forEach((handler) => handler(false));
  }

  private clearStableTimer(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  private announceOpen(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.reconnectAttempts = 0;
    }, RECONNECT_STABLE_MS);
    this.statusHandlers.forEach((handler) => handler(true));
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    waiters.forEach((waiter) => waiter.resolve());
  }

  /** 走完前置帧再宣告可用；期间连接已换就交给新连接，这次不再宣告。 */
  private async runPrelude(prelude: ConnectionPrelude, socket: WebSocket): Promise<void> {
    this.preluding = true;
    try {
      await prelude((type, payload) => this.exchange(socket, type, payload));
    } catch {
      // 身份是增强能力：前置帧失败按无身份继续，不把玩家挡在游戏外。
    }
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    this.preluding = false;
    this.announceOpen();
  }

  /** 绕过可用门闩的一次请求-应答，只给前置帧用：业务命令一律走 `send`。 */
  private exchange(
    socket: WebSocket,
    type: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = `pre-${Date.now().toString(36)}-${++this.requestCounter}`;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        rejectProtocol(reject, { code: "TIMEOUT", message: "请求超时" });
      }, PRELUDE_REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timer, socket, sentAt: Date.now() });
      socket.send(JSON.stringify({ id, traceId: generateUuid(), type, payload }));
    });
  }

  /** 站点连接在已打开的连接上回一帧（应答服务端探测），不等待业务门闩。 */
  exchangeOnOpenSocket(
    type: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket 未连接"));
    }
    return this.exchange(socket, type, payload);
  }

  waitForConnection(timeoutMs = CONNECT_WAIT_TIMEOUT_MS): Promise<void> {
    if (this.isReady()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: ProtocolError) => {
          clearTimeout(timer);
          rejectProtocol(reject, error);
        },
      };
      const timer = setTimeout(() => {
        this.connectWaiters = this.connectWaiters.filter((candidate) => candidate !== waiter);
        rejectProtocol(reject, { code: "CONNECT_TIMEOUT", message: "连接服务器超时" });
      }, timeoutMs);
      this.connectWaiters.push(waiter);
    });
  }

  /**
   * 这里的 `type`/`payload` 只按传输层需要保持宽松；命令名与载荷形状的类型收紧由各玩法的
   * facade 负责（`WhoIsFakerWs` / `SonGuessrWs` / `CEEWs`），三个玩法共用同一层。
   * 无超时的长任务在等待期间由调用方自行轮询房间状态，见 `SendOptions.timeout`。
   */
  send<T extends Record<string, unknown> = Record<string, unknown>>(
    type: string,
    payload: Record<string, unknown> = {},
    options?: SendOptions
  ): Promise<T> {
    return this.dispatchSend(type, payload, options) as Promise<T>;
  }

  private async sendRaw<T extends Record<string, unknown> = Record<string, unknown>>(
    type: string,
    payload: Record<string, unknown>,
    options?: SendOptions
  ): Promise<T> {
    const timeoutMs = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!this.isReady()) {
      if (
        this.socket?.readyState === WebSocket.CONNECTING ||
        this.socket?.readyState === WebSocket.OPEN
      ) {
        // 建连等待与请求超时语义不同：无超时请求只能在已建连的连接上等待。
        await this.waitForConnection(timeoutMs > 0 ? timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS);
      } else {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- 抛的是协议错误体：调用方按 code 区分「未连接」与其它失败，包成 Error 会丢掉 code
        throw { code: "NOT_CONNECTED", message: "WebSocket 未连接" };
      }
    }

    return withClientSpan(
      `WS ${type}`,
      async (span) => {
        const traceId = commandTraceId(span);
        span.setAttribute("traceId", traceId);
        const startedAt = performance.now();
        try {
          const result = await new Promise<T>((resolve, reject) => {
            const socket = this.socket;
            if (!socket || socket.readyState !== WebSocket.OPEN) {
              rejectProtocol(reject, { code: "NOT_CONNECTED", message: "WebSocket 未连接" });
              return;
            }

            const id = `req-${Date.now().toString(36)}-${++this.requestCounter}-${traceId.slice(0, 8)}`;
            const timer =
              timeoutMs > 0
                ? setTimeout(() => {
                    this.pendingRequests.delete(id);
                    rejectProtocol(reject, { code: "TIMEOUT", message: "请求超时" });
                  }, timeoutMs)
                : undefined;

            this.pendingRequests.set(id, {
              resolve: resolve as (payload: Record<string, unknown>) => void,
              reject,
              timer,
              socket,
              sentAt: Date.now(),
            });

            const envelope: Record<string, unknown> = { id, traceId, type, payload };
            if (options?.roomId) envelope.roomId = options.roomId;
            if (options?.sessionToken) envelope.sessionToken = options.sessionToken;
            socket.send(JSON.stringify(envelope));
          });

          const durationMs = performance.now() - startedAt;
          span.setStatus({ code: 1 });
          span.setAttribute("ws.duration_ms", durationMs);
          countClientMetric("bakagame.websocket.commands", 1, {
            path: this.path,
            command: type,
            status: "ok",
          });
          recordClientMetric("bakagame.websocket.command.duration", durationMs, {
            path: this.path,
            command: type,
          });
          return result;
        } catch (error) {
          const durationMs = performance.now() - startedAt;
          span.setStatus({ code: 2 });
          span.setAttribute("ws.duration_ms", durationMs);
          countClientMetric("bakagame.websocket.commands", 1, {
            path: this.path,
            command: type,
            status: "error",
          });
          recordClientMetric("bakagame.websocket.command.duration", durationMs, {
            path: this.path,
            command: type,
          });
          captureClientLog("WebSocket 命令失败", "error", {
            path: this.path,
            command: type,
            traceId,
            ...(isProtocolError(error) ? { code: error.code, message: error.message } : {}),
            error: isProtocolError(error)
              ? error.message
              : error instanceof Error
                ? error.message
                : String(error),
          });
          // 业务拒绝（密码错误、房间不存在、阶段不合法等）与断连、超时同属可预期的协议
          // 应答，只计指标与日志，严禁上报成异常事件：否则一次输错房间密码就会污染缺陷信号。
          if (!isProtocolError(error)) {
            captureClientException(error instanceof Error ? error : new Error(String(error)), {
              path: this.path,
              command: type,
              traceId,
            });
          }
          throw error;
        }
      },
      { "ws.path": this.path, "ws.command": type }
    );
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter((candidate) => candidate !== handler);
    };
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.push(handler);
    if (this.isReady()) handler(true);
    return () => {
      this.statusHandlers = this.statusHandlers.filter((candidate) => candidate !== handler);
    };
  }

  /** 全抖动退避：在 [下限, 当前档上限] 内随机，发布后重连的客户端才不会在同一时刻涌来。 */
  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const ceiling = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempts += 1;
    this.armReconnect(Math.max(RECONNECT_MIN_DELAY_MS, Math.random() * ceiling));
  }

  private armReconnect(delay: number): void {
    this.reconnectDueAt = Date.now() + delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * 联网恢复或页面回到前台时把已排定的重连提前：仍受最小间隔约束，且只提前不推后。
   * 没有排定重连（连接正常，或已主动断开）时什么都不做。
   */
  reconnectNow(): void {
    if (!this.reconnectTimer) return;
    const wait = Math.max(0, this.lastAttemptAt + RECONNECT_MIN_INTERVAL_MS - Date.now());
    if (this.reconnectDueAt - Date.now() <= wait) return;
    clearTimeout(this.reconnectTimer);
    this.armReconnect(wait);
  }
}

let networkListenersInstalled = false;

/** 睡眠唤醒、切网或回到前台之后不等退避走完：全站只挂一份监听，逐个通知有排定重连的客户端。 */
const installNetworkListeners = (): void => {
  if (networkListenersInstalled || typeof window === "undefined") return;
  networkListenersInstalled = true;
  const nudge = () => {
    for (const client of clients) client.reconnectNow();
  };
  window.addEventListener("online", nudge);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") nudge();
  });
};

export const createWebSocketClient = (path: string, options?: WebSocketClientOptions) =>
  new WebSocketClient(path, options);

export const refreshSocketIdentities = (): void => {
  for (const client of clients) client.refreshIdentity();
};
