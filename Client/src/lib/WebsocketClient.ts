import type { ErrorPacket, ServerMessage } from "@/types";
import {
  CONNECT_WAIT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_RECONNECT_DELAY_MS,
} from "@/config/Constants";
import { resolveServerBase } from "@/lib/ServerEndpoint";
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

interface PendingRequest {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: ProtocolError) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export function generateUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // 兼容局域网 HTTP 等非安全上下文环境
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class WebSocketClient {
  private socket: WebSocket | null = null;
  private messageHandlers: MessageHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private connectResolvers: Array<() => void> = [];
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  connect(): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      // 生产走同源相对路径（由边缘中间件反代），本地开发由 VITE_SERVER_URL 指定端口。
      // WebSocket 相对地址无法直接构造，必须显式补全协议与主机。
      const base = resolveServerBase();
      const absoluteBase = base || `${location.protocol}//${location.host}`;
      this.socket = new WebSocket(absoluteBase.replace(/^http/, "ws") + this.path);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.reconnectAttempts = 0;
      captureClientLog("WebSocket 已连接", "info", { path: this.path });
      countClientMetric("bakagame.websocket.connections", 1, { path: this.path });
      this.statusHandlers.forEach((handler) => handler(true));
      const resolvers = this.connectResolvers;
      this.connectResolvers = [];
      resolvers.forEach((resolve) => resolve());
    };

    this.socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as ServerMessage;
        if (message.type === "ack" || message.type === "error") {
          const pending = this.pendingRequests.get(message.id);
          if (pending) {
            if (pending.timer !== undefined) clearTimeout(pending.timer);
            this.pendingRequests.delete(message.id);
            if (message.type === "ack") {
              pending.resolve((message.payload ?? {}) as Record<string, unknown>);
            } else {
              pending.reject(message.error);
            }
          }
        }
        this.messageHandlers.forEach((handler) => handler(message));
      } catch {
        // 非协议消息不会进入业务层。
      }
    };

    this.socket.onclose = () => {
      this.socket = null;
      captureClientLog("WebSocket 已断开", "warning", { path: this.path });
      countClientMetric("bakagame.websocket.disconnects", 1, { path: this.path });
      for (const [id, pending] of this.pendingRequests) {
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        pending.reject({ code: "DISCONNECTED", message: "连接已断开" });
        this.pendingRequests.delete(id);
      }
      this.statusHandlers.forEach((handler) => handler(false));
      this.scheduleReconnect();
    };

    this.socket.onerror = () => {
      // 浏览器随后会触发 close，由统一路径处理重连与请求拒绝。
    };
  }

  waitForConnection(timeoutMs = CONNECT_WAIT_TIMEOUT_MS): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const wrappedResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.connectResolvers = this.connectResolvers.filter(
          (candidate) => candidate !== wrappedResolve,
        );
        reject({ code: "CONNECT_TIMEOUT", message: "连接服务器超时" });
      }, timeoutMs);
      this.connectResolvers.push(wrappedResolve);
    });
  }

  /**
   * `options.timeout` 传入 0 或负数表示**不设请求超时**：自动出题这类需要连续回源
   * 多个外部接口的命令，耗时完全由上游决定。客户端超时只会制造「后端还在选曲、
   * 前端已提示失败」的假失败，等待期间由调用方自行轮询房间状态即可。
   */
  async send<T extends Record<string, unknown> = Record<string, unknown>>(
    type: string,
    payload: Record<string, unknown> = {},
    options?: { roomId?: string; sessionToken?: string; timeout?: number },
  ): Promise<T> {
    const timeoutMs = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      if (this.socket?.readyState === WebSocket.CONNECTING) {
        // 建连等待与请求超时语义不同：无超时请求只能在已建连的连接上等待。
        await this.waitForConnection(timeoutMs > 0 ? timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS);
      } else {
        throw { code: "NOT_CONNECTED", message: "WebSocket 未连接" };
      }
    }

    const startedAt = performance.now();
    return withClientSpan(
      `WS ${type}`,
      async (span) => {
        try {
          const result = await new Promise<T>((resolve, reject) => {
            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
              reject({ code: "NOT_CONNECTED", message: "WebSocket 未连接" });
              return;
            }

            const traceId = generateUuid();
            const id = `req-${Date.now().toString(36)}-${++this.requestCounter}-${traceId.slice(0, 8)}`;
            const timer = timeoutMs > 0
              ? setTimeout(() => {
                this.pendingRequests.delete(id);
                reject({ code: "TIMEOUT", message: "请求超时" });
              }, timeoutMs)
              : undefined;

            this.pendingRequests.set(id, {
              resolve: resolve as (payload: Record<string, unknown>) => void,
              reject,
              timer,
            });

            const envelope: Record<string, unknown> = { id, traceId, type, payload };
            if (options?.roomId) envelope.roomId = options.roomId;
            if (options?.sessionToken) envelope.sessionToken = options.sessionToken;
            this.socket.send(JSON.stringify(envelope));
          });

          const durationMs = performance.now() - startedAt;
          span.setStatus({ code: 1 });
          span.setAttribute("ws.duration_ms", durationMs);
          countClientMetric("bakagame.websocket.commands", 1, { path: this.path, command: type, status: "ok" });
          recordClientMetric("bakagame.websocket.command.duration", durationMs, { path: this.path, command: type });
          return result;
        } catch (error) {
          const durationMs = performance.now() - startedAt;
          span.setStatus({ code: 2 });
          span.setAttribute("ws.duration_ms", durationMs);
          countClientMetric("bakagame.websocket.commands", 1, { path: this.path, command: type, status: "error" });
          recordClientMetric("bakagame.websocket.command.duration", durationMs, { path: this.path, command: type });
          captureClientLog("WebSocket 命令失败", "error", {
            path: this.path,
            command: type,
            error: error instanceof Error ? error.message : String(error),
          });
          // 业务拒绝（密码错误、房间不存在、阶段不合法等）与断连、超时同属可预期的协议
          // 应答，只计指标与日志，严禁上报成异常事件：否则一次输错房间密码就会污染缺陷信号。
          if (!isProtocolError(error)) {
            captureClientException(
              error instanceof Error ? error : new Error(String(error)),
              { path: this.path, command: type },
            );
          }
          throw error;
        }
      },
      { "ws.path": this.path, "ws.command": type },
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
    if (this.socket?.readyState === WebSocket.OPEN) handler(true);
    return () => {
      this.statusHandlers = this.statusHandlers.filter((candidate) => candidate !== handler);
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export const createWebSocketClient = (path: string) => new WebSocketClient(path);
