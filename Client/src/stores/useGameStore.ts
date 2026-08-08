import { create } from "zustand";
import * as ws from "@/lib/ws";
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
  ChatMessage,
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
  daybreakNotice: DaybreakNotice | null;
  toasts: ToastItem[];

  // Actions
  setConnected: (connected: boolean) => void;
  setRooms: (rooms: RoomSummary[]) => void;
  joinRoomState: (roomId: string, sessionToken: string) => void;
  leaveRoomState: () => void;
  setSnapshot: (snapshot: RoomSnapshot) => void;
  setPrivateState: (privateState: PrivateState) => void;
  showDaybreakNotice: (notice: DaybreakNotice) => void;
  appendChat: (message: ChatMessage) => void;
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

export const useGameStore = create<GameState>((set, get) => ({
  connected: false,
  rooms: [],
  roomId: null,
  sessionToken: null,
  snapshot: null,
  privateState: null,
  daybreakNotice: null,
  toasts: [],

  setConnected: (connected) => set({ connected }),
  setRooms: (rooms) => set({ rooms }),
  joinRoomState: (roomId, sessionToken) =>
    set({ roomId, sessionToken }),
  leaveRoomState: () =>
    set({
      roomId: null,
      sessionToken: null,
      snapshot: null,
      privateState: null,
      daybreakNotice: null,
    }),
  setSnapshot: (snapshot) =>
    set((state) => {
      const previousSnapshot = state.snapshot;
      const previousSummary =
        snapshot.status.phase === "gameOver" &&
        !snapshot.summary &&
        previousSnapshot &&
        previousSnapshot.status.roundId === snapshot.status.roundId
          ? previousSnapshot.summary
          : undefined;

      return {
        snapshot: previousSummary ? { ...snapshot, summary: previousSummary } : snapshot,
      };
    }),
  setPrivateState: (privateState) => set({ privateState }),
  showDaybreakNotice: (notice) => {
    if (daybreakNoticeTimer) clearTimeout(daybreakNoticeTimer);
    set({ daybreakNotice: notice });
    daybreakNoticeTimer = setTimeout(() => {
      set({ daybreakNotice: null });
      daybreakNoticeTimer = undefined;
    }, 3000);
  },

  appendChat: (message) =>
    set((state) => {
      if (!state.snapshot) return state;
      return {
        snapshot: {
          ...state.snapshot,
          chat: [...state.snapshot.chat, message],
        },
      };
    }),

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
    try {
      await ws.send("room.reconnect", { roomId, sessionToken: token });
      get().joinRoomState(roomId, token);
      return true;
    } catch {
      clearSessionToken(roomId);
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
    const { roomId, sessionToken } = get();
    return ws.send(type, payload, {
      roomId: roomId ?? undefined,
      sessionToken: sessionToken ?? undefined,
    });
  },
}));

// 初始化全局 WS 事件监听与重连联动
export function initGameSocket() {
  const unsubMsg = ws.onMessage((msg: ServerMessage) => {
    if (msg.type !== "event") return;
    const evt = msg as EventPacket;
    const currentStore = useGameStore.getState();

    switch (evt.event) {
      case "lobby.rooms":
        currentStore.setRooms(evt.payload as RoomSummary[]);
        break;
      case "room.snapshot":
        currentStore.setSnapshot(evt.payload as RoomSnapshot);
        break;
      case "game.privateState":
        currentStore.setPrivateState(evt.payload as PrivateState);
        break;
      case "chat.message":
        currentStore.appendChat(evt.payload as ChatMessage);
        break;
      case "game.phaseChanged":
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
      case "room.closed":
        currentStore.leaveRoomState();
        currentStore.addToast("房间已关闭", "error");
        break;
      case "session.replaced": {
        const payload = evt.payload as { roomId?: string };
        const roomId = payload.roomId;

        if (roomId && currentStore.roomId === roomId) {
          clearSessionToken(roomId);
          currentStore.leaveRoomState();
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
      ws.send("lobby.subscribeRooms").catch(() => {});
      if (currentStore.roomId && currentStore.sessionToken) {
        ws.send("room.reconnect", {
          roomId: currentStore.roomId,
          sessionToken: currentStore.sessionToken,
        }).catch(() => {});
      }
    }
  });

  ws.connect();

  return () => {
    unsubMsg();
    unsubStatus();
  };
}
