import { create } from "zustand";
import * as ws from "@/lib/WhoIsFakerWs";
import { consumeStateSync } from "@/lib/StateSync";
import {
  saveSessionToken,
  getSessionToken,
  clearSessionToken,
} from "@/lib/Storage";
import type {
  RoomSnapshot,
  PrivateState,
  RoomSummary,
  ServerMessage,
  EventPacket,
  DaybreakNotice,
} from "@/types";

export interface ToastItem {
  id: number;
  text: string;
  type: "info" | "error" | "success";
}

export interface WhoIsFakerGameState {
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
  setSnapshot: (snapshot: RoomSnapshot | null) => void;
  applyIncomingSnapshot: (snapshot: RoomSnapshot | null) => void;
  setPrivateState: (privateState: PrivateState | null) => void;
  showDaybreakNotice: (notice: DaybreakNotice) => void;
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

export type GameState = WhoIsFakerGameState;

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
  void useWhoIsFakerStore.getState().sendCommand("room.requestSync")
    .catch(() => {})
    .finally(() => {
      syncRequestPending = false;
    });
};

export const useWhoIsFakerStore = create<WhoIsFakerGameState>((set, get) => ({
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
    if (!incomingSnapshot) {
      clearPhaseResultPresentation();
      set({ snapshot: null, phaseResultPresentationPending: false });
      return;
    }
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
  applyIncomingSnapshot: (snapshot) => get().setSnapshot(snapshot),
  setPrivateState: (privateState) => set({ privateState }),
  showDaybreakNotice: (notice) => {
    if (daybreakNoticeTimer) clearTimeout(daybreakNoticeTimer);
    set({ daybreakNotice: notice });
    daybreakNoticeTimer = setTimeout(() => {
      set({ daybreakNotice: null });
      daybreakNoticeTimer = undefined;
    }, 4500);
  },
  addToast: (text, type = "info") => {
    const id = ++toastCounter;
    set((state) => ({ toasts: [...state.toasts, { id, text, type }] }));
    setTimeout(() => get().removeToast(id), 3000);
  },
  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  subscribeLobby: async () => {
    await ws.send("lobby.subscribeRooms");
  },

  createRoom: async (params) => {
    const res = await ws.send<{
      roomId?: string;
      sessionToken: string;
      snapshot?: RoomSnapshot;
      privateState?: PrivateState;
    }>("room.create", params);

    const roomId = res.roomId ?? params.roomId;
    saveSessionToken(roomId, res.sessionToken);
    get().joinRoomState(roomId, res.sessionToken);
    if (res.snapshot) get().setSnapshot(res.snapshot);
    if (res.privateState) get().setPrivateState(res.privateState);
  },

  joinRoom: async (roomId, userName, password) => {
    const res = await ws.send<{
      roomId?: string;
      sessionToken: string;
      snapshot?: RoomSnapshot;
      privateState?: PrivateState;
    }>("room.join", { userName, password }, { roomId });

    const canonicalRoomId = res.roomId ?? roomId;
    saveSessionToken(canonicalRoomId, res.sessionToken);
    get().joinRoomState(canonicalRoomId, res.sessionToken);
    if (res.snapshot) get().setSnapshot(res.snapshot);
    if (res.privateState) get().setPrivateState(res.privateState);
  },

  reconnectRoom: async (roomId) => {
    const token = getSessionToken(roomId);
    if (!token) return false;

    try {
      const res = await ws.send<{
        roomId?: string;
        sessionToken: string;
        snapshot?: RoomSnapshot;
        privateState?: PrivateState;
      }>("room.reconnect", { roomId, sessionToken: token });

      const canonicalRoomId = res.roomId ?? roomId;
      saveSessionToken(canonicalRoomId, res.sessionToken);
      get().joinRoomState(canonicalRoomId, res.sessionToken);
      if (res.snapshot) get().setSnapshot(res.snapshot);
      if (res.privateState) get().setPrivateState(res.privateState);
      return true;
    } catch (error) {
      if (!isPermanentRoomError(error)) {
        get().joinRoomState(roomId, token);
        return true;
      }
      clearSessionToken(roomId);
      get().leaveRoomState();
      get().markRoomClosed();
      return false;
    }
  },

  leaveRoom: async () => {
    const { roomId, sessionToken } = get();
    if (!roomId) return;
    try {
      await ws.send("room.leave", {}, { roomId, sessionToken: sessionToken ?? undefined });
    } catch {
      // 忽略离开房间失败
    } finally {
      clearSessionToken(roomId);
      get().leaveRoomState();
    }
  },

  sendCommand: async (type, payload = {}) => {
    if (get().phaseResultPresentationPending) {
      throw new Error("阶段结果展示中，请稍候");
    }
    const { roomId, sessionToken } = get();
    return ws.send(type, payload, {
      roomId: roomId ?? undefined,
      sessionToken: sessionToken ?? undefined,
    });
  },
}));

export const useGameStore = useWhoIsFakerStore;

export function initWhoIsFakerWs() {
  const unsubMsg = ws.onMessage((msg: ServerMessage) => {
    if (msg.type !== "event") return;
    const evt = msg as EventPacket;
    const currentStore = useWhoIsFakerStore.getState();

    switch (evt.event) {
      case "lobby.rooms":
        currentStore.setRooms(evt.payload as RoomSummary[]);
        break;
      case "room.snapshot":
        {
          const result = consumeStateSync(
            syncedSnapshot ?? currentStore.snapshot,
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
    const currentStore = useWhoIsFakerStore.getState();
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
          const roomId = useWhoIsFakerStore.getState().roomId;
          if (!roomId) return;
          clearSessionToken(roomId);
          useWhoIsFakerStore.getState().leaveRoomState();
          useWhoIsFakerStore.getState().markRoomClosed();
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

export const initWs = initWhoIsFakerWs;
export const initGameSocket = initWhoIsFakerWs;
