import { create } from "zustand";
import type {
  EventPacket,
  ServerMessage,
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
  SonGuessrRoomSummary,
  SongSearchResult,
} from "@/types";
import {
  clearSonGuessrSessionToken,
  getSonGuessrSessionToken,
  saveSonGuessrSessionToken,
} from "@/lib/Storage";
import { sonGuessrWs } from "@/lib/SonGuessrWs";
import { consumeStateSync } from "@/lib/StateSync";

export interface SonGuessrStore {
  connected: boolean;
  rooms: SonGuessrRoomSummary[];
  roomId: string | null;
  sessionToken: string | null;
  snapshot: SonGuessrRoomSnapshot | null;
  privateState: SonGuessrPrivateState | null;
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

export type SongGuessrStore = SonGuessrStore;

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let snapshotRevision: number | undefined;
let privateStateRevision: number | undefined;
let syncRequestPending = false;
let rawSnapshot: SonGuessrRoomSnapshot | null = null;
let rawPrivateState: SonGuessrPrivateState | null = null;

export const resetSonGuessrStateSync = () => {
  snapshotRevision = undefined;
  privateStateRevision = undefined;
  syncRequestPending = false;
  rawSnapshot = null;
  rawPrivateState = null;
};

const mergeChat = (
  existing: SonGuessrRoomSnapshot["chat"] = [],
  incoming: SonGuessrRoomSnapshot["chat"] = [],
): SonGuessrRoomSnapshot["chat"] => {
  const map = new Map<string, SonGuessrRoomSnapshot["chat"][number]>();
  for (const msg of existing) {
    map.set(msg.id, msg);
  }
  for (const msg of incoming) {
    map.set(msg.id, msg);
  }
  return Array.from(map.values()).sort((a, b) => a.createdAt - b.createdAt);
};


const isPermanentRoomError = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code;
  return code === "ROOM_NOT_FOUND" || code === "SESSION_NOT_FOUND" ||
    code === "SESSION_INVALID" || code === "PLAYER_KICKED";
};

const requestFullSync = () => {
  if (syncRequestPending) return;
  syncRequestPending = true;
  void useSonGuessrStore.getState().sendCommand("song.room.requestSync")
    .catch(() => {})
    .finally(() => {
      syncRequestPending = false;
    });
};

export const useSonGuessrStore = create<SonGuessrStore>((set, get) => ({
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
    noticeTimer = setTimeout(() => {
      set({ notice: null });
      noticeTimer = undefined;
    }, 3000);
  },

  clearNotice: () => {
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = undefined;
    set({ notice: null });
  },

  subscribeLobby: async () => {
    await sonGuessrWs.send("song.lobby.subscribeRooms");
  },

  createRoom: async (params) => {
    const res = await sonGuessrWs.send<{
      roomId?: string;
      sessionToken: string;
      snapshot?: SonGuessrRoomSnapshot;
      privateState?: SonGuessrPrivateState;
    }>("song.room.create", params);

    const roomId = res.roomId ?? params.roomId;
    saveSonGuessrSessionToken(roomId, res.sessionToken);
    resetSonGuessrStateSync();
    rawSnapshot = res.snapshot ?? null;
    rawPrivateState = res.privateState ?? null;
    set({
      roomId,
      sessionToken: res.sessionToken,
      snapshot: res.snapshot ?? null,
      privateState: res.privateState ?? null,
      roomClosedAt: null,
    });
  },

  joinRoom: async (roomId, userName, password) => {
    const res = await sonGuessrWs.send<{
      roomId?: string;
      sessionToken: string;
      snapshot?: SonGuessrRoomSnapshot;
      privateState?: SonGuessrPrivateState;
    }>("song.room.join", { userName, password }, { roomId });

    const canonicalRoomId = res.roomId ?? roomId;
    saveSonGuessrSessionToken(canonicalRoomId, res.sessionToken);
    resetSonGuessrStateSync();
    rawSnapshot = res.snapshot ?? null;
    rawPrivateState = res.privateState ?? null;
    set({
      roomId: canonicalRoomId,
      sessionToken: res.sessionToken,
      snapshot: res.snapshot ?? null,
      privateState: res.privateState ?? null,
      roomClosedAt: null,
    });
  },

  reconnectRoom: async (roomId) => {
    const token = getSonGuessrSessionToken(roomId);
    if (!token) return false;

    try {
      const res = await sonGuessrWs.send<{
        roomId?: string;
        sessionToken: string;
        snapshot?: SonGuessrRoomSnapshot;
        privateState?: SonGuessrPrivateState;
      }>("song.room.reconnect", { roomId, sessionToken: token });

      const canonicalRoomId = res.roomId ?? roomId;
      saveSonGuessrSessionToken(canonicalRoomId, res.sessionToken);
      resetSonGuessrStateSync();
      rawSnapshot = res.snapshot ?? null;
      rawPrivateState = res.privateState ?? null;
      set({
        roomId: canonicalRoomId,
        sessionToken: res.sessionToken,
        snapshot: res.snapshot ?? null,
        privateState: res.privateState ?? null,
        roomClosedAt: null,
      });
      return true;
    } catch (error) {
      if (!isPermanentRoomError(error)) {
        set({ roomId, sessionToken: token, roomClosedAt: null });
        return true;
      }
      clearSonGuessrSessionToken(roomId);
      resetSonGuessrStateSync();
      set({
        roomId: null,
        sessionToken: null,
        snapshot: null,
        privateState: null,
        roomClosedAt: Date.now(),
      });
      return false;
    }
  },

  leaveRoom: async () => {
    const { roomId, sessionToken } = get();
    if (!roomId) return;
    try {
      await sonGuessrWs.send("song.room.leave", {}, { roomId, sessionToken: sessionToken ?? undefined });
    } catch {
      // 忽略离开房间失败
    } finally {
      clearSonGuessrSessionToken(roomId);
      resetSonGuessrStateSync();
      set({
        roomId: null,
        sessionToken: null,
        snapshot: null,
        privateState: null,
        roomClosedAt: null,
        notice: null,
      });
    }
  },

  searchMusic: async (keyword) => {
    const result = await sonGuessrWs.send<{ results?: SongSearchResult[]; songs?: SongSearchResult[] }>(
      "song.music.search",
      { keyword },
      {
        roomId: get().roomId ?? undefined,
        sessionToken: get().sessionToken ?? undefined,
      },
    );
    return result.results ?? result.songs ?? [];
  },

  sendCommand: async (type, payload = {}) => {
    const { roomId, sessionToken } = get();
    return sonGuessrWs.send(type, payload, {
      roomId: roomId ?? undefined,
      sessionToken: sessionToken ?? undefined,
    });
  },
}));

export const useSongGuessrStore = useSonGuessrStore;

export function initSonGuessrWs() {
  const unsubMsg = sonGuessrWs.onMessage((msg: ServerMessage) => {
    if (msg.type !== "event") return;
    const evt = msg as EventPacket;
    const store = useSonGuessrStore.getState();

    switch (evt.event) {
      case "song.lobby.rooms":
        useSonGuessrStore.setState({
          rooms: evt.payload as SonGuessrRoomSummary[],
        });
        break;
      case "song.room.snapshot":
        {
          const result = consumeStateSync(
            rawSnapshot,
            snapshotRevision,
            evt.payload,
          );
          if (result.needsFullSync || !result.state) {
            requestFullSync();
            break;
          }
          snapshotRevision = result.revision;
          rawSnapshot = result.state as SonGuessrRoomSnapshot;
          const currentSnapshot = useSonGuessrStore.getState().snapshot;
          const nextSnapshot = currentSnapshot && currentSnapshot.roomId === rawSnapshot.roomId
            ? {
                ...rawSnapshot,
                chat: mergeChat(currentSnapshot.chat, rawSnapshot.chat),
              }
            : rawSnapshot;

          const currentPrivate = useSonGuessrStore.getState().privateState;
          const tokenToSave = currentPrivate?.sessionToken ?? useSonGuessrStore.getState().sessionToken;
          if (tokenToSave && nextSnapshot.roomId) {
            saveSonGuessrSessionToken(nextSnapshot.roomId, tokenToSave);
          }
          useSonGuessrStore.setState({
            snapshot: nextSnapshot,
            ...(tokenToSave ? { roomId: nextSnapshot.roomId, sessionToken: tokenToSave } : {}),
          });
        }
        break;
      case "song.game.privateState":
        {
          const result = consumeStateSync(
            rawPrivateState,
            privateStateRevision,
            evt.payload,
          );
          if (result.needsFullSync || !result.state) {
            requestFullSync();
            break;
          }
          privateStateRevision = result.revision;
          rawPrivateState = result.state as SonGuessrPrivateState;
          const nextPrivateState = rawPrivateState;
          const currentSnapshot = useSonGuessrStore.getState().snapshot;
          if (nextPrivateState.sessionToken && currentSnapshot?.roomId) {
            saveSonGuessrSessionToken(currentSnapshot.roomId, nextPrivateState.sessionToken);
            useSonGuessrStore.setState({
              roomId: currentSnapshot.roomId,
              sessionToken: nextPrivateState.sessionToken,
              privateState: nextPrivateState,
            });
          } else {
            useSonGuessrStore.setState({ privateState: nextPrivateState });
          }
        }
        break;
      case "song.room.expiring":
        store.setNotice("房间即将因超时关闭", "error");
        break;
      case "song.room.closed": {
        const payload = evt.payload as { roomId?: string };
        const closedRoomId = payload.roomId ?? useSonGuessrStore.getState().roomId;
        if (closedRoomId) clearSonGuessrSessionToken(closedRoomId);
        resetSonGuessrStateSync();
        useSonGuessrStore.setState({
          roomId: null,
          sessionToken: null,
          snapshot: null,
          privateState: null,
          roomClosedAt: Date.now(),
        });
        useSonGuessrStore.getState().setNotice("房间已关闭", "error");
        break;
      }
      case "song.room.kicked": {
        const payload = evt.payload as { roomId?: string };
        const closedRoomId = payload.roomId ?? useSonGuessrStore.getState().roomId;
        if (closedRoomId) clearSonGuessrSessionToken(closedRoomId);
        resetSonGuessrStateSync();
        useSonGuessrStore.setState({
          roomId: null,
          sessionToken: null,
          snapshot: null,
          privateState: null,
          roomClosedAt: Date.now(),
        });
        useSonGuessrStore.getState().setNotice("你已被移出房间", "error");
        break;
      }
      case "session.replaced":
      case "song.session.replaced": {
        const payload = evt.payload as { roomId?: string };
        const closedRoomId = payload.roomId ?? useSonGuessrStore.getState().roomId;
        if (closedRoomId) clearSonGuessrSessionToken(closedRoomId);
        useSonGuessrStore.setState({
          roomId: null,
          sessionToken: null,
          snapshot: null,
          privateState: null,
          roomClosedAt: Date.now(),
        });
        useSonGuessrStore.getState().setNotice("当前席位已在另一个标签页接管", "error");
        break;
      }
      case "server.shutdown":
        store.setNotice("服务器即将关闭", "error");
        break;
    }
  });

  const unsubStatus = sonGuessrWs.onStatus((connected) => {
    useSonGuessrStore.setState({ connected });
    const store = useSonGuessrStore.getState();

    if (connected) {
      snapshotRevision = undefined;
      privateStateRevision = undefined;
      sonGuessrWs.send("song.lobby.subscribeRooms").catch(() => {});
      if (store.roomId && store.sessionToken) {
        sonGuessrWs.send("song.room.reconnect", {
          roomId: store.roomId,
          sessionToken: store.sessionToken,
        }).catch((error) => {
          if (!isPermanentRoomError(error)) return;
          const roomId = useSonGuessrStore.getState().roomId;
          if (!roomId) return;
          clearSonGuessrSessionToken(roomId);
          useSonGuessrStore.setState({
            roomId: null,
            sessionToken: null,
            snapshot: null,
            privateState: null,
            roomClosedAt: Date.now(),
          });
        });
      }
    }
  });

  sonGuessrWs.connect();

  return () => {
    unsubMsg();
    unsubStatus();
  };
}

export const initSongGuessrWs = initSonGuessrWs;
export const initSonGuessrSocket = initSonGuessrWs;
export const initSongGuessrSocket = initSonGuessrWs;
