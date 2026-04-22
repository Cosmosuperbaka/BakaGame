import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
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

// ==================== 状态定义 ====================

interface GameState {
  connected: boolean;
  // 大厅
  rooms: RoomSummaryItem[];
  // 当前房间
  roomId: string | null;
  sessionToken: string | null;
  snapshot: RoomSnapshot | null;
  privateState: PrivateState | null;
  sessionConflictRoomId: string | null;
  // toast 消息队列
  toasts: Array<{ id: number; text: string; type: "info" | "error" | "success" }>;
}

const initialState: GameState = {
  connected: false,
  rooms: [],
  roomId: null,
  sessionToken: null,
  snapshot: null,
  privateState: null,
  sessionConflictRoomId: null,
  toasts: [],
};

// ==================== Action 定义 ====================

type Action =
  | { type: "SET_CONNECTED"; connected: boolean }
  | { type: "SET_ROOMS"; rooms: RoomSummaryItem[] }
  | { type: "JOIN_ROOM"; roomId: string; sessionToken: string }
  | { type: "LEAVE_ROOM" }
  | { type: "HANDLE_SESSION_CONFLICT"; roomId: string }
  | { type: "SET_SNAPSHOT"; snapshot: RoomSnapshot }
  | { type: "SET_PRIVATE_STATE"; privateState: PrivateState }
  | { type: "PATCH_PLAYER"; player: Partial<PublicPlayerView> & { id: string } }
  | { type: "APPEND_CHAT"; message: ChatMessage }
  | { type: "SET_SUMMARY"; summary: RoundSummary }
  | { type: "ADD_TOAST"; id: number; text: string; toastType: "info" | "error" | "success" }
  | { type: "REMOVE_TOAST"; id: number };

let toastCounter = 0;

function reducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case "SET_CONNECTED":
      return { ...state, connected: action.connected };
    case "SET_ROOMS":
      return { ...state, rooms: action.rooms };
    case "JOIN_ROOM":
      return {
        ...state,
        roomId: action.roomId,
        sessionToken: action.sessionToken,
        sessionConflictRoomId: null,
      };
    case "LEAVE_ROOM":
      return {
        ...state,
        roomId: null,
        sessionToken: null,
        snapshot: null,
        privateState: null,
        sessionConflictRoomId: null,
      };
    case "HANDLE_SESSION_CONFLICT":
      return {
        ...state,
        roomId: null,
        sessionToken: null,
        snapshot: null,
        privateState: null,
        sessionConflictRoomId: action.roomId,
      };
    case "SET_SNAPSHOT":
      return { ...state, snapshot: action.snapshot };
    case "SET_PRIVATE_STATE":
      return { ...state, privateState: action.privateState };
    case "PATCH_PLAYER": {
      if (!state.snapshot) return state;
      const players = state.snapshot.players.map((p) =>
        p.id === action.player.id ? { ...p, ...action.player } : p
      );
      return { ...state, snapshot: { ...state.snapshot, players } };
    }
    case "APPEND_CHAT": {
      if (!state.snapshot) return state;
      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          chat: [...state.snapshot.chat, action.message],
        },
      };
    }
    case "SET_SUMMARY": {
      if (!state.snapshot) return state;
      return {
        ...state,
        snapshot: { ...state.snapshot, summary: action.summary },
      };
    }
    case "ADD_TOAST":
      return {
        ...state,
        toasts: [
          ...state.toasts,
          { id: action.id, text: action.text, type: action.toastType },
        ],
      };
    case "REMOVE_TOAST":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    default:
      return state;
  }
}

// ==================== Context ====================

interface GameContextValue {
  state: GameState;
  dispatch: React.Dispatch<Action>;
  // 封装的业务方法
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
  addToast: (text: string, type?: "info" | "error" | "success") => void;
}

const GameContext = createContext<GameContextValue | null>(null);

export function GameProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // toast 工具
  const addToast = useCallback(
    (text: string, type: "info" | "error" | "success" = "info") => {
      const id = ++toastCounter;
      dispatch({ type: "ADD_TOAST", id, text, toastType: type });
      setTimeout(() => dispatch({ type: "REMOVE_TOAST", id }), 3000);
    },
    []
  );

  // 处理服务端事件
  useEffect(() => {
    const unsubMsg = ws.onMessage((msg: ServerMessage) => {
      if (msg.type !== "event") return;
      const evt = msg as EventPacket;

      switch (evt.event) {
        case "lobby.rooms":
          dispatch({ type: "SET_ROOMS", rooms: evt.payload as RoomSummaryItem[] });
          break;
        case "room.snapshot":
          dispatch({ type: "SET_SNAPSHOT", snapshot: evt.payload as RoomSnapshot });
          break;
        case "game.privateState":
          dispatch({ type: "SET_PRIVATE_STATE", privateState: evt.payload as PrivateState });
          break;
        case "room.playerChanged": {
          const p = evt.payload as Partial<PublicPlayerView> & { id: string };
          dispatch({ type: "PATCH_PLAYER", player: p });
          break;
        }
        case "chat.message":
          dispatch({ type: "APPEND_CHAT", message: evt.payload as ChatMessage });
          break;
        case "game.phaseChanged":
          // snapshot 会被后续 room.snapshot 覆盖，此处用于 toast
          addToast(phaseLabel((evt.payload as { phase: string }).phase));
          break;
        case "game.voteResult":
          addToast("投票结果已公布");
          break;
        case "game.roundSummary":
          dispatch({ type: "SET_SUMMARY", summary: evt.payload as RoundSummary });
          break;
        case "game.disconnectDecisionRequested":
          addToast("有玩家掉线，等待出题人处理", "info");
          break;
        case "room.settingsChanged":
          // 下一次 snapshot 会更新
          break;
        case "room.expiring":
          addToast("房间即将因超时关闭", "error");
          break;
        case "room.closed":
          dispatch({ type: "LEAVE_ROOM" });
          addToast("房间已关闭", "error");
          break;
        case "session.replaced":
          {
            const payload = evt.payload as { roomId?: string };
            const roomId = payload.roomId;
            const currentRoomId = stateRef.current.roomId;

            if (roomId && currentRoomId === roomId && isTestRoomId(roomId)) {
              clearSessionToken(roomId);
              dispatch({ type: "HANDLE_SESSION_CONFLICT", roomId });
              addToast("当前标签页已切换为独立测试会话，正在重新加入", "info");
            } else {
              addToast("您的连接已被新连接替代", "error");
            }
          }
          break;
        case "server.shutdown":
          addToast("服务器即将关闭", "error");
          break;
      }
    });

    const unsubStatus = ws.onStatus((connected) => {
      dispatch({ type: "SET_CONNECTED", connected });
      // 重连后自动重新订阅大厅和重连房间
      if (connected) {
        ws.send("lobby.subscribeRooms").catch(() => {});
        const s = stateRef.current;
        if (s.roomId && s.sessionToken) {
          ws.send("room.reconnect", {
            roomId: s.roomId,
            sessionToken: s.sessionToken,
          }).catch(() => {});
        }
      }
    });

    ws.connect();

    return () => {
      unsubMsg();
      unsubStatus();
    };
  }, [addToast]);

  // 业务方法
  const subscribeLobby = useCallback(async () => {
    await ws.send("lobby.subscribeRooms");
  }, []);

  const createRoom = useCallback(
    async (params: {
      roomId: string;
      name: string;
      visibility: "public" | "private";
      password?: string;
      allowSpectators: boolean;
      userName: string;
    }) => {
      const res = await ws.send<{ sessionToken: string }>("room.create", params);
      saveSessionToken(params.roomId, res.sessionToken);
      dispatch({
        type: "JOIN_ROOM",
        roomId: params.roomId,
        sessionToken: res.sessionToken,
      });
    },
    []
  );

  const joinRoom = useCallback(
    async (roomId: string, userName: string, password?: string) => {
      const payload: Record<string, unknown> = { userName };
      if (password) payload.password = password;
      const res = await ws.send<{ sessionToken: string }>("room.join", payload, { roomId });
      saveSessionToken(roomId, res.sessionToken);
      dispatch({ type: "JOIN_ROOM", roomId, sessionToken: res.sessionToken });
    },
    []
  );

  const reconnectRoom = useCallback(async (roomId: string): Promise<boolean> => {
    const token = getSessionToken(roomId);
    if (!token) return false;
    try {
      await ws.send("room.reconnect", { roomId, sessionToken: token });
      dispatch({ type: "JOIN_ROOM", roomId, sessionToken: token });
      return true;
    } catch {
      clearSessionToken(roomId);
      return false;
    }
  }, []);

  const leaveRoom = useCallback(async () => {
    const s = stateRef.current;
    try {
      await ws.send("room.leave", {}, {
        roomId: s.roomId ?? undefined,
        sessionToken: s.sessionToken ?? undefined,
      });
    } catch {
      // 忽略
    }
    if (s.roomId) clearSessionToken(s.roomId);
    dispatch({ type: "LEAVE_ROOM" });
  }, []);

  const sendCommand = useCallback(
    async (type: string, payload: Record<string, unknown> = {}) => {
      const s = stateRef.current;
      return ws.send(type, payload, {
        roomId: s.roomId ?? undefined,
        sessionToken: s.sessionToken ?? undefined,
      });
    },
    []
  );

  return (
    <GameContext.Provider
      value={{
        state,
        dispatch,
        subscribeLobby,
        createRoom,
        joinRoom,
        reconnectRoom,
        leaveRoom,
        sendCommand,
        addToast,
      }}
    >
      {children}
    </GameContext.Provider>
  );
}

export function useGame() {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error("useGame 必须在 GameProvider 内使用");
  return ctx;
}

// 阶段名称映射
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
