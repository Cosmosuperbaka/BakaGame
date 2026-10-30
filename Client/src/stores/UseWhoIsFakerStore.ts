import { create } from "zustand";
import { createRoomEntry } from "@/lib/RoomEntry";
import { permanentRoomErrorMessage } from "@/lib/PermanentRoomError";
import * as ws from "@/lib/WhoIsFakerWs";
import { consumeStateSync } from "@/lib/StateSync";
import { saveSessionToken, getSessionToken, clearSessionToken } from "@/lib/Storage";
import {
  isPermanentRoomError,
  mergeChatWindow,
  CLIENT_CHAT_WINDOW,
  type WhoIsFakerRoomEnterAck,
  type WhoIsFakerRoomSnapshot,
  type WhoIsFakerPrivateState,
  type WhoIsFakerRoomSummary,
  type AgentFocusEvent,
  type ServerMessage,
  type EventPacket,
  SERVER_SHUTDOWN_MESSAGE,
} from "@bakagame/shared";

export interface ToastItem {
  id: number;
  text: string;
  type: "info" | "error" | "success";
}

type WhoIsFakerChatMessage = WhoIsFakerRoomSnapshot["chat"][number];

export interface WhoIsFakerGameState {
  connected: boolean;
  /** 本次连接已收到首个房间列表；断线复位。大厅据此区分「加载中」与「暂无房间」。 */
  lobbyReady: boolean;
  rooms: WhoIsFakerRoomSummary[];
  roomId: string | null;
  sessionToken: string | null;
  snapshot: WhoIsFakerRoomSnapshot | null;
  privateState: WhoIsFakerPrivateState | null;
  agentFocus: AgentFocusEvent | null;
  /** 队列：可同时显示多条，与猜歌 / CEE 的单槽提示相对。 */
  toasts: ToastItem[];
  /**
   * 本机生成的频道切换提示（进入观战频道 / 返回公共频道）。
   * 与 `snapshot` 分开存：快照只放服务端下发的投影，本地提示混进去就分不清哪些是房间事实；
   * 展示时由 `withChannelNotices` 按时间并入聊天列表。
   */
  channelNotices: WhoIsFakerChatMessage[];
  /**
   * 房间被服务端关闭的时刻。房间页据此立刻退回大厅：
   * 关闭是一次明确的服务端事件，不能靠「没有快照」这种同时也匹配初次挂载的推断来判断。
   */
  roomClosedAt: number | null;
  phaseTimedOutEndsAt: number | null;

  // Actions
  setConnected: (connected: boolean) => void;
  setRooms: (rooms: WhoIsFakerRoomSummary[]) => void;
  joinRoomState: (roomId: string, sessionToken: string) => void;
  leaveRoomState: () => void;
  markRoomClosed: () => void;
  clearRoomClosed: () => void;
  triggerPhaseTimeout: () => void;
  setSnapshot: (snapshot: WhoIsFakerRoomSnapshot | null) => void;
  applyIncomingSnapshot: (snapshot: WhoIsFakerRoomSnapshot | null) => void;
  setPrivateState: (privateState: WhoIsFakerPrivateState | null) => void;
  setAgentFocus: (focus: AgentFocusEvent | null) => void;
  addToast: (text: string, type?: "info" | "error" | "success", durationMs?: number) => void;
  removeToast: (id: number) => void;

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
  sendCommand: ws.WhoIsFakerSendCommand;
}

/**
 * 进房凭据：服务端 ack 的字段（`WhoIsFakerRoomEnterAck`）加上客户端自己补的 `previousToken`。
 * 快照与私有态不在 ack 里，只由 event 下发，见下方 `apply` 取 `syncedSnapshot` 的那条路径。
 */
type RoomEntryReceipt = WhoIsFakerRoomEnterAck & { previousToken?: string | null };

let connectionGeneration = 0;
let roomEntry: ReturnType<typeof createRoomEntry<RoomEntryReceipt>>;
let toastCounter = 0;
let snapshotRevision: number | undefined;
let privateStateRevision: number | undefined;
let syncRequestPending = false;
let syncedSnapshot: WhoIsFakerRoomSnapshot | null = null;
let syncedPrivateState: WhoIsFakerPrivateState | null = null;

export const resetWhoIsFakerStateSync = () => {
  snapshotRevision = undefined;
  privateStateRevision = undefined;
  syncRequestPending = false;
  syncedSnapshot = null;
  syncedPrivateState = null;
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
  const isDeadOrSpectator = me.roundStatus === "dead" || me.roundStatus === "spectator";
  return isDeadOrSpectator ? "ghost" : "main";
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
  createdAt: Date.now(),
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

const requestFullSync = () => {
  if (syncRequestPending) return;
  syncRequestPending = true;
  void useWhoIsFakerStore
    .getState()
    .sendCommand("room.requestSync")
    .catch(() => {})
    .finally(() => {
      syncRequestPending = false;
    });
};

export const useWhoIsFakerStore = create<WhoIsFakerGameState>((set, get) => {
  const entry = (roomEntry = createRoomEntry<RoomEntryReceipt>({
    generation: () => connectionGeneration,
    begin: resetWhoIsFakerStateSync,
    apply: (receipt) => {
      saveSessionToken(receipt.roomId, receipt.sessionToken);
      const snapshot = syncedSnapshot?.roomId === receipt.roomId ? syncedSnapshot : undefined;
      const privateState =
        syncedPrivateState?.sessionToken === receipt.sessionToken ? syncedPrivateState : undefined;
      get().joinRoomState(receipt.roomId, receipt.sessionToken);
      if (snapshot) get().setSnapshot(snapshot);
      if (privateState) get().setPrivateState(privateState);
    },
    discard: async (receipt) => {
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
        resetWhoIsFakerStateSync();
        const current = get();
        if (
          current.roomId === null ||
          (current.roomId === receipt.roomId && current.sessionToken === receipt.sessionToken)
        )
          current.leaveRoomState();
      }
    },
  }));
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
    connected: false,
    lobbyReady: false,
    rooms: [],
    roomId: null,
    sessionToken: null,
    snapshot: null,
    privateState: null,
    agentFocus: null,
    toasts: [],
    channelNotices: [],
    roomClosedAt: null,
    phaseTimedOutEndsAt: null,

    setConnected: (connected) => set(connected ? { connected } : { connected, lobbyReady: false }),
    setRooms: (rooms) => set({ rooms, lobbyReady: true }),
    joinRoomState: (roomId, sessionToken) => {
      const changedRoom = get().roomId !== roomId;
      if (changedRoom) resetWhoIsFakerStateSync();
      set({
        roomId,
        sessionToken,
        roomClosedAt: null,
        phaseTimedOutEndsAt: null,
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
        agentFocus: null,
        channelNotices: [],
        phaseTimedOutEndsAt: null,
        roomClosedAt: null,
      });
    },
    markRoomClosed: () => set({ roomClosedAt: Date.now() }),
    clearRoomClosed: () => set({ roomClosedAt: null }),
    triggerPhaseTimeout: () => {
      const timer = get().snapshot?.status.phaseTimer;
      set({ phaseTimedOutEndsAt: timer?.endsAt ?? Date.now() });
    },
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
    applyIncomingSnapshot: (snapshot) => get().setSnapshot(snapshot),
    setPrivateState: (privateState) => {
      set({ privateState });
      const currentSnapshot = get().snapshot;
      if (currentSnapshot && privateState?.playerId) {
        set(noticeUpdate(currentSnapshot, privateState.playerId));
      }
    },
    setAgentFocus: (agentFocus) => set({ agentFocus }),
    addToast: (text, type = "info", durationMs = 3000) => {
      const id = ++toastCounter;
      set((state) => ({ toasts: [...state.toasts, { id, text, type }] }));
      setTimeout(() => get().removeToast(id), durationMs);
    },

    removeToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

    subscribeLobby: async () => {
      await ws.send("lobby.subscribeRooms", {});
    },

    createRoom: (params, signal) =>
      entry.enter(async () => {
        return ws.send("room.create", params);
      }, signal),

    joinRoom: (roomId, userName, password, signal) =>
      entry.enter(async () => {
        return ws.send("room.join", { userName, password }, { roomId });
      }, signal),

    reconnectRoom: (roomId, signal) => {
      const token = getSessionToken(roomId);
      if (!token) return Promise.resolve(false);
      return entry.restore(
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
          if (current.roomId === roomId && current.sessionToken === token) {
            current.leaveRoomState();
            current.markRoomClosed();
          }
          get().addToast(permanentRoomErrorMessage(error), "error");
          return true;
        },
        signal
      );
    },

    leaveRoom: async () => {
      entry.cancel();
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

export function initWhoIsFakerWs() {
  const unsubMsg = ws.onMessage((msg: ServerMessage) => {
    if (msg.type !== "event") return;
    const evt = msg as EventPacket;
    const currentStore = useWhoIsFakerStore.getState();

    switch (evt.event) {
      case "lobby.rooms":
        currentStore.setRooms(evt.payload as WhoIsFakerRoomSummary[]);
        break;
      case "room.snapshot":
        {
          const result = consumeStateSync(
            syncedSnapshot ?? currentStore.snapshot,
            snapshotRevision,
            evt.payload
          );
          if (result.needsFullSync || !result.state) {
            requestFullSync();
            break;
          }
          snapshotRevision = result.revision;
          syncedSnapshot = result.state as WhoIsFakerRoomSnapshot;
          if (!roomEntry.isPending()) currentStore.setSnapshot(syncedSnapshot);
        }
        break;
      case "mcp.focus":
        currentStore.setAgentFocus(evt.payload as AgentFocusEvent);
        break;
      case "game.privateState":
        {
          const result = consumeStateSync(
            syncedPrivateState ?? currentStore.privateState,
            privateStateRevision,
            evt.payload
          );
          if (result.needsFullSync || !result.state) {
            requestFullSync();
            break;
          }
          privateStateRevision = result.revision;
          syncedPrivateState = result.state as WhoIsFakerPrivateState;
          if (!roomEntry.isPending()) currentStore.setPrivateState(syncedPrivateState);
        }
        break;
      case "game.disconnectDecisionRequested":
        currentStore.addToast("有玩家掉线，等待主持人处理", "info");
        break;
      case "room.expiring":
        currentStore.addToast("房间即将因超时关闭", "error");
        break;
      case "room.closed": {
        roomEntry.cancel();
        // 房间已在服务端删除，残留的会话令牌只会让下次进房重连一个不存在的房间。
        const payload = evt.payload as { roomId?: string };
        const closedRoomId = payload.roomId ?? currentStore.roomId;
        if (closedRoomId) clearSessionToken(closedRoomId);
        currentStore.leaveRoomState();
        currentStore.markRoomClosed();
        currentStore.addToast("房间已关闭", "error");
        break;
      }
      case "session.replaced": {
        const payload = evt.payload as { roomId?: string };
        const roomId = payload.roomId;

        if (roomId && currentStore.roomId === roomId) {
          roomEntry.cancel();
          clearSessionToken(roomId);
          currentStore.leaveRoomState();
          // 席位已被新标签页接管，本标签页同样必须退回大厅。
          currentStore.markRoomClosed();
        }
        currentStore.addToast("您的连接已被新标签页替代", "error");
        break;
      }
      case "server.shutdown": {
        roomEntry.cancel();
        const payload = evt.payload as { message?: string } | undefined;
        const message = payload?.message || SERVER_SHUTDOWN_MESSAGE;
        // 原地待命：不清票据、不退房。服务端停机前会把房间落盘，连接恢复后
        // onStatus 会带原 sessionToken 自动 reconnectRoom 回到原位；
        // 若那局已被丢弃（旧版本服务或停机过久），那一步会收到 SESSION_NOT_FOUND
        // 并走既有的失效分支。这里提前清票据才是真的回不去了。
        currentStore.addToast(message, "error", 10000);
        break;
      }
    }
  });

  const unsubStatus = ws.onStatus((connected) => {
    if (!connected) connectionGeneration += 1;
    const currentStore = useWhoIsFakerStore.getState();
    currentStore.setConnected(connected);

    if (connected) {
      snapshotRevision = undefined;
      privateStateRevision = undefined;
      syncedSnapshot = null;
      ws.send("lobby.subscribeRooms", {}).catch(() => {});
      if (currentStore.roomId && currentStore.sessionToken) {
        saveSessionToken(currentStore.roomId, currentStore.sessionToken);
        void currentStore.reconnectRoom(currentStore.roomId).catch(() => {});
      }
    }
  });

  ws.connect();

  return () => {
    unsubMsg();
    unsubStatus();
    connectionGeneration += 1;
    ws.disconnect();
    resetWhoIsFakerStateSync();
    useWhoIsFakerStore.getState().setConnected(false);
  };
}
