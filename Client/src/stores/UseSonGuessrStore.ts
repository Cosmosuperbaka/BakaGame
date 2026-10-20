import { create } from "zustand";
import { createQueryReuseCache, exactQueryKey, keywordQueryKey } from "@/lib/QueryReuse";
import { createRoomEntry } from "@/lib/RoomEntry";
import {
  type ChatMessage,
  type EventPacket,
  type ServerMessage,
  type SonGuessrRoomEnterAck,
  type SonGuessrPrivateState,
  type SonGuessrRoomSnapshot,
  type SonGuessrRoomSummary,
  type SongArtistSearchResult,
  type SongPlaylistInfo,
  type SongSearchResult,
  type BangumiSubjectSearchResult,
  type BangumiSongCandidate,
  SERVER_SHUTDOWN_MESSAGE,
  isPermanentRoomError,
  protocolErrorCode,
} from "@bakagame/shared";
import {
  clearSonGuessrSessionToken,
  getSonGuessrSessionToken,
  saveSonGuessrSessionToken,
} from "@/lib/Storage";
import * as ws from "@/lib/SonGuessrWs";
import { consumeStateSync } from "@/lib/StateSync";

const musicSearchCache = createQueryReuseCache<SongSearchResult[]>(keywordQueryKey);
const bangumiSearchCache = createQueryReuseCache<BangumiSubjectSearchResult[]>(keywordQueryKey);
const bangumiSongsCache = createQueryReuseCache<BangumiSongCandidate[]>(exactQueryKey);
const artistSearchCache = createQueryReuseCache<SongArtistSearchResult[]>(keywordQueryKey);
const playlistResolveCache = createQueryReuseCache<SongPlaylistInfo>(exactQueryKey);

/** 清空全部复用窗口；测试用它隔离用例，运行期无需调用（查询结果与房间无关）。 */
export function clearSonGuessrQueryCache() {
  musicSearchCache.clear();
  bangumiSearchCache.clear();
  bangumiSongsCache.clear();
  artistSearchCache.clear();
  playlistResolveCache.clear();
}

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
  createRoom: (
    params: {
      roomId: string;
      name: string;
      visibility: "public" | "private";
      password?: string;
      allowSpectators: boolean;
      userName: string;
      solo?: boolean;
    },
    signal?: AbortSignal
  ) => Promise<void>;
  joinRoom: (
    roomId: string,
    userName: string,
    password?: string,
    signal?: AbortSignal
  ) => Promise<void>;
  reconnectRoom: (roomId: string, signal?: AbortSignal) => Promise<boolean>;
  clearRoomClosed: () => void;
  resetRoomState: () => void;
  leaveRoom: () => Promise<void>;
  searchMusic: (keyword: string) => Promise<SongSearchResult[]>;
  searchBangumi: (keyword: string) => Promise<BangumiSubjectSearchResult[]>;
  resolveAnimeSongs: (subjectId: string) => Promise<BangumiSongCandidate[]>;
  searchArtist: (keyword: string) => Promise<SongArtistSearchResult[]>;
  /** 解析歌单链接或 ID；同一输入在复用窗口内不会重复请求上游。 */
  resolvePlaylist: (value: string) => Promise<SongPlaylistInfo>;
  sendCommand: ws.SonGuessrSendCommand;
}

/** 进房凭据 = 服务端 ack（含首屏快照与私有态）+ 客户端自己记的旧 token。 */
type RoomEntryReceipt = SonGuessrRoomEnterAck & { previousToken?: string | null };

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
  incoming: SonGuessrRoomSnapshot["chat"] = []
): SonGuessrRoomSnapshot["chat"] => {
  const map = new Map<string, SonGuessrRoomSnapshot["chat"][number]>();
  for (const msg of existing) {
    map.set(msg.id, msg);
  }
  for (const msg of incoming) {
    map.set(msg.id, msg);
  }
  return Array.from(map.values())
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MAX_CHAT_MESSAGES);
};

const requestFullSync = () => {
  if (syncRequestPending) return;
  syncRequestPending = true;
  void useSonGuessrStore
    .getState()
    .sendCommand("song.room.requestSync")
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
    payloadPrivateState?: SonGuessrPrivateState
  ) => {
    saveSonGuessrSessionToken(targetRoomId, sessionToken);

    if (
      rawSnapshot &&
      rawSnapshot.roomId !== targetRoomId &&
      payloadSnapshot?.roomId !== targetRoomId
    ) {
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
    const nextSnapshot =
      incomingSnapshot?.roomId === targetRoomId
        ? incomingSnapshot
        : currentSnapshot?.roomId === targetRoomId
          ? currentSnapshot
          : null;
    const nextPrivate =
      incomingPrivate?.sessionToken === sessionToken
        ? incomingPrivate
        : get().roomId === targetRoomId
          ? currentPrivate
          : null;

    set({
      roomId: targetRoomId,
      sessionToken,
      snapshot: nextSnapshot ? { ...nextSnapshot, chat: mergeChat([], nextSnapshot.chat) } : null,
      privateState: nextPrivate,
      roomClosedAt: null,
    });
  };

  const entry = (roomEntry = createRoomEntry<RoomEntryReceipt>({
    generation: () => connectionGeneration,
    begin: resetSonGuessrStateSync,
    apply: (receipt) =>
      applyRoomEnter(receipt.roomId, receipt.sessionToken, receipt.snapshot, receipt.privateState),
    discard: async (receipt) => {
      try {
        await ws.send(
          "song.room.leave",
          {},
          { roomId: receipt.roomId, sessionToken: receipt.sessionToken }
        );
      } finally {
        const token = getSonGuessrSessionToken(receipt.roomId);
        if (
          token === receipt.sessionToken ||
          (receipt.previousToken && token === receipt.previousToken)
        )
          clearSonGuessrSessionToken(receipt.roomId);
        resetSonGuessrStateSync();
        const current = get();
        if (current.roomId === receipt.roomId && current.sessionToken === receipt.sessionToken)
          current.resetRoomState();
        else if (get().roomId === null) current.resetRoomState();
      }
    },
  }));

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
      await ws.send("song.lobby.subscribeRooms", {});
    },

    createRoom: (params, signal) =>
      entry.enter(async () => {
        return ws.send("song.room.create", params);
      }, signal),

    joinRoom: (roomId, userName, password, signal) =>
      entry.enter(async () => {
        return ws.send("song.room.join", { userName, password }, { roomId });
      }, signal),

    reconnectRoom: (roomId, signal) => {
      const token = getSonGuessrSessionToken(roomId);
      if (!token) return Promise.resolve(false);
      return entry.restore(
        `${roomId}:${token}`,
        async () => {
          const res = await ws.send("song.room.reconnect", {
            roomId,
            sessionToken: token,
          });
          return { ...res, previousToken: token };
        },
        (error) => {
          if (!isPermanentRoomError(error)) return false;
          if (getSonGuessrSessionToken(roomId) === token) clearSonGuessrSessionToken(roomId);
          const current = get();
          if (current.roomId === roomId && current.sessionToken === token) {
            current.resetRoomState();
            set({ roomClosedAt: Date.now() });
          }
          const code = protocolErrorCode(error);
          const message =
            code === "SESSION_NOT_FOUND" || code === "SESSION_INVALID"
              ? "会话已失效，请重新加入"
              : code === "PLAYER_KICKED"
                ? "你已被移出房间"
                : "房间已解散或不存在";
          get().setNotice(message, "error");
          return true;
        },
        signal
      );
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
      entry.cancel();
      const { roomId, sessionToken } = get();
      if (!roomId) return;
      try {
        await ws.send("song.room.leave", {}, { roomId, sessionToken: sessionToken ?? undefined });
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

    searchMusic: (keyword) =>
      musicSearchCache.run(keyword, async () => {
        const result = await ws.send(
          "song.music.search",
          { keyword },
          {
            roomId: get().roomId ?? undefined,
            sessionToken: get().sessionToken ?? undefined,
          }
        );
        return result.results ?? [];
      }),

    searchBangumi: (keyword) =>
      bangumiSearchCache.run(keyword, async () => {
        const result = await ws.send(
          "song.bangumi.search",
          { keyword },
          {
            roomId: get().roomId ?? undefined,
            sessionToken: get().sessionToken ?? undefined,
          }
        );
        return result.results ?? [];
      }),

    resolveAnimeSongs: (subjectId) =>
      bangumiSongsCache.run(subjectId, async () => {
        const result = await ws.send(
          "song.bangumi.songs",
          { subjectId },
          {
            roomId: get().roomId ?? undefined,
            sessionToken: get().sessionToken ?? undefined,
          }
        );
        return result.results ?? [];
      }),

    searchArtist: (keyword) =>
      artistSearchCache.run(keyword, async () => {
        const result = await ws.send(
          "song.music.artist.search",
          { keyword },
          {
            roomId: get().roomId ?? undefined,
            sessionToken: get().sessionToken ?? undefined,
          }
        );
        return result.results ?? [];
      }),

    resolvePlaylist: (value) =>
      playlistResolveCache.run(value, async () => {
        const result = await ws.send(
          "song.music.playlist.resolve",
          { value },
          {
            roomId: get().roomId ?? undefined,
            sessionToken: get().sessionToken ?? undefined,
          }
        );
        return result.playlist;
      }),

    sendCommand: async (type, payload = {}, options) => {
      const { roomId, sessionToken } = get();
      return ws.send(type, payload, {
        roomId: roomId ?? undefined,
        sessionToken: sessionToken ?? undefined,
        timeout: options?.timeout,
      });
    },
  };
});

/** 幂等门闩：重复调用 initSonGuessrWs 不应叠加第二条消息订阅。 */
let sonGuessrWsInitialized = false;

/** 房间快照事件：保住完整协议基线供补丁索引使用，只展示合并并裁剪后的聊天。 */
function applyRoomSnapshotEvent(payload: unknown) {
  const result = consumeStateSync(rawSnapshot, snapshotRevision, payload);
  if (result.needsFullSync || !result.state) {
    requestFullSync();
    return;
  }
  snapshotRevision = result.revision;
  const snapshot = result.state as SonGuessrRoomSnapshot;
  rawSnapshot = snapshot;
  if (roomEntry.isPending()) return;
  const currentSnapshot = useSonGuessrStore.getState().snapshot;
  const nextSnapshot = {
    ...snapshot,
    chat: mergeChat(
      currentSnapshot?.roomId === snapshot.roomId ? currentSnapshot.chat : [],
      snapshot.chat
    ),
  };

  const currentPrivate = useSonGuessrStore.getState().privateState;
  const tokenToSave = roomEntry.isPending()
    ? null
    : (currentPrivate?.sessionToken ?? useSonGuessrStore.getState().sessionToken);
  if (tokenToSave && nextSnapshot.roomId) {
    saveSonGuessrSessionToken(nextSnapshot.roomId, tokenToSave);
  }
  useSonGuessrStore.setState({
    snapshot: nextSnapshot,
    ...(tokenToSave ? { roomId: nextSnapshot.roomId, sessionToken: tokenToSave } : {}),
  });
}

/** 私有状态事件：席位凭据随快照归属落盘，其余情况只换私有状态。 */
function applyPrivateStateEvent(payload: unknown) {
  const result = consumeStateSync(rawPrivateState, privateStateRevision, payload);
  if (result.needsFullSync || !result.state) {
    requestFullSync();
    return;
  }
  privateStateRevision = result.revision;
  rawPrivateState = result.state as SonGuessrPrivateState;
  if (roomEntry.isPending()) return;
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

/** 聊天走增量事件：一条消息不再连带整套房间快照广播。 */
function applyChatMessageEvent(payload: unknown) {
  const incoming = (payload as { message?: ChatMessage } | undefined)?.message;
  const current = useSonGuessrStore.getState().snapshot;
  if (!incoming || !current) return;
  useSonGuessrStore.setState({
    snapshot: {
      ...current,
      chat: mergeChat(current.chat, [incoming]),
    },
  });
}

/**
 * 退出房间：清掉席位凭据与整套房间态。
 *
 * 差量同步基线必须一起重置：残留旧 revision 会让后续反复触发全量同步。
 */
function leaveRoom(
  closedRoomId: string | null | undefined,
  notice: string,
  noticeDurationMs?: number
) {
  if (closedRoomId) clearSonGuessrSessionToken(closedRoomId);
  resetSonGuessrStateSync();
  useSonGuessrStore.setState({
    roomId: null,
    sessionToken: null,
    snapshot: null,
    privateState: null,
    roomClosedAt: Date.now(),
  });
  useSonGuessrStore.getState().setNotice(notice, "error", noticeDurationMs);
}

export function initSonGuessrWs() {
  if (sonGuessrWsInitialized) return () => {};
  sonGuessrWsInitialized = true;

  const unsubMsg = ws.onMessage((msg: ServerMessage) => {
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
        applyRoomSnapshotEvent(evt.payload);
        break;
      case "song.game.privateState":
        applyPrivateStateEvent(evt.payload);
        break;
      case "song.room.expiring":
        store.setNotice("房间即将因超时关闭", "error");
        break;
      case "song.chat.message":
        applyChatMessageEvent(evt.payload);
        break;
      case "song.room.closed": {
        roomEntry.cancel();
        const closedRoomId =
          (evt.payload as { roomId?: string }).roomId ?? useSonGuessrStore.getState().roomId;
        leaveRoom(closedRoomId, "房间已关闭");
        break;
      }
      case "song.room.kicked": {
        roomEntry.cancel();
        const closedRoomId =
          (evt.payload as { roomId?: string }).roomId ?? useSonGuessrStore.getState().roomId;
        leaveRoom(closedRoomId, "你已被移出房间");
        break;
      }
      case "session.replaced":
      case "song.session.replaced": {
        roomEntry.cancel();
        const closedRoomId =
          (evt.payload as { roomId?: string }).roomId ?? useSonGuessrStore.getState().roomId;
        leaveRoom(closedRoomId, "当前席位已在另一个标签页接管");
        break;
      }
      case "server.shutdown": {
        roomEntry.cancel();
        const message =
          (evt.payload as { message?: string } | undefined)?.message || SERVER_SHUTDOWN_MESSAGE;
        leaveRoom(useSonGuessrStore.getState().roomId, message, 10_000);
        break;
      }
    }
  });

  const unsubStatus = ws.onStatus((connected) => {
    if (!connected) connectionGeneration += 1;
    useSonGuessrStore.setState(connected ? { connected } : { connected, lobbyReady: false });
    const store = useSonGuessrStore.getState();

    if (connected) {
      snapshotRevision = undefined;
      privateStateRevision = undefined;
      ws.send("song.lobby.subscribeRooms", {}).catch(() => {});
      if (store.roomId && store.sessionToken) {
        saveSonGuessrSessionToken(store.roomId, store.sessionToken);
        void store.reconnectRoom(store.roomId).catch(() => {});
      }
    }
  });

  ws.connect();

  return () => {
    sonGuessrWsInitialized = false;
    unsubMsg();
    unsubStatus();
    connectionGeneration += 1;
    ws.disconnect();
    resetSonGuessrStateSync();
    useSonGuessrStore.setState({ connected: false, lobbyReady: false });
  };
}
