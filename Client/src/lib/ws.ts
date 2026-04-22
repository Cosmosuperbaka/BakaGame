import type { ServerMessage } from "@/types";

// ==================== WebSocket 连接管理器 ====================

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4850";
const WS_URL = SERVER_URL.replace(/^http/, "ws") + "/ws";

type MessageHandler = (msg: ServerMessage) => void;
type StatusHandler = (connected: boolean) => void;

interface PendingRequest {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: { code: string; message: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

let ws: WebSocket | null = null;
let messageHandlers: MessageHandler[] = [];
let statusHandlers: StatusHandler[] = [];
let pendingRequests = new Map<string, PendingRequest>();
let reqCounter = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 10000;
let intentionalClose = false;

// 等待连接就绪的 Promise 队列
let connectResolvers: Array<() => void> = [];

function getReconnectDelay(): number {
  return Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
}

export function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  intentionalClose = false;

  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectAttempts = 0;
    statusHandlers.forEach((h) => h(true));
    // 释放所有等待连接的 Promise
    const resolvers = connectResolvers;
    connectResolvers = [];
    resolvers.forEach((r) => r());
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string) as ServerMessage;

      if (msg.type === "ack" || msg.type === "error") {
        const pending = pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(msg.id);
          if (msg.type === "ack") {
            pending.resolve((msg.payload ?? {}) as Record<string, unknown>);
          } else {
            pending.reject(msg.error);
          }
        }
      }

      messageHandlers.forEach((h) => h(msg));
    } catch {
      // 忽略无法解析的消息
    }
  };

  ws.onclose = () => {
    ws = null;
    statusHandlers.forEach((h) => h(false));
    if (!intentionalClose) {
      scheduleReconnect();
    }
  };

  ws.onerror = () => {
    // onclose 会紧接着触发
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = getReconnectDelay();
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

export function disconnect(): void {
  intentionalClose = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}

export function isConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}

// 等待 WebSocket 连接就绪（已连接则立即返回）
export function waitForConnection(timeoutMs = 8000): Promise<void> {
  if (ws?.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      connectResolvers = connectResolvers.filter((r) => r !== wrappedResolve);
      reject({ code: "CONNECT_TIMEOUT", message: "连接服务器超时" });
    }, timeoutMs);

    const wrappedResolve = () => {
      clearTimeout(timer);
      resolve();
    };
    connectResolvers.push(wrappedResolve);
  });
}

// 发送消息并等待 ack
export function send<T extends Record<string, unknown> = Record<string, unknown>>(
  type: string,
  payload: Record<string, unknown> = {},
  options?: { roomId?: string; sessionToken?: string; timeout?: number }
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject({ code: "NOT_CONNECTED", message: "WebSocket 未连接" });
      return;
    }

    const id = `req-${++reqCounter}`;
    const timeout = options?.timeout ?? 10000;

    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject({ code: "TIMEOUT", message: "请求超时" });
    }, timeout);

    pendingRequests.set(id, {
      resolve: resolve as (payload: Record<string, unknown>) => void,
      reject,
      timer,
    });

    const envelope: Record<string, unknown> = { id, type, payload };
    if (options?.roomId) envelope.roomId = options.roomId;
    if (options?.sessionToken) envelope.sessionToken = options.sessionToken;

    ws.send(JSON.stringify(envelope));
  });
}

// 注册消息监听
export function onMessage(handler: MessageHandler): () => void {
  messageHandlers.push(handler);
  return () => {
    messageHandlers = messageHandlers.filter((h) => h !== handler);
  };
}

// 注册连接状态监听
export function onStatus(handler: StatusHandler): () => void {
  statusHandlers.push(handler);
  return () => {
    statusHandlers = statusHandlers.filter((h) => h !== handler);
  };
}
