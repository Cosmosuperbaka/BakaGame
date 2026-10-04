import { create } from "zustand";
import { createRoomEntry } from "@/lib/RoomEntry";
import type {
  ChatMessage,
  EventPacket,
  ServerMessage,
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
  SonGuessrRoomSummary,
  SongSearchResult,
  BangumiSubjectSearchResult,
} from "@/types";
import { SERVER_SHUTDOWN_MESSAGE } from "@/types";
import {
  clearSonGuessrSessionToken,
  getSonGuessrSessionToken,
  saveSonGuessrSessionToken,
} from "@/lib/Storage";
import { sonGuessrWs } from "@/lib/SonGuessrWs";
import { consumeStateSync } from "@/lib/StateSync";

export interface SonGuessrStore {
  connected: boolean;
  /** 本次连接已收到首个房间列表；断线复位。大厅据此区分「加载中」与「暂无房间」。 */
  lobbyReady: boolean;
  rooms: SonGuessrRoomSummary[];
  roomId: string | null;
  sessionToken: string | null;
  snapshot: SonGuessrRoomSnapshot | null;
  privateState: SonGuessrPrivateState | null;
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
    solo?: boolean;
  }, signal?: AbortSignal) => Promise<void>;
  joinRoom: (roomId: string, userName: string, password?: string, signal?: AbortSignal) => Promise<void>;
  reconnectRoom: (roomId: string, signal?: AbortSignal) => Promise<boolean>;
  clearRoomClosed: () => void;
  resetRoomState: () => void;
  leaveRoom: () => Promise<void>;
  searchMusic: (keyword: string) => Promise<SongSearchResult[]>;
  searchBangumi: (keyword: string) => Promise<BangumiSubjectSearchResult[]>;
  sendCommand: <T extends Record<string, unknown> = Record<string, unknown>>(
    type: string,
    payload?: Record<string, unknown>,
    /** `timeout: 0` 表示不设请求超时，用于自动出题这类耗时由上游决定的长任务。 */
    options?: { timeout?: number },
  ) => Promise<T>;
}

type RoomEntryReceipt = {
  roomId: string;
  sessionToken: string;
  snapshot?: SonGuessrRoomSnapshot;
  privateState?: SonGuessrPrivateState;
  previousToken?: string | null;
};

let connectionGeneration = 0;
let roomEntry: ReturnType<typeof createRoomEntry<RoomEntryReceipt>>;
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

const MAX_CHAT_MESSAGES = 200;

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
  return Array.from(map.values()).sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_CHAT_MESSAGES);
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

export const useSonGuessrStore = create<SonGuessrStore>((set, get) => {
  const applyRoomEnter = (
    targetRoomId: string,
    sessionToken: string,
    payloadSnapshot?: SonGuessrRoomSnapshot,
    payloadPrivateState?: SonGuessrPrivateState,
  ) => {
      saveSonGuessrSessionToken(targetRoomId, sessionToken);

      if (rawSnapshot && rawSnapshot.roomId !== targetRoomId && payloadSnapshot?.roomId !== targetRoomId) {
        resetSonGuessrStateSync();
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
      const incomingSnapshot = payloadSnapshot ?? rawSnapshot;
      const incomingPrivate = payloadPrivateState ?? rawPrivateState;
      const nextSnapshot = incomingSnapshot?.roomId === targetRoomId
        ? incomingSnapshot : currentSnapshot?.roomId === targetRoomId ? currentSnapshot : null;
      const nextPrivate = incomingPrivate?.sessionToken === sessionToken
        ? incomingPrivate : get().roomId === targetRoomId ? currentPrivate : null;

      set({
        roomId: targetRoomId,
        sessionToken,
        snapshot: nextSnapshot ? { ...nextSnapshot, chat: mergeChat([], nextSnapshot.chat) } : null,
        privateState: nextPrivate,
        roomClosedAt: null,
      });
    };

    const entry = roomEntry = createRoomEntry<RoomEntryReceipt>({
      generation: () => connectionGeneration,
      begin: resetSonGuessrStateSync,
      apply: (receipt) => applyRoomEnter(receipt.roomId, receipt.sessionToken, receipt.snapshot, receipt.privateState),
      discard: async (receipt) => {
        try { await sonGuessrWs.send("song.room.leave", {}, { roomId: receipt.roomId, sessionToken: receipt.sessionToken }); }
        finally {
          const token = getSonGuessrSessionToken(receipt.roomId);
          if (token === receipt.sessionToken || (receipt.previousToken && token === receipt.previousToken)) clearSonGuessrSessionToken(receipt.roomId);
          resetSonGuessrStateSync();
          const current = get();
          if (current.roomId === receipt.roomId && current.sessionToken === receipt.sessionToken) current.resetRoomState();
          else if (get().roomId === null) current.resetRoomState();
        }
      },
    });

    return {
      connected: false,
      lobbyReady: false,
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
        await sonGuessrWs.send("song.lobby.subscribeRooms");
      },

      createRoom: (params, signal) => entry.enter(async () => {
        const res = await sonGuessrWs.send<RoomEntryReceipt>("song.room.create", params);
        return { ...res, roomId: res.roomId ?? params.roomId };
      }, signal),

      joinRoom: (roomId, userName, password, signal) => entry.enter(async () => {
        const res = await sonGuessrWs.send<RoomEntryReceipt>("song.room.join", { userName, password }, { roomId });
        return { ...res, roomId: res.roomId ?? roomId };
      }, signal),

      reconnectRoom: (roomId, signal) => {
        const token = getSonGuessrSessionToken(roomId);
        if (!token) return Promise.resolve(false);
        return entry.restore(`${roomId}:${token}`, async () => {
          const res = await sonGuessrWs.send<RoomEntryReceipt>("song.room.reconnect", { roomId, sessionToken: token });
          return { ...res, roomId: res.roomId ?? roomId, previousToken: token };
        }, (error) => {
          if (!isPermanentRoomError(error)) return false;
          if (getSonGuessrSessionToken(roomId) === token) clearSonGuessrSessionToken(roomId);
          const current = get();
          if (current.roomId === roomId && current.sessionToken === token) {
            current.resetRoomState();
            set({ roomClosedAt: Date.now() });
          }
          const code = (error as { code?: string } | null)?.code;
          const message = code === "SESSION_NOT_FOUND" || code === "SESSION_INVALID"
            ? "会话已失效，请重新加入" : code === "PLAYER_KICKED" ? "你已被移出房间" : "房间已解散或不存在";
          get().setNotice(message, "error");
          return true;
        }, signal);
      },

      clearRoomClosed: () => set({ roomClosedAt: null }),

      resetRoomState: () => {
        resetSonGuessrStateSync();
        set({
          roomId: null,
          sessionToken: null,
          snapshot: null,
          privateState: null,
          roomClosedAt: null,
        });
      },

  leaveRoom: async () => {
    entry.cancel();    const { roomId, sessionToken } = get();
    if (!roomId) return;
    try {
      await sonGuessrWs.send("song.room.leave", {}, { roomId, sessionToken: sessionToken ?? undefined });
    } catch {
      // 忽略离开房间失败
    } finally {
      // 退房在房间页卸载后才发出，回包慢时玩家可能已经进了下一个房间：只清掉发起这次退房的会话，
      // 已离开房间的旧凭据照常删掉，免得下次重连拿着失效凭据先报一次错。
      const current = get();
      if (current.roomId === roomId && current.sessionToken === sessionToken) {
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
      } else if (sessionToken && getSonGuessrSessionToken(roomId) === sessionToken) {
        clearSonGuessrSessionToken(roomId);
      }
    }
  },

  searchMusic: async (keyword) => {
    const result = await sonGuessrWs.send<{ results?: SongSearchResult[] }>(
      "song.music.search",
      { keyword },
      {
        roomId: get().roomId ?? undefined,
        sessionToken: get().sessionToken ?? undefined,
      },
    );
    return result.results ?? [];
  },

  searchBangumi: async (keyword) => {
    const result = await sonGuessrWs.send<{ results?: BangumiSubjectSearchResult[] }>(
      "song.bangumi.search",
      { keyword },
      {
        roomId: get().roomId ?? undefined,
        sessionToken: get().sessionToken ?? undefined,
      },
    );
    return result.results ?? [];
  },

  sendCommand: async (type, payload = {}, options) => {
    const { roomId, sessionToken } = get();
    return sonGuessrWs.send(type, payload, {
      roomId: roomId ?? undefined,
      sessionToken: sessionToken ?? undefined,
      timeout: options?.timeout,
    });
  },
};
});

/** 幂等门闩：重复调用 initSonGuessrWs 不应叠加第二条消息订阅。 */
let sonGuessrWsInitialized = false;

export function initSonGuessrWs() {
  if (sonGuessrWsInitialized) return () => {};
  sonGuessrWsInitialized = true;

  const unsubMsg = sonGuessrWs.onMessage((msg: ServerMessage) => {
    if (msg.type !== "event") return;
    const evt = msg as EventPacket;
    const store = useSonGuessrStore.getState();

    switch (evt.event) {
      case "song.lobby.rooms":
        useSonGuessrStore.setState({
          rooms: evt.payload as SonGuessrRoomSummary[],
          lobbyReady: true,
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
          if (roomEntry.isPending()) break;
          const currentSnapshot = useSonGuessrStore.getState().snapshot;
          // 保留完整协议基线供补丁索引使用，仅展示快照合并并裁剪聊天。
          const nextSnapshot = {
            ...rawSnapshot,
            chat: mergeChat(currentSnapshot?.roomId === rawSnapshot.roomId ? currentSnapshot.chat : [], rawSnapshot.chat),
          };

          const currentPrivate = useSonGuessrStore.getState().privateState;
          const tokenToSave = roomEntry.isPending() ? null : currentPrivate?.sessionToken ?? useSonGuessrStore.getState().sessionToken;
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
          if (roomEntry.isPending()) break;
          const nextPrivateState = rawPrivateState;
          const currentSnapshot = useSonGuessrStore.getState().snapshot;
          if (!roomEntry.isPending() && nextPrivateState.sessionToken && currentSnapshot?.roomId) {
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
      case "song.chat.message": {
        // 聊天走增量事件：一条消息不再连带整套房间快照广播。
        const incoming = (evt.payload as { message?: ChatMessage } | undefined)?.message;
        const current = useSonGuessrStore.getState().snapshot;
        if (!incoming || !current) break;
        useSonGuessrStore.setState({
          snapshot: {
            ...current,
            chat: mergeChat(current.chat, [incoming]),
          },
        });
        break;
      }
      case "song.room.closed": {
        roomEntry.cancel();
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
        roomEntry.cancel();
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
        roomEntry.cancel();
        const payload = evt.payload as { roomId?: string };
        const closedRoomId = payload.roomId ?? useSonGuessrStore.getState().roomId;
        if (closedRoomId) clearSonGuessrSessionToken(closedRoomId);
        // 与房间关闭/被踢一致地重置差量同步基线：
        // 漏掉这一行会残留旧 revision，导致后续反复触发全量同步。
        resetSonGuessrStateSync();
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
      case "server.shutdown": {
        roomEntry.cancel();
        const payload = evt.payload as { message?: string } | undefined;
        const message = payload?.message || SERVER_SHUTDOWN_MESSAGE;
        const closedRoomId = useSonGuessrStore.getState().roomId;
        if (closedRoomId) clearSonGuessrSessionToken(closedRoomId);
        resetSonGuessrStateSync();
        useSonGuessrStore.setState({
          roomId: null,
          sessionToken: null,
          snapshot: null,
          privateState: null,
          roomClosedAt: Date.now(),
        });
        useSonGuessrStore.getState().setNotice(message, "error", 10000);
        break;
      }
    }
  });

  const unsubStatus = sonGuessrWs.onStatus((connected) => {
    if (!connected) connectionGeneration += 1;
    useSonGuessrStore.setState(connected ? { connected } : { connected, lobbyReady: false });
    const store = useSonGuessrStore.getState();

    if (connected) {
      snapshotRevision = undefined;
      privateStateRevision = undefined;
      sonGuessrWs.send("song.lobby.subscribeRooms").catch(() => {});
      if (store.roomId && store.sessionToken) {
        saveSonGuessrSessionToken(store.roomId, store.sessionToken);
        void store.reconnectRoom(store.roomId).catch(() => {});
      }
    }
  });


  sonGuessrWs.connect();

  return () => {
    sonGuessrWsInitialized = false;
    unsubMsg();
    unsubStatus();
    connectionGeneration += 1;
    sonGuessrWs.disconnect();
    resetSonGuessrStateSync();
    useSonGuessrStore.setState({ connected: false, lobbyReady: false });
  };
}
