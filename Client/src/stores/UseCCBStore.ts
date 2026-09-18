import { create } from "zustand";
import type { CCBCommand, CCBPayload, CCBPrivateState, CCBRoomEnterResult, CCBRoomSnapshot, CCBRoomSummary, CCBSource, ServerMessage } from "@bakagame/shared";
import { ccbWs, sendCCB, type CCBResponse } from "@/lib/CCBWs";
import { readCCBSession, removeCCBSession, writeCCBSession } from "@/lib/CCBSession";
import { consumeStateSync } from "@/lib/StateSync";
import { isProtocolError } from "@/lib/WebsocketClient";

export interface CCBStore {
  connected: boolean; lobbyReady: boolean; originalAvailable: boolean; originalServerKey: string;
  rooms: CCBRoomSummary[]; source: CCBSource | null; roomId: string | null; sessionToken: string | null;
  snapshot: CCBRoomSnapshot | null; privateState: CCBPrivateState | null; roomClosedAt: number | null;
  notice: { text: string; type: "info" | "error" | "success" } | null;
  setNotice: (text: string, type?: "info" | "error" | "success") => void;
  subscribeLobby: () => Promise<void>;
  createRoom: (payload: CCBPayload<"ccb.room.create">) => Promise<void>;
  joinRoom: (source: CCBSource, roomId: string, userName: string, password?: string) => Promise<void>;
  reconnectRoom: (source: CCBSource, roomId: string) => Promise<boolean>;
  leaveRoom: () => Promise<void>;
  resetRoom: (closed?: boolean) => void;
  sendCommand: <T extends CCBCommand>(command: T, payload: CCBPayload<T>) => Promise<CCBResponse<T>>;
}

let snapshotRevision: number | undefined;
let privateRevision: number | undefined;
let rawSnapshot: CCBRoomSnapshot | null = null;
let rawPrivate: CCBPrivateState | null = null;
let syncPending = false;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const permanentErrors = new Set(["ROOM_NOT_FOUND", "SESSION_NOT_FOUND", "SESSION_INVALID", "PLAYER_KICKED", "CCB_SESSION_INVALID"]);

export function resetCCBStateSync() {
  snapshotRevision = undefined; privateRevision = undefined;
  rawSnapshot = null; rawPrivate = null;
}

const getServerKey = (source: CCBSource) => source === "native" ? "native" : useCCBStore.getState().originalServerKey;
export const ccbErrorMessage = (error: unknown) => error instanceof Error || isProtocolError(error) ? error.message : "操作失败，请重试";

export const useCCBStore = create<CCBStore>((set, get) => {
  const enter = (result: CCBRoomEnterResult) => {
    const sameRoom = rawSnapshot?.roomId === result.roomId && rawSnapshot.source === result.source;
    if (!sameRoom) { resetCCBStateSync(); rawSnapshot = result.snapshot; rawPrivate = result.privateState; }
    writeCCBSession(result.source, getServerKey(result.source), result.roomId, result.sessionToken);
    set({ source: result.source, roomId: result.roomId, sessionToken: result.sessionToken,
      snapshot: rawSnapshot, privateState: rawPrivate ?? result.privateState, roomClosedAt: null });
  };
  return {
    connected: false, lobbyReady: false, originalAvailable: false, originalServerKey: "",
    rooms: [], source: null, roomId: null, sessionToken: null, snapshot: null, privateState: null,
    roomClosedAt: null, notice: null,
    setNotice: (text, type = "error") => {
      clearTimeout(noticeTimer);
      set({ notice: { text, type } });
      noticeTimer = setTimeout(() => set({ notice: null }), 5000);
    },
    subscribeLobby: async () => {
      const result = await sendCCB("ccb.lobby.subscribeRooms", {});
      set({ lobbyReady: true, originalAvailable: result.originalAvailable, originalServerKey: result.sourceKey });
    },
    createRoom: async (payload) => {
      resetCCBStateSync();
      enter(await sendCCB("ccb.room.create", payload, { timeout: 0 }));
    },
    joinRoom: async (source, roomId, userName, password) => {
      resetCCBStateSync();
      enter(await sendCCB("ccb.room.join", { source, userName, ...(password ? { password } : {}) }, { roomId, timeout: 0 }));
    },
    reconnectRoom: async (source, roomId) => {
      const token = readCCBSession(source, getServerKey(source), roomId);
      if (!token) return false;
      try {
        resetCCBStateSync();
        enter(await sendCCB("ccb.room.reconnect", { source, roomId, sessionToken: token }, { timeout: 0 }));
        return true;
      } catch (error) {
        if (!isProtocolError(error) || !permanentErrors.has(error.code)) throw error;
        removeCCBSession(source, getServerKey(source), roomId);
        get().resetRoom();
        get().setNotice(ccbErrorMessage(error));
        return false;
      }
    },
    leaveRoom: async () => {
      const { source, roomId } = get();
      try { if (roomId) await get().sendCommand("ccb.room.leave", {}); }
      finally {
        if (source && roomId) removeCCBSession(source, getServerKey(source), roomId);
        get().resetRoom();
      }
    },
    resetRoom: (closed = false) => {
      resetCCBStateSync();
      set({ source: null, roomId: null, sessionToken: null, snapshot: null, privateState: null, roomClosedAt: closed ? Date.now() : null });
    },
    sendCommand: (command, payload) => {
      const { roomId, sessionToken } = get();
      return sendCCB(command, payload, { roomId: roomId ?? undefined, sessionToken: sessionToken ?? undefined,
        timeout: command === "ccb.game.start" || command === "ccb.directory.import" ? 0 : undefined });
    },
  };
});

function requestSync() {
  if (syncPending) return;
  syncPending = true;
  void useCCBStore.getState().sendCommand("ccb.room.requestSync", {})
    .catch((error: unknown) => useCCBStore.getState().setNotice(ccbErrorMessage(error)))
    .finally(() => { syncPending = false; });
}

export function handleCCBMessage(message: ServerMessage) {
  if (message.type !== "event") return;
  const store = useCCBStore.getState();
  if (message.event === "ccb.lobby.rooms") {
    useCCBStore.setState({ rooms: message.payload as CCBRoomSummary[] });
  } else if (message.event === "ccb.room.snapshot") {
    const result = consumeStateSync<CCBRoomSnapshot>(rawSnapshot, snapshotRevision, message.payload);
    if (result.needsFullSync || !result.state) { requestSync(); return; }
    rawSnapshot = result.state; snapshotRevision = result.revision;
    useCCBStore.setState({ snapshot: rawSnapshot });
  } else if (message.event === "ccb.game.privateState") {
    const result = consumeStateSync<CCBPrivateState>(rawPrivate, privateRevision, message.payload);
    if (result.needsFullSync || !result.state) { requestSync(); return; }
    rawPrivate = result.state; privateRevision = result.revision;
    useCCBStore.setState({ privateState: rawPrivate });
  } else if (["ccb.room.closed", "ccb.player.kicked", "session.replaced", "ccb.session.replaced", "server.shutdown"].includes(message.event)) {
    if (store.source && store.roomId) removeCCBSession(store.source, getServerKey(store.source), store.roomId);
    store.resetRoom(true);
    const payload = message.payload as { reason?: string; message?: string };
    store.setNotice(payload.message ?? payload.reason ?? "房间会话已结束，请重新加入");
  }
}

let initialized = false;
export function initCCBWs() {
  if (initialized) return () => {};
  initialized = true;
  const unsubscribeMessage = ccbWs.onMessage(handleCCBMessage);
  const unsubscribeStatus = ccbWs.onStatus((connected) => {
    useCCBStore.setState({ connected });
    if (!connected) return;
    const store = useCCBStore.getState();
    void store.subscribeLobby().then(async () => {
      if (store.source && store.roomId && store.sessionToken) {
        const restored = await store.reconnectRoom(store.source, store.roomId);
        if (!restored) store.resetRoom(true);
      }
    }).catch((error: unknown) => store.setNotice(ccbErrorMessage(error)));
  });
  ccbWs.connect();
  return () => { initialized = false; unsubscribeMessage(); unsubscribeStatus(); };
}
