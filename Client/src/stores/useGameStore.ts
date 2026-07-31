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
  RoomSummary,
  ServerMessage,
  EventPacket,
  ChatMessage,
  PublicPlayerView,
  RoundSummary,
  GamePhase,
  PlayerRole,
  DescriptionRecord,
  DaybreakNotice,
} from "@/types";
import { createMockTestRoomState, type TestPerspective } from "@/lib/mockData";

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
  sessionConflictRoomId: string | null;
  toasts: ToastItem[];
  testPerspective: TestPerspective;
  testRole: PlayerRole;

  // Actions
  setConnected: (connected: boolean) => void;
  setRooms: (rooms: RoomSummary[]) => void;
  joinRoomState: (roomId: string, sessionToken: string) => void;
  leaveRoomState: () => void;
  handleSessionConflict: (roomId: string) => void;
  setSnapshot: (snapshot: RoomSnapshot) => void;
  setPrivateState: (privateState: PrivateState) => void;
  showDaybreakNotice: (notice: DaybreakNotice) => void;
  patchPlayer: (player: Partial<PublicPlayerView> & { id: string }) => void;
  appendChat: (message: ChatMessage) => void;
  setSummary: (summary: RoundSummary) => void;
  addToast: (text: string, type?: "info" | "error" | "success") => void;
  removeToast: (id: number) => void;
  initTestRoomOffline: (
    phase?: GamePhase,
    perspective?: TestPerspective,
    role?: PlayerRole
  ) => void;
  jumpTestRoomPhase: (phase: GamePhase) => void;
  setTestRoomPerspective: (
    perspective: TestPerspective,
    role?: PlayerRole
  ) => void;

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
      daybreakNotice: null,
      sessionConflictRoomId: null,
    }),
  handleSessionConflict: (roomId) =>
    set({
      roomId: null,
      sessionToken: null,
      snapshot: null,
      privateState: null,
      daybreakNotice: null,
      sessionConflictRoomId: roomId,
    }),
  setSnapshot: (snapshot) => set({ snapshot }),
  setPrivateState: (privateState) => set({ privateState }),
  showDaybreakNotice: (notice) => {
    if (daybreakNoticeTimer) clearTimeout(daybreakNoticeTimer);
    set({ daybreakNotice: notice });
    daybreakNoticeTimer = setTimeout(() => {
      set({ daybreakNotice: null });
      daybreakNoticeTimer = undefined;
    }, 3000);
  },

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

  testPerspective: "player",
  testRole: "civilian",

  initTestRoomOffline: (phase = "waiting", perspective = "player", role = "civilian") => {
    const { snapshot, privateState } = createMockTestRoomState(phase, perspective, role);
    set({
      roomId: "Oblivionis",
      snapshot,
      privateState,
      testPerspective: perspective,
      testRole: role,
    });
  },

  jumpTestRoomPhase: (phase) => {
    const { testPerspective, testRole } = get();
    const { snapshot, privateState } = createMockTestRoomState(phase, testPerspective, testRole);
    set({ snapshot, privateState });
  },

  setTestRoomPerspective: (perspective, role) => {
    const currentPhase = get().snapshot?.status.phase ?? "waiting";
    const newRole = role ?? get().testRole;
    const { snapshot, privateState } = createMockTestRoomState(currentPhase, perspective, newRole);
    set({
      snapshot,
      privateState,
      testPerspective: perspective,
      testRole: newRole,
    });
  },

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
    if (roomId && isTestRoomId(roomId)) {
      return handleTestRoomCommand(type, payload, get, set);
    }
    return ws.send(type, payload, {
      roomId: roomId ?? undefined,
      sessionToken: sessionToken ?? undefined,
    });
  },
}));

const NEXT_PHASE_MAP: Record<GamePhase, GamePhase> = {
  waiting: "assigningQuestioner",
  assigningQuestioner: "wordSubmission",
  wordSubmission: "description",
  description: "voting",
  voting: "night",
  tieBreak: "voting",
  night: "description",
  blankGuess: "gameOver",
  gameOver: "waiting",
};

function handleTestRoomCommand(
  type: string,
  payload: Record<string, unknown>,
  get: () => GameState,
  set: (partial: Partial<GameState> | ((state: GameState) => Partial<GameState>)) => void
): Record<string, unknown> {
  const store = get();
  const snapshot = store.snapshot;
  const privateState = store.privateState;

  if (!snapshot) return { success: true };

  switch (type) {
    case "game.advancePhase": {
      const currentPhase = snapshot.status.phase;
      const nextPhase = NEXT_PHASE_MAP[currentPhase] ?? "waiting";
      store.jumpTestRoomPhase(nextPhase);
      if (currentPhase === "night") {
        const nextSnapshot = get().snapshot;
        if (nextSnapshot) {
          const day = snapshot.status.day + 1;
          set({
            snapshot: {
              ...nextSnapshot,
              status: { ...nextSnapshot.status, day },
            },
          });
          store.showDaybreakNotice({ day, eliminatedPlayerIds: [] });
        }
      }
      return { success: true, phase: nextPhase };
    }

    case "game.submitDescription": {
      const text = (payload.text as string) || "";
      if (text && privateState) {
        const me = snapshot.players.find((p) => p.id === privateState.playerId);
        const newDesc: DescriptionRecord = {
          id: `desc_${Date.now()}`,
          playerId: privateState.playerId,
          playerName: me?.name || "测试玩家",
          text,
          kind: snapshot.status.phase === "tieBreak" ? "tieBreak" : "description",
          cycle: snapshot.status.day || 1,
          createdAt: Date.now(),
        };
        set({
          snapshot: {
            ...snapshot,
            descriptions: [...snapshot.descriptions, newDesc],
          },
        });
      }
      return { success: true };
    }

    case "game.submitVote": {
      return { success: true, targetId: payload.targetId };
    }

    case "game.submitNightAction": {
      if (privateState) {
        set({
          privateState: {
            ...privateState,
            nightActionSubmitted: true,
          },
        });
      }
      return { success: true };
    }

    case "game.submitBlankGuess": {
      if (privateState) {
        set({
          privateState: {
            ...privateState,
            blankGuessUsed: true,
          },
        });
      }
      return { success: true };
    }

    case "game.submitWords": {
      store.jumpTestRoomPhase("description");
      return { success: true };
    }

    case "game.assignQuestioner": {
      store.jumpTestRoomPhase("wordSubmission");
      return { success: true };
    }

    case "player.setReady": {
      if (privateState) {
        const ready = payload.ready as boolean;
        const players = snapshot.players.map((p) =>
          p.id === privateState.playerId ? { ...p, isReady: ready } : p
        );
        set({
          snapshot: { ...snapshot, players },
        });
      }
      return { success: true };
    }

    case "chat.send": {
      const text = (payload.text as string) || "";
      if (text && privateState) {
        const me = snapshot.players.find((p) => p.id === privateState.playerId);
        const chatMsg: ChatMessage = {
          id: `chat_${Date.now()}`,
          playerId: privateState.playerId,
          playerName: me?.name || "测试玩家",
          text,
          createdAt: Date.now(),
          system: false,
        };
        set({
          snapshot: {
            ...snapshot,
            chat: [...snapshot.chat, chatMsg],
          },
        });
      }
      return { success: true };
    }

    case "room.updateSettings": {
      if (payload.settings) {
        set({
          snapshot: {
            ...snapshot,
            settings: payload.settings as any,
          },
        });
      }
      return { success: true };
    }

    case "test.jumpToPhase": {
      const phase = (payload.phase as GamePhase) || "waiting";
      store.jumpTestRoomPhase(phase);
      return { success: true };
    }

    case "test.setMyRole": {
      const role = (payload.role as PlayerRole) || "civilian";
      store.setTestRoomPerspective("player", role);
      return { success: true };
    }

    default:
      return { success: true };
  }
}

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
      case "room.playerChanged": {
        const p = evt.payload as Partial<PublicPlayerView> & { id: string };
        currentStore.patchPlayer(p);
        break;
      }
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
