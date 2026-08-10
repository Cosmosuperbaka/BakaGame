import { create } from "zustand";
import type {
  ChatMessage,
  EventPacket,
  ServerMessage,
  SongGuessrPrivateState,
  SongGuessrRoomSnapshot,
  SongGuessrRoomSummary,
  SongSearchResult,
} from "@/types";
import {
  clearSongGuessrSessionToken,
  getSongGuessrSessionToken,
  saveSongGuessrSessionToken,
} from "@/lib/cookie";
import { songGuessrWs } from "@/lib/songguessrWs";

interface SongGuessrStore {
  connected: boolean;
  rooms: SongGuessrRoomSummary[];
  roomId: string | null;
  sessionToken: string | null;
  snapshot: SongGuessrRoomSnapshot | null;
  privateState: SongGuessrPrivateState | null;
  roomClosedAt: number | null;
  notice: { text: string; type: "info" | "error" | "success" } | null;
  setNotice: (text: string, type?: "info" | "error" | "success") => void;
  clearNotice: () => void;
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
  searchMusic: (keyword: string) => Promise<SongSearchResult[]>;
  sendCommand: <T extends Record<string, unknown> = Record<string, unknown>>(
    type: string,
    payload?: Record<string, unknown>,
  ) => Promise<T>;
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;

export const useSongGuessrStore = create<SongGuessrStore>((set, get) => ({
  connected: false,
  rooms: [],
  roomId: null,
  sessionToken: null,
  snapshot: null,
  privateState: null,
  roomClosedAt: null,
  notice: null,

  setNotice: (text, type = "info") => {
    if (noticeTimer) clearTimeout(noticeTimer);
    set({ notice: { text, type } });
    noticeTimer = setTimeout(() => set({ notice: null }), 3_000);
  },
  clearNotice: () => set({ notice: null }),

  subscribeLobby: async () => {
    await songGuessrWs.send("song.lobby.subscribeRooms");
  },

  createRoom: async (params) => {
    const result = await songGuessrWs.send<{ roomId?: string; sessionToken: string }>(
      "song.room.create",
      params,
    );
    const roomId = result.roomId ?? params.roomId;
    saveSongGuessrSessionToken(roomId, result.sessionToken);
    set({ roomId, sessionToken: result.sessionToken, roomClosedAt: null });
  },

  joinRoom: async (roomId, userName, password) => {
    const result = await songGuessrWs.send<{ roomId?: string; sessionToken: string }>(
      "song.room.join",
      password ? { userName, password } : { userName },
      { roomId },
    );
    const canonicalRoomId = result.roomId ?? roomId;
    saveSongGuessrSessionToken(canonicalRoomId, result.sessionToken);
    set({ roomId: canonicalRoomId, sessionToken: result.sessionToken, roomClosedAt: null });
  },

  reconnectRoom: async (roomId) => {
    const sessionToken = getSongGuessrSessionToken(roomId);
    if (!sessionToken) return false;
    try {
      await songGuessrWs.send("song.room.reconnect", { roomId, sessionToken });
      set({ roomId, sessionToken, roomClosedAt: null });
      return true;
    } catch {
      clearSongGuessrSessionToken(roomId);
      return false;
    }
  },

  leaveRoom: async () => {
    const { roomId, sessionToken } = get();
    try {
      await songGuessrWs.send("song.room.leave", {}, {
        roomId: roomId ?? undefined,
        sessionToken: sessionToken ?? undefined,
      });
    } catch {
      // 断线离场仍需清理本地会话。
    }
    if (roomId) clearSongGuessrSessionToken(roomId);
    set({ roomId: null, sessionToken: null, snapshot: null, privateState: null, roomClosedAt: null });
  },

  searchMusic: async (keyword) => {
    const result = await get().sendCommand<{ results: SongSearchResult[] }>(
      "song.music.search",
      { keyword },
    );
    return result.results;
  },

  sendCommand: async (type, payload = {}) => {
    const { roomId, sessionToken } = get();
    return songGuessrWs.send(type, payload, {
      roomId: roomId ?? undefined,
      sessionToken: sessionToken ?? undefined,
    });
  },
}));

export function initSongGuessrSocket() {
  const unsubscribeMessage = songGuessrWs.onMessage((message: ServerMessage) => {
    if (message.type !== "event") return;
    const event = message as EventPacket;
    const store = useSongGuessrStore.getState();

    switch (event.event) {
      case "song.lobby.rooms":
        useSongGuessrStore.setState({ rooms: event.payload as SongGuessrRoomSummary[] });
        break;
      case "song.room.snapshot":
        useSongGuessrStore.setState({ snapshot: event.payload as SongGuessrRoomSnapshot });
        break;
      case "song.game.privateState":
        {
          const privateState = event.payload as SongGuessrPrivateState;
          const roomId = store.snapshot?.roomId ?? store.roomId;
          if (roomId) saveSongGuessrSessionToken(roomId, privateState.sessionToken);
          useSongGuessrStore.setState({
            privateState,
            roomId: roomId ?? store.roomId,
            sessionToken: roomId ? privateState.sessionToken : store.sessionToken,
            roomClosedAt: null,
          });
        }
        break;
      case "song.chat.message":
        {
          const message = event.payload as ChatMessage;
          const snapshot = useSongGuessrStore.getState().snapshot;
          if (snapshot) {
            useSongGuessrStore.setState({
              snapshot: { ...snapshot, chat: [...snapshot.chat, message].slice(-100) },
            });
          }
        }
        break;
      case "song.room.kicked":
        if (store.roomId) clearSongGuessrSessionToken(store.roomId);
        useSongGuessrStore.setState({ roomId: null, sessionToken: null, snapshot: null, privateState: null, roomClosedAt: Date.now() });
        store.setNotice("你已被移出房间", "error");
        break;
      case "song.room.closed":
        if (store.roomId) clearSongGuessrSessionToken(store.roomId);
        useSongGuessrStore.setState({ roomId: null, sessionToken: null, snapshot: null, privateState: null, roomClosedAt: Date.now() });
        store.setNotice("房间已关闭", "error");
        break;
      case "session.replaced":
        if (store.roomId) clearSongGuessrSessionToken(store.roomId);
        useSongGuessrStore.setState({ roomId: null, sessionToken: null, snapshot: null, privateState: null, roomClosedAt: Date.now() });
        store.setNotice("当前席位已在另一个标签页接管", "error");
        break;
    }
  });

  const unsubscribeStatus = songGuessrWs.onStatus((connected) => {
    useSongGuessrStore.setState({ connected });
    if (!connected) return;
    const store = useSongGuessrStore.getState();
    void songGuessrWs.send("song.lobby.subscribeRooms").catch(() => {});
    if (store.roomId && store.sessionToken) {
      void songGuessrWs.send("song.room.reconnect", {
        roomId: store.roomId,
        sessionToken: store.sessionToken,
      }).catch(() => {});
    }
  });

  songGuessrWs.connect();
  return () => {
    unsubscribeMessage();
    unsubscribeStatus();
  };
}
