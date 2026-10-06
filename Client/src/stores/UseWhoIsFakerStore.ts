import { create } from "zustand";
import { createRoomEntry } from "@/lib/RoomEntry";
import * as ws from "@/lib/WhoIsFakerWs";
import { consumeStateSync } from "@/lib/StateSync";
import {
  saveSessionToken,
  getSessionToken,
  clearSessionToken,
} from "@/lib/Storage";
import type {
  WhoIsFakerRoomSnapshot,
  WhoIsFakerPrivateState,
  WhoIsFakerRoomSummary,
  ServerMessage,
  EventPacket,
  DaybreakNotice,
} from "@/types";
import { SERVER_SHUTDOWN_MESSAGE } from "@/types";

export interface ToastItem {
  id: number;
  text: string;
  type: "info" | "error" | "success";
}

export interface WhoIsFakerGameState {
  connected: boolean;
  /** 本次连接已收到首个房间列表；断线复位。大厅据此区分「加载中」与「暂无房间」。 */
  lobbyReady: boolean;
  rooms: WhoIsFakerRoomSummary[];
  roomId: string | null;
  sessionToken: string | null;
  snapshot: WhoIsFakerRoomSnapshot | null;
  privateState: WhoIsFakerPrivateState | null;
  phaseResultPresentationPending: boolean;
  daybreakNotice: DaybreakNotice | null;
  toasts: ToastItem[];
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
  showDaybreakNotice: (notice: DaybreakNotice) => void;
  addToast: (text: string, type?: "info" | "error" | "success", durationMs?: number) => void;
  removeToast: (id: number) => void;


  // Async Business Actions
  subscribeLobby: () => Promise<void>;
  createRoom: (params: {
    roomId: string;
    name: string;
    visibility: "public" | "private";
    password?: string;
    allowSpectators: boolean;
    userName: string;
  }, signal?: AbortSignal) => Promise<void>;
  joinRoom: (roomId: string, userName: string, password?: string, signal?: AbortSignal) => Promise<void>;
  reconnectRoom: (roomId: string, signal?: AbortSignal) => Promise<boolean>;
  leaveRoom: () => Promise<void>;
  sendCommand: (type: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}


type RoomEntryReceipt = {
  roomId: string;
  sessionToken: string;
  snapshot?: WhoIsFakerRoomSnapshot;
  privateState?: WhoIsFakerPrivateState;
  previousToken?: string | null;
};

let connectionGeneration = 0;
let roomEntry: ReturnType<typeof createRoomEntry<RoomEntryReceipt>>;
let toastCounter = 0;
let daybreakNoticeTimer: ReturnType<typeof setTimeout> | undefined;
let snapshotRevision: number | undefined;
let privateStateRevision: number | undefined;
let syncRequestPending = false;
let syncedSnapshot: WhoIsFakerRoomSnapshot | null = null;
let syncedPrivateState: WhoIsFakerPrivateState | null = null;
let pendingGameOverSnapshot: WhoIsFakerRoomSnapshot | null = null;
let phaseResultVisibleUntil = 0;
let phaseResultTimer: ReturnType<typeof setTimeout> | undefined;

export const resetWhoIsFakerStateSync = () => {
  snapshotRevision = undefined;
  privateStateRevision = undefined;
  syncRequestPending = false;
  syncedSnapshot = null;
  syncedPrivateState = null;
  clearPhaseResultPresentation();
};

const PHASE_RESULT_DISPLAY_MS = 1500;

const clearPhaseResultPresentation = () => {
  if (phaseResultTimer) clearTimeout(phaseResultTimer);
  phaseResultTimer = undefined;
  pendingGameOverSnapshot = null;
  phaseResultVisibleUntil = 0;
};

const MAX_CHAT_MESSAGES = 200;

const mergeChat = (
  existing: WhoIsFakerRoomSnapshot["chat"] = [],
  incoming: WhoIsFakerRoomSnapshot["chat"] = [],
): WhoIsFakerRoomSnapshot["chat"] => {
  const map = new Map<string, WhoIsFakerRoomSnapshot["chat"][number]>();
  for (const msg of existing) {
    map.set(msg.id, msg);
  }
  for (const msg of incoming) {
    map.set(msg.id, msg);
  }
  return Array.from(map.values()).sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_CHAT_MESSAGES);
};

const isSameRound = (left: WhoIsFakerRoomSnapshot | null, right: WhoIsFakerRoomSnapshot) =>
  Boolean(
    left &&
    left.roomId === right.roomId &&
    left.status.roundId &&
    left.status.roundId === right.status.roundId,
  );

const hasNewElimination = (previous: WhoIsFakerRoomSnapshot, next: WhoIsFakerRoomSnapshot) => {
  const previousStatuses = new Map(
    previous.players.map((player) => [player.id, player.roundStatus]),
  );
  return next.players.some(
    (player) =>
      player.roundStatus === "dead" && previousStatuses.get(player.id) !== "dead",
  );
};

const isPermanentRoomError = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code;
  return code === "ROOM_NOT_FOUND" || code === "SESSION_NOT_FOUND" ||
    code === "SESSION_INVALID" || code === "PLAYER_KICKED";
};

let lastPlayerChannel: "main" | "ghost" | undefined;
let lastRoomAndRoundKey: string | undefined;

const computePlayerChannel = (
  snapshot: WhoIsFakerRoomSnapshot | null,
  playerId: string | null | undefined,
): "main" | "ghost" => {
  if (!snapshot || !playerId) return "main";
  const isIngame = Boolean(
    snapshot.status.started &&
    ["description", "voting", "tieBreak", "night", "blankGuess"].includes(snapshot.status.phase),
  );
  if (!isIngame) return "main";
  const isQuestioner = snapshot.status.questionerPlayerId === playerId;
  if (isQuestioner) return "main";
  const me = snapshot.players.find((p) => p.id === playerId);
  if (!me) return "main";
  const isDeadOrSpectator = me.roundStatus === "dead" || me.roundStatus === "spectator";
  return isDeadOrSpectator ? "ghost" : "main";
};

const applyChannelTransitions = (
  snapshot: WhoIsFakerRoomSnapshot,
  playerId: string | null | undefined,
): WhoIsFakerRoomSnapshot => {
  if (!playerId) return snapshot;
  const currentKey = `${snapshot.roomId}:${snapshot.status.roundId ?? snapshot.status.phase ?? "lobby"}`;
  const nextChannel = computePlayerChannel(snapshot, playerId);

  if (lastRoomAndRoundKey !== currentKey) {
    lastRoomAndRoundKey = currentKey;
    lastPlayerChannel = nextChannel;
    if (nextChannel === "ghost") {
      const notice: WhoIsFakerRoomSnapshot["chat"][number] = {
        id: `local-chan-init-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        playerId: "system",
        playerName: "系统",
        text: "已进入观战频道，发言仅对淘汰玩家与观战者可见",
        createdAt: Date.now(),
        system: true,
        channel: "ghost",
      };
      return { ...snapshot, chat: mergeChat(snapshot.chat, [notice]) };
    }
    return snapshot;
  }

  if (lastPlayerChannel && lastPlayerChannel !== nextChannel) {
    const noticeText =
      nextChannel === "ghost"
        ? "已进入观战频道，发言仅对淘汰玩家与观战者可见"
        : "已返回公共聊天频道，所有玩家均可见发言";
    const notice: WhoIsFakerRoomSnapshot["chat"][number] = {
      id: `local-chan-trans-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      playerId: "system",
      playerName: "系统",
      text: noticeText,
      createdAt: Date.now(),
      system: true,
      channel: nextChannel,
    };
    lastPlayerChannel = nextChannel;
    return { ...snapshot, chat: mergeChat(snapshot.chat, [notice]) };
  }

  lastPlayerChannel = nextChannel;
  return snapshot;
};

const requestFullSync = () => {
  if (syncRequestPending) return;
  syncRequestPending = true;
  void useWhoIsFakerStore.getState().sendCommand("room.requestSync")
    .catch(() => {})
    .finally(() => {
      syncRequestPending = false;
    });
};

export const useWhoIsFakerStore = create<WhoIsFakerGameState>((set, get) => {
  const entry = roomEntry = createRoomEntry<RoomEntryReceipt>({
    generation: () => connectionGeneration,
    begin: resetWhoIsFakerStateSync,
    apply: (receipt) => {
      saveSessionToken(receipt.roomId, receipt.sessionToken);
      const snapshot = receipt.snapshot ?? (syncedSnapshot?.roomId === receipt.roomId ? syncedSnapshot : undefined);
      const privateState = receipt.privateState ?? (syncedPrivateState?.sessionToken === receipt.sessionToken ? syncedPrivateState : undefined);
      get().joinRoomState(receipt.roomId, receipt.sessionToken);
      if (snapshot) get().setSnapshot(snapshot);
      if (privateState) get().setPrivateState(privateState);
    },
    discard: async (receipt) => {
      try { await ws.send("room.leave", {}, { roomId: receipt.roomId, sessionToken: receipt.sessionToken }); }
      finally {
        const token = getSessionToken(receipt.roomId);
        if (token === receipt.sessionToken || (receipt.previousToken && token === receipt.previousToken)) clearSessionToken(receipt.roomId);
        resetWhoIsFakerStateSync();
        const current = get();
        if (current.roomId === null || (current.roomId === receipt.roomId && current.sessionToken === receipt.sessionToken)) current.leaveRoomState();
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
  phaseResultPresentationPending: false,
  daybreakNotice: null,
  toasts: [],
  roomClosedAt: null,
  phaseTimedOutEndsAt: null,

  setConnected: (connected) => set(connected ? { connected } : { connected, lobbyReady: false }),
  setRooms: (rooms) => set({ rooms, lobbyReady: true }),
  joinRoomState: (roomId, sessionToken) => {
    if (get().roomId !== roomId) {
      resetWhoIsFakerStateSync();
      set({ phaseResultPresentationPending: false });
    }
    set({ roomId, sessionToken, roomClosedAt: null, phaseTimedOutEndsAt: null });
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
      phaseResultPresentationPending: false,
      daybreakNotice: null,
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
      clearPhaseResultPresentation();
      set({ snapshot: null, phaseResultPresentationPending: false });
      return;
    }
    const previousSnapshot = get().snapshot;
    const summarySource = pendingGameOverSnapshot ?? previousSnapshot;
    const previousSummary =
      incomingSnapshot.status.phase === "gameOver" &&
      !incomingSnapshot.summary &&
      summarySource?.status.roundId === incomingSnapshot.status.roundId
        ? summarySource?.summary
        : undefined;
    let snapshot = previousSummary
      ? { ...incomingSnapshot, summary: previousSummary }
      : incomingSnapshot;
    snapshot = { ...snapshot, chat: snapshot.chat.slice(-MAX_CHAT_MESSAGES) };

    if (previousSnapshot && previousSnapshot.roomId === snapshot.roomId) {
      snapshot = { ...snapshot, chat: mergeChat(previousSnapshot.chat, snapshot.chat) };
    }

    snapshot = applyChannelTransitions(snapshot, get().privateState?.playerId);

    if (!isSameRound(previousSnapshot, snapshot)) {
      clearPhaseResultPresentation();
      set({ snapshot, phaseResultPresentationPending: false });
      return;
    }

    if (
      previousSnapshot &&
      previousSnapshot.status.phase !== "gameOver" &&
      snapshot.status.phase !== "gameOver" &&
      hasNewElimination(previousSnapshot, snapshot)
    ) {
      phaseResultVisibleUntil = Date.now() + PHASE_RESULT_DISPLAY_MS;
    }

    if (
      previousSnapshot?.status.phase !== "gameOver" &&
      snapshot.status.phase === "gameOver" &&
      phaseResultVisibleUntil > Date.now()
    ) {
      pendingGameOverSnapshot = snapshot;
      set({ phaseResultPresentationPending: true });
      if (!phaseResultTimer) {
        phaseResultTimer = setTimeout(() => {
          phaseResultTimer = undefined;
          phaseResultVisibleUntil = 0;
          const pendingSnapshot = pendingGameOverSnapshot;
          pendingGameOverSnapshot = null;
          if (!pendingSnapshot) return;

          set((state) =>
            isSameRound(state.snapshot, pendingSnapshot)
              ? { snapshot: pendingSnapshot, phaseResultPresentationPending: false }
              : state,
          );
        }, phaseResultVisibleUntil - Date.now());
      }
      return;
    }

    if (snapshot.status.phase !== "gameOver" && pendingGameOverSnapshot) {
      clearPhaseResultPresentation();
      set({ phaseResultPresentationPending: false });
    }
    set({
      snapshot,
      phaseResultPresentationPending: snapshot.status.phase === "gameOver"
        ? false
        : get().phaseResultPresentationPending,
    });
  },
  applyIncomingSnapshot: (snapshot) => get().setSnapshot(snapshot),
  setPrivateState: (privateState) => {
    set({ privateState });
    const currentSnapshot = get().snapshot;
    if (currentSnapshot && privateState?.playerId) {
      const updated = applyChannelTransitions(currentSnapshot, privateState.playerId);
      if (updated !== currentSnapshot) {
        set({ snapshot: updated });
      }
    }
  },
  showDaybreakNotice: (notice) => {
    if (daybreakNoticeTimer) clearTimeout(daybreakNoticeTimer);
    set({ daybreakNotice: notice });
    daybreakNoticeTimer = setTimeout(() => {
      set({ daybreakNotice: null });
      daybreakNoticeTimer = undefined;
    }, 4500);
  },
  addToast: (text, type = "info", durationMs = 3000) => {
    const id = ++toastCounter;
    set((state) => ({ toasts: [...state.toasts, { id, text, type }] }));
    setTimeout(() => get().removeToast(id), durationMs);
  },

  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  subscribeLobby: async () => {
    await ws.send("lobby.subscribeRooms");
  },

  createRoom: (params, signal) => entry.enter(async () => {
    const res = await ws.send<RoomEntryReceipt>("room.create", params);
    return { ...res, roomId: res.roomId ?? params.roomId };
  }, signal),

  joinRoom: (roomId, userName, password, signal) => entry.enter(async () => {
    const res = await ws.send<RoomEntryReceipt>("room.join", { userName, password }, { roomId });
    return { ...res, roomId: res.roomId ?? roomId };
  }, signal),

  reconnectRoom: (roomId, signal) => {
    const token = getSessionToken(roomId);
    if (!token) return Promise.resolve(false);
    return entry.restore(`${roomId}:${token}`, async () => {
      const res = await ws.send<RoomEntryReceipt>("room.reconnect", { roomId, sessionToken: token });
      return { ...res, roomId: res.roomId ?? roomId, previousToken: token };
    }, (error) => {
      if (!isPermanentRoomError(error)) return false;
      if (getSessionToken(roomId) === token) clearSessionToken(roomId);
      const current = get();
      if (current.roomId === roomId && current.sessionToken === token) {
        current.leaveRoomState();
        current.markRoomClosed();
      }
      const code = (error as { code?: string } | null)?.code;
      const message = code === "SESSION_NOT_FOUND" || code === "SESSION_INVALID"
        ? "会话已失效，请重新加入" : code === "PLAYER_KICKED" ? "你已被移出房间" : "房间已解散或不存在";
      get().addToast(message, "error");
      return true;
    }, signal);
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

  sendCommand: async (type, payload = {}) => {
    if (get().phaseResultPresentationPending) {
      throw new Error("阶段结果展示中，请稍候");
    }
    const { roomId, sessionToken } = get();
    return ws.send(type, payload, {
      roomId: roomId ?? undefined,
      sessionToken: sessionToken ?? undefined,
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
            evt.payload,
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
      case "game.privateState":
        {
          const result = consumeStateSync(
            syncedPrivateState ?? currentStore.privateState,
            privateStateRevision,
            evt.payload,
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
      case "game.daybreak":
        currentStore.showDaybreakNotice(evt.payload as DaybreakNotice);
        break;
      case "game.voteResult":
        currentStore.addToast("投票结果已公布");
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
        const closedRoomId = currentStore.roomId;
        if (closedRoomId) clearSessionToken(closedRoomId);
        currentStore.leaveRoomState();
        currentStore.markRoomClosed();
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
      ws.send("lobby.subscribeRooms").catch(() => {});
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
    ws.whoIsFakerWsClient.disconnect();
    resetWhoIsFakerStateSync();
    useWhoIsFakerStore.getState().setConnected(false);
  };
}
