import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicStatusSnapshot } from "@bakagame/shared";
import { parseSystemStatus, fetchSystemStatus } from "@/lib/SystemStatus";
import { resolveServerBase } from "@/lib/ServerEndpoint";

/** 断线重连的退避上限：状态页是长期开着的页面，重连再密也不该超过推送节奏本身。 */
const MAX_RECONNECT_DELAY_MS = 15_000;

export type StatusConnection = "connecting" | "live" | "offline";

export interface StatusLiveState {
  /** 最近一次收到的快照；首帧未到为 null。 */
  snapshot: PublicStatusSnapshot | null;
  /** 通道状态：读作页面上那枚「实时 / 重连中 / 已断开」指示。 */
  connection: StatusConnection;
  /** 请求服务端立刻重推一次；通道没开时返回 false，调用方改用 `fetchOnce`。 */
  refresh: () => boolean;
  /** 走一次 HTTP 拉当前快照：通道断开时手动刷新仍要有反馈。 */
  fetchOnce: () => Promise<void>;
}

const socketUrl = (): string => {
  const base = resolveServerBase() || `${location.protocol}//${location.host}`;
  return `${base.replace(/^http/, "ws")}/api/status/ws`;
};

/**
 * 状态页的实时通道：连上即拿到当前快照，之后每 15 秒一次，断线自动退避重连。
 *
 * WS 生命周期收在专用 Hook 里（`Client/docs/Engineering.md`），页面只读状态。
 * 这里不复用游戏的 `WebSocketClient`：那套带信封、ACK 与命令回执，是为对局协议设计的，
 * 状态通道只有一条服务端单向推送，套上去只会多出一层永远用不到的收发簿记。
 *
 * 通道断开不改变已读到的状态：快照继续留在页面上，指示器说明它不再更新，
 * 不把「连接断了」误读成「服务挂了」。
 */
export function useStatusLive(): StatusLiveState {
  const [snapshot, setSnapshot] = useState<PublicStatusSnapshot | null>(null);
  const [connection, setConnection] = useState<StatusConnection>("connecting");
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = (): void => {
      if (closed) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(socketUrl());
      } catch {
        setConnection("offline");
        schedule();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        attempts = 0;
        setConnection("live");
      };
      socket.onmessage = (event) => {
        try {
          setSnapshot(parseSystemStatus(JSON.parse(String(event.data))));
        } catch {
          // 单帧不合形状就丢掉：下一帧仍会到，不为一条坏消息把整页打回未知。
        }
      };
      socket.onclose = () => {
        socketRef.current = null;
        if (closed) return;
        setConnection("offline");
        schedule();
      };
      socket.onerror = () => {
        // onError 后必跟 onclose，重连只在 onclose 一处发起，避免两条路各自退避。
      };
    };

    const schedule = (): void => {
      const delay = Math.min(1_000 * 2 ** attempts, MAX_RECONNECT_DELAY_MS);
      attempts += 1;
      timer = setTimeout(connect, delay);
    };

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        // 先摘掉回调再关：卸载瞬间触发的 close 不该再去排一次重连。
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
    };
  }, []);

  const refresh = useCallback((): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send("refresh");
    return true;
  }, []);

  const fetchOnce = useCallback(async (): Promise<void> => {
    setSnapshot(await fetchSystemStatus());
  }, []);

  return { snapshot, connection, refresh, fetchOnce };
}
