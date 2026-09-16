import { create } from "zustand";
import type {
  CCBGameSettings,
  CCBPrivateState,
  CCBRoomSnapshot,
  CCBRoomSummary,
  EventPacket,
  ServerMessage,
} from "@/types";
import { SERVER_SHUTDOWN_MESSAGE } from "@/types";
import {
  clearCCBSessionToken,
  getCCBSessionToken,
  saveCCBSessionToken,
} from "@/lib/Storage";
import { CCBWs } from "@/lib/CCBWs";
import { consumeStateSync } from "@/lib/StateSync";

export interface CCBStore {
  connected: boolean;
  rooms: CCBRoomSummary[];
  roomId: string | null;
  sessionToken: string | null;
  snapshot: CCBRoomSnapshot | null;
  privateState: CCBPrivateState | null;
  roomClosedAt: number | null;
  notice: { text: string; type: "info" | "error" | "success" } | null;
  setNotice: (text: string, type?: "info" | "error" | "success", durationMs?: number) => void;
  clearNotice: () => void;

  subscribeLobby: () => Promise<void>;
  createRoom: (params: {
    roomId: string;
    name: string;
    visibility: "public" | "private";
    password?: string;
    allowSpectators: boolean;
    userName: string;
    settings?: Partial<CCBGameSettings>;
  }) => Promise<void>;
  joinRoom: (roomId: string, userName: string, password?: string) => Promise<void>;
  reconnectRoom: (roomId: string) => Promise<boolean>;
  leaveRoom: () => Promise<void>;
  updateSettings: (
    patch: Partial<CCBGameSettings> & {
      name?: string;
      visibility?: "public" | "private";
      password?: string;
      allowSpectators?: boolean;
    },
  ) => Promise<void>;
  sendCommand: <T extends Record<string, unknown> = Record<string, unknown>>(
    type: string,
    payload?: Record<string, unknown>,
    options?: { timeout?: number },
  ) => Promise<T>;
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let snapshotRevision: number | undefined;
let privateStateRevision: number | undefined;
let syncRequestPending = false;
let rawSnapshot: CCBRoomSnapshot | null = null;
let rawPrivateState: CCBPrivateState | null = null;

export const resetCCBStateSync = () => {
  snapshotRevision = undefined;
  privateStateRevision = undefined;
  syncRequestPending = false;
  rawSnapshot = null;
  rawPrivateState = null;
};

/**
 * 聊天去重合并。
 *
 * 快照走 RFC 6902 补丁，服务端会裁剪到最近 20 条；客户端在同一房间内按 id 合并，
 * 避免补丁与本地乐观追加同时命中时出现重复气泡或顺序抖动。
 */
const mergeChat = (
  existing: CCBRoomSnapshot["chat"] = [],
  incoming: CCBRoomSnapshot["chat"] = [],
): CCBRoomSnapshot["chat"] => {
  const map = new Map<string, CCBRoomSnapshot["chat"][number]>();
  for (const message of existing) map.set(message.id, message);
  for (const message of incoming) map.set(message.id, message);
  return Array.from(map.values()).sort((left, right) => left.createdAt - right.createdAt);
};

const isPermanentRoomError = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code;
  return (
    code === "ROOM_NOT_FOUND" ||
    code === "SESSION_NOT_FOUND" ||
    code === "SESSION_INVALID" ||
    code === "PLAYER_KICKED"
  );
};

const roomErrorMessage = (error: unknown): string => {
  const code = (error as { code?: string } | null)?.code;
  if (code === "SESSION_NOT_FOUND" || code === "SESSION_INVALID") return "会话已失效，请重新加入";
  if (code === "PLAYER_KICKED") return "你已被移出房间";
  return "房间已解散或不存在";
};

const requestFullSync = () => {
  if (syncRequestPending) return;
  syncRequestPending = true;
  void useCCBStore
    .getState()
    .sendCommand("ccb.room.requestSync")
    .catch(() => {})
    .finally(() => {
      syncRequestPending = false;
    });
};

/**
 * 入房应答。用类型别名而不是 interface：interface 不会获得隐式索引签名，
 * 无法满足 `send<T extends Record<string, unknown>>` 的约束。
 */
type RoomEnterPayload = {
  roomId?: string;
  sessionToken: string;
  snapshot?: CCBRoomSnapshot;
  privateState?: CCBPrivateState;
};

export const useCCBStore = create<CCBStore>((set, get) => {
  const applyRoomEnter = (
    targetRoomId: string,
    sessionToken: string,
    payloadSnapshot?: CCBRoomSnapshot,
    payloadPrivateState?: CCBPrivateState,
  ) => {
    saveCCBSessionToken(targetRoomId, sessionToken);

    if (rawSnapshot && rawSnapshot.roomId !== targetRoomId && payloadSnapshot?.roomId !== targetRoomId) {
      resetCCBStateSync();
    }

    if (payloadSnapshot && (!rawSnapshot || rawSnapshot.roomId !== targetRoomId)) {
      rawSnapshot = payloadSnapshot;
      snapshotRevision = undefined;
    }
    if (payloadPrivateState && (!rawPrivateState || get().roomId !== targetRoomId)) {
      rawPrivateState = payloadPrivateState;
      privateStateRevision = undefined;
    }

    const currentSnapshot = get().snapshot;
    const currentPrivate = get().privateState;
    const nextSnapshot =
      (currentSnapshot?.roomId === targetRoomId ? currentSnapshot : undefined) ??
      payloadSnapshot ??
      null;
    const nextPrivate =
      (get().roomId === targetRoomId ? currentPrivate : undefined) ?? payloadPrivateState ?? null;

    set({
      roomId: targetRoomId,
      sessionToken,
      snapshot: nextSnapshot,
      privateState: nextPrivate,
      roomClosedAt: null,
    });
  };

  return {
    connected: false,
    rooms: [],
    roomId: null,
    sessionToken: null,
    snapshot: null,
    privateState: null,
    roomClosedAt: null,
    notice: null,

    setNotice: (text, type = "info", durationMs = 3000) => {
      if (noticeTimer) clearTimeout(noticeTimer);
      set({ notice: { text, type } });
      noticeTimer = setTimeout(() => {
        set({ notice: null });
        noticeTimer = undefined;
      }, durationMs);
    },

    clearNotice: () => {
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = undefined;
      set({ notice: null });
    },

    subscribeLobby: async () => {
      await CCBWs.send("ccb.lobby.subscribeRooms");
    },

    createRoom: async (params) => {
      const result = await CCBWs.send<RoomEnterPayload>("ccb.room.create", params);
      applyRoomEnter(result.roomId ?? params.roomId, result.sessionToken, result.snapshot, result.privateState);
    },

    joinRoom: async (roomId, userName, password) => {
      const result = await CCBWs.send<RoomEnterPayload>(
        "ccb.room.join",
        { userName, password },
        { roomId },
      );
      applyRoomEnter(result.roomId ?? roomId, result.sessionToken, result.snapshot, result.privateState);
    },

    reconnectRoom: async (roomId) => {
      const token = getCCBSessionToken(roomId);
      if (!token) return false;

      try {
        const result = await CCBWs.send<RoomEnterPayload>("ccb.room.reconnect", {
          roomId,
          sessionToken: token,
        });
        applyRoomEnter(result.roomId ?? roomId, result.sessionToken, result.snapshot, result.privateState);
        return true;
      } catch (error) {
        if (!isPermanentRoomError(error)) {
          // 网络类错误保留房间与令牌，让重连逻辑稍后自愈。
          set({ roomId, sessionToken: token, roomClosedAt: null });
          return true;
        }
        clearCCBSessionToken(roomId);
        resetCCBStateSync();
        set({
          roomId: null,
          sessionToken: null,
          snapshot: null,
          privateState: null,
          roomClosedAt: Date.now(),
        });
        get().setNotice(roomErrorMessage(error), "error");
        return false;
      }
    },

    leaveRoom: async () => {
      const { roomId, sessionToken } = get();
      if (!roomId) return;
      try {
        await CCBWs.send("ccb.room.leave", {}, {
          roomId,
          sessionToken: sessionToken ?? undefined,
        });
      } catch {
        // 离开失败也要清掉本地会话，否则会卡在幽灵房间。
      } finally {
        clearCCBSessionToken(roomId);
        resetCCBStateSync();
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

    updateSettings: async (patch) => {
      await get().sendCommand("ccb.room.updateSettings", patch as Record<string, unknown>);
    },

    sendCommand: async (type, payload = {}, options) => {
      const { roomId, sessionToken } = get();
      return CCBWs.send(type, payload, {
        roomId: roomId ?? undefined,
        sessionToken: sessionToken ?? undefined,
        timeout: options?.timeout,
      });
    },
  };
});

export function initCCBWs() {
  const unsubMessage = CCBWs.onMessage((msg: ServerMessage) => {
    if (msg.type !== "event") return;
    const event = msg as EventPacket;
    const store = useCCBStore.getState();

    switch (event.event) {
      case "ccb.lobby.rooms":
        useCCBStore.setState({ rooms: event.payload as CCBRoomSummary[] });
        break;
      case "ccb.room.snapshot": {
        const result = consumeStateSync(rawSnapshot, snapshotRevision, event.payload);
        if (result.needsFullSync || !result.state) {
          requestFullSync();
          break;
        }
        snapshotRevision = result.revision;
        rawSnapshot = result.state as CCBRoomSnapshot;
        const currentSnapshot = useCCBStore.getState().snapshot;
        const nextSnapshot =
          currentSnapshot && currentSnapshot.roomId === rawSnapshot.roomId
            ? { ...rawSnapshot, chat: mergeChat(currentSnapshot.chat, rawSnapshot.chat) }
            : rawSnapshot;

        const tokenToSave =
          useCCBStore.getState().privateState?.sessionToken ??
          useCCBStore.getState().sessionToken;
        if (tokenToSave && nextSnapshot.roomId) {
          saveCCBSessionToken(nextSnapshot.roomId, tokenToSave);
        }
        useCCBStore.setState({
          snapshot: nextSnapshot,
          ...(tokenToSave ? { roomId: nextSnapshot.roomId, sessionToken: tokenToSave } : {}),
        });
        break;
      }
      case "ccb.game.privateState": {
        const result = consumeStateSync(rawPrivateState, privateStateRevision, event.payload);
        if (result.needsFullSync || !result.state) {
          requestFullSync();
          break;
        }
        privateStateRevision = result.revision;
        rawPrivateState = result.state as CCBPrivateState;
        const nextPrivateState = rawPrivateState;
        const currentSnapshot = useCCBStore.getState().snapshot;
        if (nextPrivateState.sessionToken && currentSnapshot?.roomId) {
          saveCCBSessionToken(currentSnapshot.roomId, nextPrivateState.sessionToken);
          useCCBStore.setState({
            roomId: currentSnapshot.roomId,
            sessionToken: nextPrivateState.sessionToken,
            privateState: nextPrivateState,
          });
        } else {
          useCCBStore.setState({ privateState: nextPrivateState });
        }
        break;
      }
      case "ccb.room.closed": {
        const payload = event.payload as { roomId?: string };
        const closedRoomId = payload.roomId ?? useCCBStore.getState().roomId;
        if (closedRoomId) clearCCBSessionToken(closedRoomId);
        resetCCBStateSync();
        useCCBStore.setState({
          roomId: null,
          sessionToken: null,
          snapshot: null,
          privateState: null,
          roomClosedAt: Date.now(),
        });
        store.setNotice("房间已关闭", "error");
        break;
      }
      case "ccb.room.kicked": {
        const payload = event.payload as { roomId?: string };
        const closedRoomId = payload.roomId ?? useCCBStore.getState().roomId;
        if (closedRoomId) clearCCBSessionToken(closedRoomId);
        resetCCBStateSync();
        useCCBStore.setState({
          roomId: null,
          sessionToken: null,
          snapshot: null,
          privateState: null,
          roomClosedAt: Date.now(),
        });
        store.setNotice("你已被移出房间", "error");
        break;
      }
      case "session.replaced": {
        const payload = event.payload as { roomId?: string };
        const closedRoomId = payload.roomId ?? useCCBStore.getState().roomId;
        if (closedRoomId) clearCCBSessionToken(closedRoomId);
        useCCBStore.setState({
          roomId: null,
          sessionToken: null,
          snapshot: null,
          privateState: null,
          roomClosedAt: Date.now(),
        });
        store.setNotice("当前席位已在另一个标签页接管", "error");
        break;
      }
      case "server.shutdown": {
        const payload = event.payload as { message?: string } | undefined;
        const closedRoomId = useCCBStore.getState().roomId;
        if (closedRoomId) clearCCBSessionToken(closedRoomId);
        resetCCBStateSync();
        useCCBStore.setState({
          roomId: null,
          sessionToken: null,
          snapshot: null,
          privateState: null,
          roomClosedAt: Date.now(),
        });
        store.setNotice(payload?.message || SERVER_SHUTDOWN_MESSAGE, "error", 10_000);
        break;
      }
    }
  });

  const unsubStatus = CCBWs.onStatus((connected) => {
    useCCBStore.setState({ connected });
    const store = useCCBStore.getState();
    if (!connected) return;

    // 重连后差量基线已失效，必须重置修订号并重新拉全量。
    snapshotRevision = undefined;
    privateStateRevision = undefined;
    CCBWs.send("ccb.lobby.subscribeRooms").catch(() => {});
    if (store.roomId && store.sessionToken) {
      CCBWs.send("ccb.room.reconnect", {
        roomId: store.roomId,
        sessionToken: store.sessionToken,
      }).catch((error) => {
        if (!isPermanentRoomError(error)) return;
        const roomId = useCCBStore.getState().roomId;
        if (!roomId) return;
        clearCCBSessionToken(roomId);
        useCCBStore.setState({
          roomId: null,
          sessionToken: null,
          snapshot: null,
          privateState: null,
          roomClosedAt: Date.now(),
        });
        useCCBStore.getState().setNotice(roomErrorMessage(error), "error");
      });
    }
  });

  CCBWs.connect();

  return () => {
    unsubMessage();
    unsubStatus();
  };
}
