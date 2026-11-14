import { resolveEndedRoom } from "./room/RoomEndedEvent";
import { createToastSlice, type ToastState } from "./room/ToastSlice";
import { create } from "zustand";
import type {
  CEEPayload,
  CEEPrivateState,
  CEEResponse,
  CEERoomEnterResult,
  CEERoomSnapshot,
  CEERoomSummary,
  CEESource,
  ServerMessage,
} from "@bakagame/shared";
import { isPermanentRoomError, protocolErrorCode } from "@bakagame/shared/values";
import * as ws from "@/lib/CEEWs";
import type { GameSendCommand } from "@/lib/GameWs";
import {
  normalizeCEERoomId,
  readCEESession,
  removeCEESession,
  writeCEESession,
} from "@/lib/CEESession";
import {
  SPECTATE_APPROVED_TEXT,
  SPECTATE_REJECTED_TEXT,
  antiCheatMessage,
  isLoginRequiredCode,
} from "@/lib/AntiCheatCopy";
import { permanentRoomErrorMessage, roomIsGone } from "@/lib/PermanentRoomError";
import { createRoomEntry } from "@/lib/RoomEntry";
import { createQueryReuseCache, keywordQueryKey, type QueryReuseCache } from "@/lib/QueryReuse";
import { createStateSyncChannel } from "./room/StateSyncChannel";
import { playSound } from "@/lib/SoundEffects";
import { isProtocolError } from "@/lib/WebsocketClient";

/**
 * CEE 只读查询的结果复用窗口，语义见 `lib/QueryReuse`。
 *
 * 覆盖「搜角色 / 搜作品 / 取某作品的登场角色」三条：翻看候选时来回比对、
 * 切换作品再切回来，都会重复提交同一串输入。
 */
const ceeCharacterSearchCache =
  createQueryReuseCache<CEEResponse<"cee.character.search">["results"]>(keywordQueryKey);
const ceeSubjectSearchCache =
  createQueryReuseCache<CEEResponse<"cee.subject.search">["results"]>(keywordQueryKey);
const ceeSubjectCharactersCache =
  createQueryReuseCache<CEEResponse<"cee.subject.characters">["results"]>(keywordQueryKey);

/** 清空 CEE 复用窗口；测试用它隔离用例，运行期无需调用（查询结果与房间无关）。 */
export function clearCEEQueryCache() {
  ceeCharacterSearchCache.clear();
  ceeSubjectSearchCache.clear();
  ceeSubjectCharactersCache.clear();
}

export interface CEEStore extends ToastState {
  connected: boolean;
  lobbyReady: boolean;
  originalAvailable: boolean;
  rooms: CEERoomSummary[];
  source: CEESource | null;
  roomId: string | null;
  sessionToken: string | null;
  snapshot: CEERoomSnapshot | null;
  privateState: CEEPrivateState | null;
  roomClosedAt: number | null;
  /** 最近一次要求登录的时刻；CEELayout 监听它去打开登录弹窗。0 表示没有待办请求。 */
  requestLoginAt: number;
  /** 统一处理命令/同步失败：按错误码取文案弹提示，LOGIN_REQUIRED 顺带请求打开登录弹窗。 */
  reportError: (error: unknown) => void;
  /** 请求打开登录弹窗（网页环境下客户端探测不到身份时由服务端拒绝触发）。 */
  promptLogin: () => void;
  subscribeLobby: () => Promise<void>;
  createRoom: (payload: CEEPayload<"cee.room.create">, signal?: AbortSignal) => Promise<void>;
  joinRoom: (
    roomId: string,
    userName: string,
    password?: string,
    signal?: AbortSignal
  ) => Promise<void>;
  reconnectRoom: (roomId: string, signal?: AbortSignal) => Promise<boolean>;
  leaveRoom: () => Promise<void>;
  /** 作废在途的入房/恢复事务，但不改动当前房间状态（供房间结束类事件调用）。 */
  cancelEntry: () => void;
  resetRoom: (closed?: boolean) => void;
  /** 清掉「房间已结束」标记；页面挂载与卸载时各调一次，避免旧标记把下次进入立刻弹回大厅。 */
  clearRoomClosed: () => void;
  sendCommand: GameSendCommand<ws.CEECommandMap>;
  /** 搜角色；同一关键词在复用窗口内不会重复请求上游。 */
  searchCharacters: (keyword: string) => Promise<CEEResponse<"cee.character.search">["results"]>;
  /** 搜作品；同一关键词在复用窗口内不会重复请求上游。 */
  searchSubjects: (keyword: string) => Promise<CEEResponse<"cee.subject.search">["results"]>;
  /** 取某作品的登场角色；切走再切回同一作品时复用上次结果。 */
  loadSubjectCharacters: (
    subjectId: CEEPayload<"cee.subject.characters">["subjectId"]
  ) => Promise<CEEResponse<"cee.subject.characters">["results"]>;
}

let connectionGeneration = 0;
let roomEntry: ReturnType<typeof createRoomEntry<CEERoomEnterResult>>;

const stateSync = createStateSyncChannel<CEERoomSnapshot, CEEPrivateState>({
  requestFull: () => useCEEStore.getState().sendCommand("cee.room.requestSync", {}),
  // 凭据未写回时抢发全量，信封不带凭据，原版会话校验必判 SESSION_INVALID，
  // 还会连带触发永久错误处理清掉刚建立的会话；只记欠账，等 enter() 写回凭据后补发。
  defer: () => roomEntry.isPending() && !useCEEStore.getState().sessionToken,
  onError: (error) => useCEEStore.getState().reportError(error),
});
/**
 * 恢复失败即放弃本地会话的错误码：共享永久码表，加上 CEE 原版房自己的会话过期码。
 * 共享部分不在这里再抄一份——抄的那份迟早会漏掉或多出服务端根本不发的码。
 */
const isPermanentCEEError = (error: unknown): boolean =>
  isPermanentRoomError(error) || protocolErrorCode(error) === "SESSION_EXPIRED";

export function resetCEEStateSync() {
  stateSync.reset();
}

export const ceeErrorMessage = (error: unknown): string => {
  if (isProtocolError(error)) return antiCheatMessage(error.code) ?? error.message;
  if (error instanceof Error) return error.message;
  return "操作失败，请重试";
};

export const useCEEStore = create<CEEStore>((set, get) => {
  const enter = (result: CEERoomEnterResult) => {
    // 先取走「进入期间被压下的同步欠账」——reset 会清掉它。
    const deferred = stateSync.takeDeferred();
    const rawSnapshot = stateSync.snapshot.baseline();
    const sameRoom = rawSnapshot?.roomId === result.roomId && rawSnapshot.source === result.source;
    if (!sameRoom) {
      stateSync.reset();
      stateSync.snapshot.adopt(result.snapshot);
      stateSync.privateState.adopt(result.privateState);
    }
    writeCEESession(result.roomId, result.sessionToken);
    set({
      source: result.source,
      roomId: result.roomId,
      sessionToken: result.sessionToken,
      snapshot: stateSync.snapshot.baseline(),
      privateState: stateSync.privateState.baseline() ?? result.privateState,
      roomClosedAt: null,
    });
    // 进入房间期间若收到过无法应用的状态补丁，此刻凭据已就绪，补一次全量同步。
    if (deferred) stateSync.flushDeferred();
  };
  const entry = (roomEntry = createRoomEntry<CEERoomEnterResult>({
    generation: () => connectionGeneration,
    begin: resetCEEStateSync,
    apply: enter,
    discard: async (result) => {
      // ACK 已建立服务器会话，但页面不再拥有该意图：用 ACK 凭据释放，不写入本地身份。
      const generation = connectionGeneration;
      try {
        await ws.send(
          "cee.room.leave",
          {},
          { roomId: result.roomId, sessionToken: result.sessionToken }
        );
        removeCEESession(result.roomId);
      } finally {
        if (generation === connectionGeneration) get().resetRoom(get().roomClosedAt !== null);
      }
    },
  }));
  /** 只读查询的共用壳：复用窗口 + 取 results，房间身份只由 sendCommand 注入一处。 */
  const query = <TResult>(
    cache: QueryReuseCache<TResult>,
    key: string,
    load: () => Promise<{ results: TResult }>
  ) => cache.run(key, async () => (await load()).results);
  return {
    connected: false,
    lobbyReady: false,
    originalAvailable: false,
    rooms: [],
    source: null,
    roomId: null,
    sessionToken: null,
    snapshot: null,
    privateState: null,
    roomClosedAt: null,
    ...createToastSlice(set, { mode: "slot", defaultType: "error", defaultMs: 5000 }),
    requestLoginAt: 0,
    promptLogin: () => set({ requestLoginAt: Date.now() }),
    reportError: (error) => {
      get().showToast(ceeErrorMessage(error));
      if (isProtocolError(error) && isLoginRequiredCode(error.code)) get().promptLogin();
    },
    subscribeLobby: async () => {
      const generation = connectionGeneration;
      const result = await ws.send("cee.lobby.subscribeRooms", {});
      if (generation !== connectionGeneration) return;
      set({ lobbyReady: true, originalAvailable: result.originalAvailable });
    },
    createRoom: (payload, signal) =>
      entry.enter(() => ws.send("cee.room.create", payload, { timeout: 0 }), signal),
    joinRoom: (roomId, userName, password, signal) =>
      entry.enter(
        () =>
          ws.send(
            "cee.room.join",
            { userName, ...(password ? { password } : {}) },
            { roomId: normalizeCEERoomId(roomId), timeout: 0 }
          ),
        signal
      ),
    reconnectRoom: (roomId, signal) => {
      roomId = normalizeCEERoomId(roomId);
      const token = readCEESession(roomId);
      if (!token) return Promise.resolve(false);
      // 同一恢复意图可由 StrictMode 的新 effect 接管；只有所有所有者都撤销才释放 ACK 会话。
      return entry.restore(
        `${roomId}:${token}`,
        () => ws.send("cee.room.reconnect", { roomId, sessionToken: token }, { timeout: 0 }),
        (error) => {
          if (!isPermanentCEEError(error)) return false;
          removeCEESession(roomId);
          get().resetRoom(roomIsGone(error));
          // 原版房的会话过期码不在共享表里，文案仍用服务端给的那句。
          if (isPermanentRoomError(error)) get().showToast(permanentRoomErrorMessage(error));
          else get().reportError(error);
          return true;
        },
        signal
      );
    },
    leaveRoom: async () => {
      // 退房同时作废在途入房：晚到的 ACK 不能再把刚离开的房间写回本地。
      get().cancelEntry();
      const { roomId } = get();
      try {
        if (roomId) await get().sendCommand("cee.room.leave", {});
      } finally {
        if (roomId) removeCEESession(roomId);
        get().resetRoom();
      }
    },
    resetRoom: (closed = false) => {
      resetCEEStateSync();
      set({
        source: null,
        roomId: null,
        sessionToken: null,
        snapshot: null,
        privateState: null,
        roomClosedAt: closed ? Date.now() : null,
      });
    },
    clearRoomClosed: () => set({ roomClosedAt: null }),
    cancelEntry: () => entry.cancel(),
    sendCommand: (command, payload = {}, options) => {
      const { roomId, sessionToken } = get();
      return ws.send(command, payload, {
        roomId: roomId ?? undefined,
        sessionToken: sessionToken ?? undefined,
        // 取图、目录同步这类直接调用不经命令执行器，超时口径同样只落在策略表一处。
        timeout: options?.timeout ?? ws.CEE_COMMAND_POLICY[command]?.timeout,
      });
    },
    searchCharacters: (keyword) =>
      query(ceeCharacterSearchCache, keyword, () =>
        get().sendCommand("cee.character.search", { keyword })
      ),
    searchSubjects: (keyword) =>
      query(ceeSubjectSearchCache, keyword, () =>
        get().sendCommand("cee.subject.search", { keyword })
      ),
    loadSubjectCharacters: (subjectId) =>
      query(ceeSubjectCharactersCache, String(subjectId), () =>
        get().sendCommand("cee.subject.characters", { subjectId })
      ),
  };
});

function applyCEESnapshotEvent(payload: unknown): void {
  const previous = stateSync.snapshot.baseline();
  const snapshot = stateSync.snapshot.consume(payload);
  // 入房在途的推送只进同步基线：展示态与回合开始音效都等 ACK 落定后一次安装。
  if (!snapshot || roomEntry.isPending()) return;
  useCEEStore.setState({ snapshot });
  // 只有「在房内看着回合数增加并进入猜测」才出声：首次进房、重连补快照都只是恢复现场。
  if (
    previous &&
    previous.roomId === snapshot.roomId &&
    snapshot.roundNumber > previous.roundNumber &&
    snapshot.phase === "guessing"
  ) {
    playSound("roundStart");
  }
}

export function handleCEEMessage(message: ServerMessage) {
  if (message.type !== "event") return;
  const store = useCEEStore.getState();
  if (message.event === "cee.lobby.rooms") {
    useCEEStore.setState({ rooms: message.payload as CEERoomSummary[] });
  } else if (message.event === "cee.room.snapshot") {
    applyCEESnapshotEvent(message.payload);
  } else if (message.event === "cee.game.privateState") {
    const privateState = stateSync.privateState.consume(message.payload);
    if (privateState && !roomEntry.isPending()) useCEEStore.setState({ privateState });
  } else if (message.event === "cee.player.spectateResult") {
    // 房主对旁观请求的显式处理结果只发给请求者；身份本身随快照下发，这里只给一条反馈。
    const approved = (message.payload as { approved?: boolean }).approved === true;
    useCEEStore
      .getState()
      .showToast(
        approved ? SPECTATE_APPROVED_TEXT : SPECTATE_REJECTED_TEXT,
        approved ? "success" : "error"
      );
  } else if (["cee.room.closed", "cee.player.kicked", "session.replaced"].includes(message.event)) {
    // 房间已经结束：在途入房/恢复的 ACK 即使晚到也不能再接回这个会话。
    const payload = message.payload as { roomId?: string; reason?: string; message?: string };
    const { roomId, foreign } = resolveEndedRoom(payload.roomId, store.roomId);
    if (roomId) removeCEESession(roomId);
    // 事件指向别的房间时只清它的会话，口径见 RoomEndedEvent。
    if (!foreign) {
      store.cancelEntry();
      store.resetRoom(true);
      store.showToast(payload.message ?? payload.reason ?? "房间会话已结束，请重新加入");
    }
  } else if (message.event === "server.shutdown") {
    // 原地待命：不清会话、不重置房间。重启后由 useCEERoomLifecycle 带原票据重进；
    // 真回不去时会走上面的会话结束分支。
    const payload = message.payload as { message?: string; reason?: string };
    store.showToast(payload.message ?? payload.reason ?? "服务正在重启，稍后将自动重连");
  }
}

let initialized = false;
export function initCEEWs() {
  if (initialized) return () => {};
  initialized = true;
  const unsubscribeMessage = ws.onMessage(handleCEEMessage);
  const unsubscribeStatus = ws.onStatus((connected) => {
    connectionGeneration++;
    resetCEEStateSync();
    useCEEStore.setState({ connected, lobbyReady: false, snapshot: null, privateState: null });
    if (!connected) return;
    const store = useCEEStore.getState();
    const generation = connectionGeneration;
    // URL 房间会话仅由 useCEERoomLifecycle 恢复，避免订阅 ACK 与页面 effect 争抢重连。
    void store.subscribeLobby().catch((error: unknown) => {
      if (initialized && generation === connectionGeneration && useCEEStore.getState().connected)
        store.showToast(ceeErrorMessage(error));
    });
  });
  ws.connect();
  return () => {
    initialized = false;
    ws.disconnect();
    unsubscribeMessage();
    unsubscribeStatus();
    useCEEStore.getState().cancelEntry();
    useCEEStore.getState().resetRoom();
  };
}
