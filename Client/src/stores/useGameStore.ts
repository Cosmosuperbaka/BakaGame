import { create } from "zustand";
import * as ws from "@/lib/ws";
import { consumeStateSync } from "@/lib/stateSync";
import {
  saveSessionToken,
  getSessionToken,
  clearSessionToken,
} from "@/lib/cookie";
import type {
  RoomSnapshot,
  PrivateState,
  RoomSummary,
  ServerMessage,
  EventPacket,
  RoundSummary,
  DaybreakNotice,
} from "@/types";

export interface ToastItem {
  id: number;
  text: string;
  type: "info" | "error" | "success";
}

export interface GameState {
  connected: boolean;
  rooms: RoomSummary[];
  roomId: string | null;
  sessionToken: string | null;
  snapshot: RoomSnapshot | null;
  privateState: PrivateState | null;
  phaseResultPresentationPending: boolean;
  daybreakNotice: DaybreakNotice | null;
  toasts: ToastItem[];
  /**
   * 房间被服务端关闭的时刻。房间页据此立刻退回大厅：
   * 关闭是一次明确的服务端事件，不能靠「没有快照」这种同时也匹配初次挂载的推断来判断。
   */
  roomClosedAt: number | null;

  // Actions
  setConnected: (connected: boolean) => void;
  setRooms: (rooms: RoomSummary[]) => void;
  joinRoomState: (roomId: string, sessionToken: string) => void;
  leaveRoomState: () => void;
  markRoomClosed: () => void;
  setSnapshot: (snapshot: RoomSnapshot) => void;
  setPrivateState: (privateState: PrivateState) => void;
  showDaybreakNotice: (notice: DaybreakNotice) => void;
  setSummary: (summary: RoundSummary | null) => void;
  addToast: (text: string, type?: "info" | "error" | "success") => void;
  removeToast: (id: number) => void;

  // Async Business Actions
  subscribeLobby: () => Promise<void>;
  createRoom: (params: {
    roomId: string;
    name: string;
    visibility: "public" | "private";
    password?: string;
    allowSpectators: boolean;
    userName: string;
  }) => Promise<void>;
  joinRoom: (roomId: string, userName: string, password?: string) => Promise<void>;
  reconnectRoom: (roomId: string) => Promise<boolean>;
  leaveRoom: () => Promise<void>;
  sendCommand: (type: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

let toastCounter = 0;
let daybreakNoticeTimer: ReturnType<typeof setTimeout> | undefined;
let snapshotRevision: number | undefined;
let privateStateRevision: number | undefined;
let syncRequestPending = false;
let syncedSnapshot: RoomSnapshot | null = null;
let pendingGameOverSnapshot: RoomSnapshot | null = null;
let phaseResultVisibleUntil = 0;
let phaseResultTimer: ReturnType<typeof setTimeout> | undefined;

const PHASE_RESULT_DISPLAY_MS = 1500;

const clearPhaseResultPresentation = () => {
  if (phaseResultTimer) clearTimeout(phaseResultTimer);
  phaseResultTimer = undefined;
  pendingGameOverSnapshot = null;
  phaseResultVisibleUntil = 0;
};

const mergeChat = (
  existing: RoomSnapshot["chat"] = [],
  incoming: RoomSnapshot["chat"] = [],
): RoomSnapshot["chat"] => {
  const map = new Map<string, RoomSnapshot["chat"][number]>();
  for (const msg of existing) {
    map.set(msg.id, msg);
  }
  for (const msg of incoming) {
    map.set(msg.id, msg);
  }
  return Array.from(map.values()).sort((a, b) => a.createdAt - b.createdAt);
};

const isSameRound = (left: RoomSnapshot | null, right: RoomSnapshot) =>
  Boolean(
    left &&
    left.roomId === right.roomId &&
    left.status.roundId &&
    left.status.roundId === right.status.roundId,
  );

const hasNewElimination = (previous: RoomSnapshot, next: RoomSnapshot) => {
  const previousStatuses = new Map(
    previous.players.map((player) => [player.id, player.roundStatus]),
  );
  return next.players.some(
    (player) =>
      player.roundStatus === "dead" && previousStatuses.get(player.id) !== "dead",
  );
};

const isPermanentRoomError = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code;
  return code === "ROOM_NOT_FOUND" || code === "SESSION_NOT_FOUND" ||
    code === "SESSION_INVALID" || code === "PLAYER_KICKED";
};

const requestFullSync = () => {
  if (syncRequestPending) return;
  syncRequestPending = true;
  void useGameStore.getState().sendCommand("room.requestSync")
    .catch(() => {})
    .finally(() => {
      syncRequestPending = false;
    });
};

export const useGameStore = create<GameState>((set, get) => ({
  connected: false,
  rooms: [],
  roomId: null,
  sessionToken: null,
  snapshot: null,
  privateState: null,
  phaseResultPresentationPending: false,
  daybreakNotice: null,
  toasts: [],
  roomClosedAt: null,

  setConnected: (connected) => set({ connected }),
  setRooms: (rooms) => set({ rooms }),
  joinRoomState: (roomId, sessionToken) => {
    if (get().roomId !== roomId) {
      clearPhaseResultPresentation();
      set({ phaseResultPresentationPending: false });
    }
    set({ roomId, sessionToken, roomClosedAt: null });
  },
  leaveRoomState: () => {
    clearPhaseResultPresentation();
    set({
      roomId: null,
      sessionToken: null,
      snapshot: null,
      privateState: null,
      phaseResultPresentationPending: false,
      daybreakNotice: null,
    });
  },
  markRoomClosed: () => set({ roomClosedAt: Date.now() }),
  setSnapshot: (incomingSnapshot) => {
    const previousSnapshot = get().snapshot;
    const summarySource = pendingGameOverSnapshot ?? previousSnapshot;
    const previousSummary =
      incomingSnapshot.status.phase === "gameOver" &&
      !incomingSnapshot.summary &&
      summarySource?.status.roundId === incomingSnapshot.status.roundId
        ? summarySource?.summary
        : undefined;
    let snapshot = previousSummary
      ? { ...incomingSnapshot, summary: previousSummary }
      : incomingSnapshot;

    if (previousSnapshot && previousSnapshot.roomId === snapshot.roomId) {
      snapshot = { ...snapshot, chat: mergeChat(previousSnapshot.chat, snapshot.chat) };
    }

    if (!isSameRound(previousSnapshot, snapshot)) {
      clearPhaseResultPresentation();
      set({ snapshot, phaseResultPresentationPending: false });
      return;
    }

    if (
      previousSnapshot &&
      previousSnapshot.status.phase !== "gameOver" &&
      snapshot.status.phase !== "gameOver" &&
      hasNewElimination(previousSnapshot, snapshot)
    ) {
      phaseResultVisibleUntil = Date.now() + PHASE_RESULT_DISPLAY_MS;
    }

    if (
      previousSnapshot?.status.phase !== "gameOver" &&
      snapshot.status.phase === "gameOver" &&
      phaseResultVisibleUntil > Date.now()
    ) {
      pendingGameOverSnapshot = snapshot;
      set({ phaseResultPresentationPending: true });
      if (!phaseResultTimer) {
        phaseResultTimer = setTimeout(() => {
          phaseResultTimer = undefined;
          phaseResultVisibleUntil = 0;
          const pendingSnapshot = pendingGameOverSnapshot;
          pendingGameOverSnapshot = null;
          if (!pendingSnapshot) return;

          set((state) =>
            isSameRound(state.snapshot, pendingSnapshot)
              ? { snapshot: pendingSnapshot, phaseResultPresentationPending: false }
              : state,
          );
        }, phaseResultVisibleUntil - Date.now());
      }
      return;
    }

    if (snapshot.status.phase !== "gameOver" && pendingGameOverSnapshot) {
      clearPhaseResultPresentation();
      set({ phaseResultPresentationPending: false });
    }
    set({
      snapshot,
      phaseResultPresentationPending: snapshot.status.phase === "gameOver"
        ? false
        : get().phaseResultPresentationPending,
    });
  },
  setPrivateState: (privateState) => set({ privateState }),
  showDaybreakNotice: (notice) => {
    if (daybreakNoticeTimer) clearTimeout(daybreakNoticeTimer);
    set({ daybreakNotice: notice });
    daybreakNoticeTimer = setTimeout(() => {
      set({ daybreakNotice: null });
      daybreakNoticeTimer = undefined;
    }, 3000);
  },

  setSummary: (summary) =>
    set((state) => {
      if (!state.snapshot || !summary) return state;
      return { snapshot: { ...state.snapshot, summary } };
    }),

  addToast: (text, type = "info") => {
    const id = ++toastCounter;
    set((state) => ({
      toasts: [...state.toasts, { id, text, type }],
    }));
    setTimeout(() => {
      get().removeToast(id);
    }, 3000);
  },

  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),


  // 异步业务动作
  subscribeLobby: async () => {
    await ws.send("lobby.subscribeRooms");
  },

  createRoom: async (params) => {
    const res = await ws.send<{ sessionToken: string }>("room.create", params);
    saveSessionToken(params.roomId, res.sessionToken);
    get().joinRoomState(params.roomId, res.sessionToken);
  },

  joinRoom: async (roomId, userName, password) => {
    const payload: Record<string, unknown> = { userName };
    if (password) payload.password = password;
    const res = await ws.send<{ sessionToken: string }>("room.join", payload, { roomId });
    saveSessionToken(roomId, res.sessionToken);
    get().joinRoomState(roomId, res.sessionToken);
  },

  reconnectRoom: async (roomId) => {
    const token = getSessionToken(roomId);
    if (!token) return false;
    // 先恢复本地房间上下文。请求因切网或切后台短暂失败时，页面会继续等待
    // WebSocket 自动重连，而不是拿同一个名字创建第二个席位。
    get().joinRoomState(roomId, token);
    try {
      await ws.send("room.reconnect", { roomId, sessionToken: token });
      return true;
    } catch (error) {
      // 网络断开/请求超时不是会话失效，保留令牌让同一标签页稍后继续重连。
      if (!isPermanentRoomError(error)) return true;
      clearSessionToken(roomId);
      if (get().roomId === roomId) {
        get().leaveRoomState();
        get().markRoomClosed();
      }
      return false;
    }
  },

  leaveRoom: async () => {
    const { roomId, sessionToken } = get();
    try {
      await ws.send("room.leave", {}, {
        roomId: roomId ?? undefined,
        sessionToken: sessionToken ?? undefined,
      });
    } catch {
      // 忽略
    }
    if (roomId) clearSessionToken(roomId);
    get().leaveRoomState();
  },

  sendCommand: async (type, payload = {}) => {
    const { roomId, sessionToken, phaseResultPresentationPending } = get();
    if (type === "game.advancePhase" && phaseResultPresentationPending) {
      throw new Error("阶段结果展示中，请稍候");
    }
    return ws.send(type, payload, {
      roomId: roomId ?? undefined,
      sessionToken: sessionToken ?? undefined,
    });
  },
}));

// 初始化全局 WS 事件监听与重连联动
export function initGameSocket() {
  syncedSnapshot = null;
  snapshotRevision = undefined;
  privateStateRevision = undefined;

  const unsubMsg = ws.onMessage((msg: ServerMessage) => {
    if (msg.type !== "event") return;
    const evt = msg as EventPacket;
    const currentStore = useGameStore.getState();

    switch (evt.event) {
      case "lobby.rooms":
        currentStore.setRooms(evt.payload as RoomSummary[]);
        break;
      case "room.snapshot":
        {
          const result = consumeStateSync(
            syncedSnapshot,
            snapshotRevision,
            evt.payload,
          );
          if (result.needsFullSync || !result.state) {
            requestFullSync();
            break;
          }
          snapshotRevision = result.revision;
          syncedSnapshot = result.state as RoomSnapshot;
          currentStore.setSnapshot(syncedSnapshot);
        }
        break;
      case "game.privateState":
        {
          const result = consumeStateSync(
            currentStore.privateState,
            privateStateRevision,
            evt.payload,
          );
          if (result.needsFullSync || !result.state) {
            requestFullSync();
            break;
          }
          privateStateRevision = result.revision;
          currentStore.setPrivateState(result.state as PrivateState);
        }
        break;
      case "game.daybreak":
        currentStore.showDaybreakNotice(evt.payload as DaybreakNotice);
        break;
      case "game.voteResult":
        currentStore.addToast("投票结果已公布");
        break;
      case "game.roundSummary":
        currentStore.setSummary(evt.payload as RoundSummary | null);
        break;
      case "game.disconnectDecisionRequested":
        currentStore.addToast("有玩家掉线，等待出题人处理", "info");
        break;
      case "room.expiring":
        currentStore.addToast("房间即将因超时关闭", "error");
        break;
      case "room.closed": {
        // 房间已在服务端删除，残留的会话令牌只会让下次进房重连一个不存在的房间。
        const payload = evt.payload as { roomId?: string };
        const closedRoomId = payload.roomId ?? currentStore.roomId;
        if (closedRoomId) clearSessionToken(closedRoomId);
        currentStore.leaveRoomState();
        currentStore.markRoomClosed();
        currentStore.addToast("房间已关闭", "error");
        break;
      }
      case "session.replaced": {
        const payload = evt.payload as { roomId?: string };
        const roomId = payload.roomId;

        if (roomId && currentStore.roomId === roomId) {
          clearSessionToken(roomId);
          currentStore.leaveRoomState();
          // 席位已被新标签页接管，本标签页同样必须退回大厅。
          currentStore.markRoomClosed();
        }
        currentStore.addToast("您的连接已被新标签页替代", "error");
        break;
      }
      case "server.shutdown":
        currentStore.addToast("服务器即将关闭", "error");
        break;
    }
  });

  const unsubStatus = ws.onStatus((connected) => {
    const currentStore = useGameStore.getState();
    currentStore.setConnected(connected);

    if (connected) {
      snapshotRevision = undefined;
      privateStateRevision = undefined;
      syncedSnapshot = null;
      ws.send("lobby.subscribeRooms").catch(() => {});
      if (currentStore.roomId && currentStore.sessionToken) {
        ws.send("room.reconnect", {
          roomId: currentStore.roomId,
          sessionToken: currentStore.sessionToken,
        }).catch((error) => {
          if (!isPermanentRoomError(error)) return;
          const roomId = useGameStore.getState().roomId;
          if (!roomId) return;
          clearSessionToken(roomId);
          useGameStore.getState().leaveRoomState();
          useGameStore.getState().markRoomClosed();
        });
      }
    }
  });

  ws.connect();

  return () => {
    unsubMsg();
    unsubStatus();
  };
}
