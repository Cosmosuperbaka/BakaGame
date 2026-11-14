import { create } from "zustand";
import { errorText } from "@/lib/ErrorMessage";
import { permanentRoomErrorMessage, roomIsGone } from "@/lib/PermanentRoomError";
import * as ws from "@/lib/WhoIsFakerWs";
import type { GameSendCommand } from "@/lib/GameWs";
import { serverNow } from "./UseServerClock";
import { createRoomCoreSlice, type RoomCoreState } from "./room/RoomCoreSlice";
import { createRoomRuntime, type RoomRuntime } from "./room/RoomRuntime";
import { createToastSlice, type ToastState } from "./room/ToastSlice";
import { saveSessionToken, getSessionToken, clearSessionToken } from "@/lib/Storage";
import {
  isPermanentRoomError,
  mergeChatWindow,
  CLIENT_CHAT_WINDOW,
  SERVER_SHUTDOWN_MESSAGE,
} from "@bakagame/shared/values";
import type {
  WhoIsFakerRoomEnterAck,
  WhoIsFakerRoomSnapshot,
  WhoIsFakerPrivateState,
  WhoIsFakerRoomSummary,
} from "@bakagame/shared";

type WhoIsFakerChatMessage = WhoIsFakerRoomSnapshot["chat"][number];

export interface WhoIsFakerGameState
  extends
    ToastState,
    RoomCoreState<WhoIsFakerRoomSummary, WhoIsFakerRoomSnapshot, WhoIsFakerPrivateState> {
  /**
   * 本机生成的频道切换提示（进入观战频道 / 返回公共频道）。
   * 与 `snapshot` 分开存：快照只放服务端下发的投影，本地提示混进去就分不清哪些是房间事实；
   * 展示时由 `withChannelNotices` 按时间并入聊天列表。
   */
  channelNotices: WhoIsFakerChatMessage[];

  // Actions
  setRooms: (rooms: WhoIsFakerRoomSummary[]) => void;
  joinRoomState: (roomId: string, sessionToken: string) => void;
  leaveRoomState: () => void;
  markRoomClosed: () => void;
  setSnapshot: (snapshot: WhoIsFakerRoomSnapshot | null) => void;
  setPrivateState: (privateState: WhoIsFakerPrivateState | null) => void;

  // Async Business Actions
  subscribeLobby: () => Promise<void>;
  createRoom: (
    params: {
      roomId: string;
      name: string;
      visibility: "public" | "private";
      password?: string;
      allowSpectators: boolean;
      userName: string;
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
  leaveRoom: () => Promise<void>;
  sendCommand: GameSendCommand<ws.WhoIsFakerCommandMap>;
}

/**
 * 进房凭据：服务端 ack 的字段（`WhoIsFakerRoomEnterAck`）加上客户端自己补的 `previousToken`。
 * 快照与私有态不在 ack 里，只由 event 下发，见下方 `apply` 取 `syncedSnapshot` 的那条路径。
 */
type RoomEntryReceipt = WhoIsFakerRoomEnterAck & { previousToken?: string | null };

let runtime: RoomRuntime<
  ws.WhoIsFakerCommandMap,
  WhoIsFakerRoomSnapshot,
  WhoIsFakerPrivateState,
  RoomEntryReceipt
>;

export const resetWhoIsFakerStateSync = () => {
  runtime.sync.reset();
};

let lastPlayerChannel: "main" | "ghost" | undefined;
let lastRoomAndRoundKey: string | undefined;

const computePlayerChannel = (
  snapshot: WhoIsFakerRoomSnapshot | null,
  playerId: string | null | undefined
): "main" | "ghost" => {
  if (!snapshot || !playerId) return "main";
  const isIngame = Boolean(
    snapshot.status.started &&
    ["description", "voting", "tieBreak", "night", "blankGuess", "feedback"].includes(
      snapshot.status.phase
    )
  );
  if (!isIngame) return "main";
  const isQuestioner = snapshot.status.questionerPlayerId === playerId;
  if (isQuestioner) return "main";
  const me = snapshot.players.find((p) => p.id === playerId);
  if (!me) return "main";
  // 服务端对读不到亡者频道的旁观者把发言留在主频道（房间没有开启旁观可见答案时），这里同口径。
  const spectatorInGhost =
    me.roundStatus === "spectator" && snapshot.settings.spectatorsSeeAnswers === true;
  return me.roundStatus === "dead" || spectatorInGhost ? "ghost" : "main";
};

const channelNotice = (
  kind: "init" | "trans",
  channel: "main" | "ghost"
): WhoIsFakerChatMessage => ({
  id: `local-chan-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  playerId: "system",
  playerName: "系统",
  text:
    channel === "ghost"
      ? "已进入观战频道，发言仅对淘汰玩家与观战者可见"
      : "已返回公共聊天频道，所有玩家均可见发言",
  createdAt: serverNow(),
  system: true,
  channel,
});

/** 只算出这次快照是否让本机玩家换了频道，返回要追加的本地提示；不改快照。 */
const channelTransitionNotice = (
  snapshot: WhoIsFakerRoomSnapshot,
  playerId: string | null | undefined
): WhoIsFakerChatMessage | undefined => {
  if (!playerId) return undefined;
  const currentKey = `${snapshot.roomId}:${snapshot.status.roundId ?? snapshot.status.phase ?? "lobby"}`;
  const nextChannel = computePlayerChannel(snapshot, playerId);

  if (lastRoomAndRoundKey !== currentKey) {
    lastRoomAndRoundKey = currentKey;
    lastPlayerChannel = nextChannel;
    return nextChannel === "ghost" ? channelNotice("init", "ghost") : undefined;
  }

  const changed = lastPlayerChannel && lastPlayerChannel !== nextChannel;
  lastPlayerChannel = nextChannel;
  return changed ? channelNotice("trans", nextChannel) : undefined;
};

/** 聊天面板的展示列表：服务端聊天与本机频道提示按时间合并。 */
export const withChannelNotices = (
  chat: WhoIsFakerRoomSnapshot["chat"],
  notices: readonly WhoIsFakerChatMessage[]
): WhoIsFakerRoomSnapshot["chat"] => (notices.length ? mergeChatWindow(chat, [...notices]) : chat);

export const useWhoIsFakerStore = create<WhoIsFakerGameState>((set, get) => {
  runtime = createRoomRuntime<
    ws.WhoIsFakerCommandMap,
    WhoIsFakerRoomSnapshot,
    WhoIsFakerPrivateState,
    RoomEntryReceipt
  >({
    ws,
    tokens: { read: getSessionToken, save: saveSessionToken, clear: clearSessionToken },
    requestSync: "room.requestSync",
    identity: get,
    events: {
      lobbyRooms: "lobby.rooms",
      snapshot: "room.snapshot",
      privateState: "game.privateState",
      ended: {
        // 房间已在服务端删除，残留的会话令牌只会让下次进房重连一个不存在的房间。
        "room.closed": "房间已关闭",
        // 席位已被新标签页接管，本标签页同样必须退回大厅。
        "session.replaced": "您的连接已被新标签页替代",
      },
      extra: {
        "game.disconnectDecisionRequested": () =>
          get().showToast("有玩家掉线，等待主持人处理", "info"),
        "room.expiring": () => get().showToast("房间即将因超时关闭", "error"),
      },
    },
    sync: {
      // 卧底的座位绑定在连接上，全量请求不依赖信封凭据，任何时候都可以立即发。
      defer: () => false,
      onError: () => {},
    },
    entry: {
      apply: (receipt, { sync }) => {
        saveSessionToken(receipt.roomId, receipt.sessionToken);
        const syncedSnapshot = sync.snapshot.baseline();
        const syncedPrivateState = sync.privateState.baseline();
        const snapshot = syncedSnapshot?.roomId === receipt.roomId ? syncedSnapshot : undefined;
        const privateState =
          syncedPrivateState?.sessionToken === receipt.sessionToken
            ? syncedPrivateState
            : undefined;
        get().joinRoomState(receipt.roomId, receipt.sessionToken);
        if (snapshot) get().setSnapshot(snapshot);
        if (privateState) get().setPrivateState(privateState);
      },
      discard: async (receipt, { sync }) => {
        try {
          await ws.send(
            "room.leave",
            {},
            { roomId: receipt.roomId, sessionToken: receipt.sessionToken }
          );
        } finally {
          const token = getSessionToken(receipt.roomId);
          if (
            token === receipt.sessionToken ||
            (receipt.previousToken && token === receipt.previousToken)
          )
            clearSessionToken(receipt.roomId);
          sync.reset();
          const current = get();
          if (
            current.roomId === null ||
            (current.roomId === receipt.roomId && current.sessionToken === receipt.sessionToken)
          )
            current.leaveRoomState();
        }
      },
    },
    status: {
      generationOn: "disconnect",
      syncOn: "resetOnConnect",
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
        resetWhoIsFakerStateSync();
        set({ connected: false, lobbyReady: false });
      },
    },
    handlers: {
      lobbyRooms: (payload) => get().setRooms(payload as WhoIsFakerRoomSummary[]),
      snapshot: (snapshot) => get().setSnapshot(snapshot),
      privateState: (privateState) => get().setPrivateState(privateState),
      roomEnded: (text) => {
        get().leaveRoomState();
        get().markRoomClosed();
        get().showToast(text, "error");
      },
      shutdown: (payload) => {
        runtime.cancelEntry();
        // 原地待命：不清票据、不退房。服务端停机前会把房间落盘，连接恢复后
        // 状态回调会带原 sessionToken 自动 reconnectRoom 回到原位；
        // 若那局已被丢弃（旧版本服务或停机过久），那一步会收到 SESSION_NOT_FOUND
        // 并走既有的失效分支。这里提前清票据才是真的回不去了。
        get().showToast(errorText(payload, SERVER_SHUTDOWN_MESSAGE), "error", 10000);
      },
    },
  });
  const noticeUpdate = (
    snapshot: WhoIsFakerRoomSnapshot,
    playerId: string | null | undefined
  ): Partial<WhoIsFakerGameState> => {
    const notice = channelTransitionNotice(snapshot, playerId);
    return notice
      ? { channelNotices: [...get().channelNotices, notice].slice(-CLIENT_CHAT_WINDOW) }
      : {};
  };
  return {
    ...createRoomCoreSlice(set),
    ...createToastSlice(set, { mode: "queue", defaultType: "info", defaultMs: 3000 }),
    channelNotices: [],

    setRooms: (rooms) => set({ rooms, lobbyReady: true }),
    joinRoomState: (roomId, sessionToken) => {
      const changedRoom = get().roomId !== roomId;
      if (changedRoom) resetWhoIsFakerStateSync();
      set({
        roomId,
        sessionToken,
        roomClosedAt: null,
        ...(changedRoom ? { channelNotices: [] } : {}),
      });
    },
    leaveRoomState: () => {
      resetWhoIsFakerStateSync();
      lastPlayerChannel = undefined;
      lastRoomAndRoundKey = undefined;
      set({
        roomId: null,
        sessionToken: null,
        snapshot: null,
        privateState: null,
        channelNotices: [],
        roomClosedAt: null,
      });
    },
    markRoomClosed: () => set({ roomClosedAt: Date.now() }),
    setSnapshot: (incomingSnapshot) => {
      if (!incomingSnapshot) {
        set({ snapshot: null });
        return;
      }
      // 出局后的停顿由服务端的阶段反馈承担，这里不再暂扣结算快照。
      // 结算摘要也只认服务端：gameOver 与 summary 在服务端同一步写入，客户端不回填旧摘要。
      const previousSnapshot = get().snapshot;
      let snapshot = {
        ...incomingSnapshot,
        chat: incomingSnapshot.chat.slice(-CLIENT_CHAT_WINDOW),
      };

      // 服务端只保留最近一段聊天，同房间内把已收到的历史续上，供玩家往回翻。
      if (previousSnapshot && previousSnapshot.roomId === snapshot.roomId) {
        snapshot = { ...snapshot, chat: mergeChatWindow(previousSnapshot.chat, snapshot.chat) };
      }

      set({ snapshot, ...noticeUpdate(snapshot, get().privateState?.playerId) });
    },
    setPrivateState: (privateState) => {
      set({ privateState });
      const currentSnapshot = get().snapshot;
      if (currentSnapshot && privateState?.playerId) {
        set(noticeUpdate(currentSnapshot, privateState.playerId));
      }
    },
    subscribeLobby: async () => {
      await ws.send("lobby.subscribeRooms", {});
    },

    createRoom: (params, signal) =>
      runtime.enter(async () => {
        return ws.send("room.create", params);
      }, signal),

    joinRoom: (roomId, userName, password, signal) =>
      runtime.enter(async () => {
        return ws.send("room.join", { userName, password }, { roomId });
      }, signal),

    reconnectRoom: (roomId, signal) => {
      const token = getSessionToken(roomId);
      if (!token) return Promise.resolve(false);
      return runtime.restore(
        `${roomId}:${token}`,
        async () => {
          const res = await ws.send("room.reconnect", {
            roomId,
            sessionToken: token,
          });
          return { ...res, previousToken: token };
        },
        (error) => {
          if (!isPermanentRoomError(error)) return false;
          if (getSessionToken(roomId) === token) clearSessionToken(roomId);
          const current = get();
          const inThisRoom = current.roomId === roomId && current.sessionToken === token;
          if (inThisRoom) current.leaveRoomState();
          if (inThisRoom || roomIsGone(error)) current.markRoomClosed();
          get().showToast(permanentRoomErrorMessage(error), "error");
          return true;
        },
        signal
      );
    },

    leaveRoom: async () => {
      runtime.cancelEntry();
      const { roomId, sessionToken } = get();
      if (!roomId) return;
      try {
        await ws.send("room.leave", {}, { roomId, sessionToken: sessionToken ?? undefined });
      } catch {
        // 忽略离开房间失败
      } finally {
        // 退房在房间页卸载后才发出，回包慢时玩家可能已经进了下一个房间：只清掉发起这次退房的会话，
        // 已离开房间的旧凭据照常删掉，免得下次重连拿着失效凭据先报一次错。
        const current = get();
        if (current.roomId === roomId && current.sessionToken === sessionToken) {
          clearSessionToken(roomId);
          current.leaveRoomState();
        } else if (sessionToken && getSessionToken(roomId) === sessionToken) {
          clearSessionToken(roomId);
        }
      }
    },

    sendCommand: runtime.sendCommand,
  };
});

/** 玩法对外的连接入口：幂等门闩、事件分发与清理都在运行时里。 */
export function initWhoIsFakerWs() {
  return runtime.init();
}
