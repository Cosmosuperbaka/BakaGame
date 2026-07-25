import { create } from "zustand";
import * as ws from "@/lib/ws";
import {
  saveSessionToken,
  getSessionToken,
  clearSessionToken,
  isTestRoomId,
} from "@/lib/cookie";
import type {
  RoomSnapshot,
  PrivateState,
  RoomSummaryItem,
  ServerMessage,
  EventPacket,
  ChatMessage,
  PublicPlayerView,
  RoundSummary,
} from "@/types";

export interface ToastItem {
  id: number;
  text: string;
  type: "info" | "error" | "success";
}

export interface GameState {
  connected: boolean;
  rooms: RoomSummaryItem[];
  roomId: string | null;
  sessionToken: string | null;
  snapshot: RoomSnapshot | null;
  privateState: PrivateState | null;
  sessionConflictRoomId: string | null;
  toasts: ToastItem[];

  // Actions
  setConnected: (connected: boolean) => void;
  setRooms: (rooms: RoomSummaryItem[]) => void;
  joinRoomState: (roomId: string, sessionToken: string) => void;
  leaveRoomState: () => void;
  handleSessionConflict: (roomId: string) => void;
  setSnapshot: (snapshot: RoomSnapshot) => void;
  setPrivateState: (privateState: PrivateState) => void;
  patchPlayer: (player: Partial<PublicPlayerView> & { id: string }) => void;
  appendChat: (message: ChatMessage) => void;
  setSummary: (summary: RoundSummary) => void;
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

export const useGameStore = create<GameState>((set, get) => ({
  connected: false,
  rooms: [],
  roomId: null,
  sessionToken: null,
  snapshot: null,
  privateState: null,
  sessionConflictRoomId: null,
  toasts: [],

  setConnected: (connected) => set({ connected }),
  setRooms: (rooms) => set({ rooms }),
  joinRoomState: (roomId, sessionToken) =>
    set({ roomId, sessionToken, sessionConflictRoomId: null }),
  leaveRoomState: () =>
    set({
      roomId: null,
      sessionToken: null,
      snapshot: null,
      privateState: null,
      sessionConflictRoomId: null,
    }),
  handleSessionConflict: (roomId) =>
    set({
      roomId: null,
      sessionToken: null,
      snapshot: null,
      privateState: null,
      sessionConflictRoomId: roomId,
    }),
  setSnapshot: (snapshot) => set({ snapshot }),
  setPrivateState: (privateState) => set({ privateState }),

  patchPlayer: (player) =>
    set((state) => {
      if (!state.snapshot) return state;
      const players = state.snapshot.players.map((p) =>
        p.id === player.id ? { ...p, ...player } : p
      );
      return { snapshot: { ...state.snapshot, players } };
    }),

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
      if (!state.snapshot) return state;
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
        currentStore.setRooms(evt.payload as RoomSummaryItem[]);
        break;
      case "room.snapshot":
        currentStore.setSnapshot(evt.payload as RoomSnapshot);
        break;
      case "game.privateState":
        currentStore.setPrivateState(evt.payload as PrivateState);
        break;
      case "room.playerChanged": {
        const p = evt.payload as Partial<PublicPlayerView> & { id: string };
        currentStore.patchPlayer(p);
        break;
      }
      case "chat.message":
        currentStore.appendChat(evt.payload as ChatMessage);
        break;
      case "game.phaseChanged":
        currentStore.addToast(phaseLabel((evt.payload as { phase: string }).phase));
        break;
      case "game.voteResult":
        currentStore.addToast("投票结果已公布");
        break;
      case "game.roundSummary":
        currentStore.setSummary(evt.payload as RoundSummary);
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
        const currentRoomId = currentStore.roomId;

        if (roomId && currentRoomId === roomId && isTestRoomId(roomId)) {
          clearSessionToken(roomId);
          currentStore.handleSessionConflict(roomId);
          currentStore.addToast("当前标签页已切换为独立测试会话，正在重新加入", "info");
        } else {
          currentStore.addToast("您的连接已被新连接替代", "error");
        }
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

function phaseLabel(phase: string): string {
  const map: Record<string, string> = {
    waiting: "等待中",
    assigningQuestioner: "指定出题人",
    wordSubmission: "出题阶段",
    description: "描述阶段",
    voting: "投票阶段",
    tieBreak: "平票PK",
    night: "夜晚阶段",
    daybreak: "天亮了",
    blankGuess: "白板猜词",
    gameOver: "游戏结束",
  };
  return map[phase] ?? phase;
}
