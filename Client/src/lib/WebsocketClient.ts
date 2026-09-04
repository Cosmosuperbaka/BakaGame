import type { ServerMessage } from "@/types";
import {
  CONNECT_WAIT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SERVER_URL,
  MAX_RECONNECT_DELAY_MS,
} from "@/config/Constants";

type MessageHandler = (message: ServerMessage) => void;
type StatusHandler = (connected: boolean) => void;

interface PendingRequest {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: { code: string; message: string; details?: unknown }) => void;
  timer: ReturnType<typeof setTimeout>;
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
      const serverUrl = import.meta.env.VITE_SERVER_URL || DEFAULT_SERVER_URL;
      this.socket = new WebSocket(serverUrl.replace(/^http/, "ws") + this.path);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.reconnectAttempts = 0;
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
            clearTimeout(pending.timer);
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
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
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

  async send<T extends Record<string, unknown> = Record<string, unknown>>(
    type: string,
    payload: Record<string, unknown> = {},
    options?: { roomId?: string; sessionToken?: string; timeout?: number },
  ): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      if (this.socket?.readyState === WebSocket.CONNECTING) {
        await this.waitForConnection(options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS);
      } else {
        throw { code: "NOT_CONNECTED", message: "WebSocket 未连接" };
      }
    }

    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject({ code: "NOT_CONNECTED", message: "WebSocket 未连接" });
        return;
      }

      const traceId = crypto.randomUUID();
      const id = `req-${Date.now().toString(36)}-${++this.requestCounter}-${traceId.slice(0, 8)}`;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject({ code: "TIMEOUT", message: "请求超时" });
      }, options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS);

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
