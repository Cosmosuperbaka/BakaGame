import { create } from "zustand";
import { errorText } from "@/lib/ErrorMessage";
import {
  createQueryReuseCache,
  exactQueryKey,
  keywordQueryKey,
  type QueryReuseCache,
} from "@/lib/QueryReuse";
import { permanentRoomErrorMessage, roomIsGone } from "@/lib/PermanentRoomError";
import {
  SERVER_SHUTDOWN_MESSAGE,
  isPermanentRoomError,
  mergeChatWindow,
} from "@bakagame/shared/values";
import type {
  ChatMessage,
  SonGuessrAck,
  SonGuessrCommand,
  SonGuessrPayload,
  SonGuessrRoomEnterAck,
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
  SonGuessrRoomSummary,
  SonGuessrMusicAccount,
  SongArtistSearchResult,
  SongPlaylistInfo,
  SongSearchResult,
  BangumiSubjectSearchResult,
  BangumiSongCandidate,
} from "@bakagame/shared";
import {
  clearSonGuessrSessionToken,
  getSonGuessrSessionToken,
  saveSonGuessrSessionToken,
} from "@/lib/Storage";
import * as ws from "@/lib/SonGuessrWs";
import type { GameSendCommand } from "@/lib/GameWs";
import { getStoredSongMusicSession, saveSongMusicSession } from "@/lib/SonGuessrMusicSession";
import { createRoomCoreSlice, type RoomCoreState } from "./room/RoomCoreSlice";
import { createRoomRuntime, type RoomRuntime } from "./room/RoomRuntime";
import type { StateSyncChannel } from "./room/StateSyncChannel";
import { createToastSlice, type ToastState } from "./room/ToastSlice";

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

export interface SonGuessrStore
  extends
    ToastState,
    RoomCoreState<SonGuessrRoomSummary, SonGuessrRoomSnapshot, SonGuessrPrivateState> {
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
      /** 建房时就允许 MCP 接入；单人房由系统预置为 true，房主随后仍可关掉。 */
      allowAgents?: boolean;
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
  resetRoomState: () => void;
  leaveRoom: () => Promise<void>;
  searchMusic: (keyword: string) => Promise<SongSearchResult[]>;
  searchBangumi: (keyword: string) => Promise<BangumiSubjectSearchResult[]>;
  resolveAnimeSongs: (subjectId: string) => Promise<BangumiSongCandidate[]>;
  searchArtist: (keyword: string) => Promise<SongArtistSearchResult[]>;
  /** 解析歌单链接或 ID；同一输入在复用窗口内不会重复请求上游。 */
  resolvePlaylist: (value: string) => Promise<SongPlaylistInfo>;
  sendCommand: GameSendCommand<ws.SonGuessrCommandMap>;
}

/** 进房凭据 = 服务端 ack（含首屏快照与私有态）+ 客户端自己记的旧 token。 */
type RoomEntryReceipt = SonGuessrRoomEnterAck & { previousToken?: string | null };

let runtime: RoomRuntime<
  ws.SonGuessrCommandMap,
  SonGuessrRoomSnapshot,
  SonGuessrPrivateState,
  RoomEntryReceipt
>;

export const resetSonGuessrStateSync = () => {
  runtime.sync.reset();
};

export const useSonGuessrStore = create<SonGuessrStore>((set, get) => {
  const applyRoomEnter = (
    sync: StateSyncChannel<SonGuessrRoomSnapshot, SonGuessrPrivateState>,
    targetRoomId: string,
    sessionToken: string,
    payloadSnapshot?: SonGuessrRoomSnapshot,
    payloadPrivateState?: SonGuessrPrivateState
  ) => {
    saveSonGuessrSessionToken(targetRoomId, sessionToken);

    const leftover = sync.snapshot.baseline();
    if (leftover && leftover.roomId !== targetRoomId && payloadSnapshot?.roomId !== targetRoomId) {
      sync.reset();
    }

    const rawSnapshot = sync.snapshot.baseline();
    const rawPrivateState = sync.privateState.baseline();
    if (payloadSnapshot && (!rawSnapshot || rawSnapshot.roomId !== targetRoomId)) {
      sync.snapshot.adopt(payloadSnapshot);
    }
    if (payloadPrivateState && (!rawPrivateState || get().roomId !== targetRoomId)) {
      sync.privateState.adopt(payloadPrivateState);
    }

    const currentSnapshot = get().snapshot;
    const currentPrivate = get().privateState;
    const incomingSnapshot = payloadSnapshot ?? sync.snapshot.baseline();
    const incomingPrivate = payloadPrivateState ?? sync.privateState.baseline();
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
      snapshot: nextSnapshot
        ? { ...nextSnapshot, chat: mergeChatWindow([], nextSnapshot.chat) }
        : null,
      privateState: nextPrivate,
      roomClosedAt: null,
    });
  };

  runtime = createRoomRuntime<
    ws.SonGuessrCommandMap,
    SonGuessrRoomSnapshot,
    SonGuessrPrivateState,
    RoomEntryReceipt
  >({
    ws,
    tokens: {
      read: getSonGuessrSessionToken,
      save: saveSonGuessrSessionToken,
      clear: clearSonGuessrSessionToken,
    },
    requestSync: "song.room.requestSync",
    identity: get,
    events: {
      lobbyRooms: "song.lobby.rooms",
      snapshot: "song.room.snapshot",
      privateState: "song.game.privateState",
      ended: {
        "song.room.closed": "房间已关闭",
        "song.room.kicked": "你已被移出房间",
        "session.replaced": "当前席位已在另一个标签页接管",
        "song.session.replaced": "当前席位已在另一个标签页接管",
      },
      extra: {
        "song.auth.session": (payload) => {
          // 服务端后台续期后把新 Cookie 只推给号主；同步本机副本，下次进房不再拿旧凭据覆盖。
          const session = payload as {
            platform?: "netease" | "qq";
            cookie?: string;
            account?: SonGuessrMusicAccount;
          };
          if (
            (session.platform === "netease" || session.platform === "qq") &&
            session.cookie &&
            session.account
          ) {
            const stored = getStoredSongMusicSession(session.platform);
            saveSongMusicSession(
              { cookie: session.cookie, account: session.account },
              stored?.persistent ?? true,
              session.platform
            );
          }
        },
        "song.room.expiring": () => get().showToast("房间即将因超时关闭", "error"),
        "song.chat.message": applyChatMessageEvent,
      },
    },
    sync: {
      // 猜歌的座位绑定在连接上，全量请求不依赖信封凭据，任何时候都可以立即发。
      defer: () => false,
      onError: () => {},
    },
    entry: {
      apply: (receipt, { sync }) =>
        applyRoomEnter(
          sync,
          receipt.roomId,
          receipt.sessionToken,
          receipt.snapshot,
          receipt.privateState
        ),
      discard: async (receipt, { sync }) => {
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
          sync.reset();
          const current = get();
          if (current.roomId === receipt.roomId && current.sessionToken === receipt.sessionToken)
            current.resetRoomState();
          else if (get().roomId === null) current.resetRoomState();
        }
      },
    },
    status: {
      generationOn: "disconnect",
      syncOn: "clearRevisionsOnConnect",
      write: (connected) => set(connected ? { connected } : { connected, lobbyReady: false }),
      subscribeLobby: () => {
        void get()
          .subscribeLobby()
          .catch(() => {});
      },
      restore: { by: "runtime", reconnect: (roomId) => get().reconnectRoom(roomId) },
    },
    cleanup: {
      disconnectFirst: false,
      bumpGeneration: true,
      finish: () => {
        resetSonGuessrStateSync();
        set({ connected: false, lobbyReady: false });
      },
    },
    handlers: {
      lobbyRooms: (payload) => set({ rooms: payload as SonGuessrRoomSummary[], lobbyReady: true }),
      snapshot: applyRoomSnapshotEvent,
      privateState: applyPrivateStateEvent,
      roomEnded: (text) => {
        resetSonGuessrStateSync();
        set({
          roomId: null,
          sessionToken: null,
          snapshot: null,
          privateState: null,
          roomClosedAt: Date.now(),
        });
        get().showToast(text, "error");
      },
      shutdown: (payload) => {
        runtime.cancelEntry();
        // 原地待命：保留票据与快照。连接恢复后状态回调会带原 sessionToken 自动
        // 重新入房；真回不去（快照被丢弃）时那一步会走会话失效分支并清票据。
        get().showToast(errorText(payload, SERVER_SHUTDOWN_MESSAGE), "error", 10_000);
      },
    },
  });

  /** 只读查询的共用壳：复用窗口 + 带房间身份的命令 + 取字段，身份注入只留在 sendCommand 一处。 */
  const query = <TCommand extends SonGuessrCommand, TResult>(
    cache: QueryReuseCache<TResult>,
    key: string,
    command: TCommand,
    payload: SonGuessrPayload<TCommand>,
    pick: (ack: SonGuessrAck<TCommand>) => TResult
  ) => cache.run(key, () => get().sendCommand(command, payload).then(pick));

  return {
    ...createRoomCoreSlice(set),
    ...createToastSlice(set, { mode: "slot", defaultType: "info", defaultMs: 3000 }),

    subscribeLobby: async () => {
      await ws.send("song.lobby.subscribeRooms", {});
    },

    createRoom: (params, signal) =>
      runtime.enter(async () => {
        return ws.send("song.room.create", params);
      }, signal),

    joinRoom: (roomId, userName, password, signal) =>
      runtime.enter(async () => {
        return ws.send("song.room.join", { userName, password }, { roomId });
      }, signal),

    reconnectRoom: (roomId, signal) => {
      const token = getSonGuessrSessionToken(roomId);
      if (!token) return Promise.resolve(false);
      return runtime.restore(
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
          const inThisRoom = current.roomId === roomId && current.sessionToken === token;
          if (inThisRoom) current.resetRoomState();
          if (inThisRoom || roomIsGone(error)) set({ roomClosedAt: Date.now() });
          get().showToast(permanentRoomErrorMessage(error), "error");
          return true;
        },
        signal
      );
    },

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
      runtime.cancelEntry();
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
          current.clearToasts();
          set({
            roomId: null,
            sessionToken: null,
            snapshot: null,
            privateState: null,
            roomClosedAt: null,
          });
        } else if (sessionToken && getSonGuessrSessionToken(roomId) === sessionToken) {
          clearSonGuessrSessionToken(roomId);
        }
      }
    },

    searchMusic: (keyword) =>
      query(
        musicSearchCache,
        keyword,
        "song.music.search",
        { keyword },
        (ack) => ack.results ?? []
      ),

    searchBangumi: (keyword) =>
      query(
        bangumiSearchCache,
        keyword,
        "song.bangumi.search",
        { keyword },
        (ack) => ack.results ?? []
      ),

    resolveAnimeSongs: (subjectId) =>
      query(
        bangumiSongsCache,
        subjectId,
        "song.bangumi.songs",
        { subjectId },
        (ack) => ack.results ?? []
      ),

    searchArtist: (keyword) =>
      query(
        artistSearchCache,
        keyword,
        "song.music.artist.search",
        { keyword },
        (ack) => ack.results ?? []
      ),

    resolvePlaylist: (value) =>
      query(
        playlistResolveCache,
        value,
        "song.music.playlist.resolve",
        { value },
        (ack) => ack.playlist
      ),

    sendCommand: runtime.sendCommand,
  };
});

/** 房间快照事件：保住完整协议基线供补丁索引使用，只展示合并并裁剪后的聊天。 */
function applyRoomSnapshotEvent(snapshot: SonGuessrRoomSnapshot) {
  const currentSnapshot = useSonGuessrStore.getState().snapshot;
  const nextSnapshot = {
    ...snapshot,
    chat: mergeChatWindow(
      currentSnapshot?.roomId === snapshot.roomId ? currentSnapshot.chat : [],
      snapshot.chat
    ),
  };

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

/** 私有状态事件：席位凭据随快照归属落盘，其余情况只换私有状态。 */
function applyPrivateStateEvent(nextPrivateState: SonGuessrPrivateState) {
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

/** 聊天走增量事件：一条消息不再连带整套房间快照广播。 */
function applyChatMessageEvent(payload: unknown) {
  const incoming = (payload as { message?: ChatMessage } | undefined)?.message;
  const current = useSonGuessrStore.getState().snapshot;
  if (!incoming || !current) return;
  useSonGuessrStore.setState({
    snapshot: {
      ...current,
      chat: mergeChatWindow(current.chat, [incoming]),
    },
  });
}

/** 玩法对外的连接入口：幂等门闩、事件分发与清理都在运行时里。 */
export function initSonGuessrWs() {
  return runtime.init();
}
