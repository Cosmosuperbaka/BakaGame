import { createRoomCoreSlice, type RoomCoreState } from "./room/RoomCoreSlice";
import { createRoomRuntime, type EndedRoomPayload, type RoomRuntime } from "./room/RoomRuntime";
import type { StateSyncChannel } from "./room/StateSyncChannel";
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
import { createQueryReuseCache, keywordQueryKey, type QueryReuseCache } from "@/lib/QueryReuse";
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

export interface CEEStore
  extends ToastState, RoomCoreState<CEERoomSummary, CEERoomSnapshot, CEEPrivateState> {
  originalAvailable: boolean;
  source: CEESource | null;
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
  resetRoom: (closed?: boolean) => void;
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

let runtime: RoomRuntime<ws.CEECommandMap, CEERoomSnapshot, CEEPrivateState, CEERoomEnterResult>;

/** 结束类事件优先用服务端给的句子；只有它什么都没给时才用兜底。 */
const ceeEndedText = (payload: EndedRoomPayload): string =>
  payload.message ?? payload.reason ?? "房间会话已结束，请重新加入";

/**
 * 恢复失败即放弃本地会话的错误码：共享永久码表，加上 CEE 原版房自己的会话过期码。
 * 共享部分不在这里再抄一份——抄的那份迟早会漏掉或多出服务端根本不发的码。
 */
const isPermanentCEEError = (error: unknown): boolean =>
  isPermanentRoomError(error) || protocolErrorCode(error) === "SESSION_EXPIRED";

export function resetCEEStateSync() {
  runtime.sync.reset();
}

export const ceeErrorMessage = (error: unknown): string => {
  if (isProtocolError(error)) return antiCheatMessage(error.code) ?? error.message;
  if (error instanceof Error) return error.message;
  return "操作失败，请重试";
};

export const useCEEStore = create<CEEStore>((set, get) => {
  const enter = (
    result: CEERoomEnterResult,
    sync: StateSyncChannel<CEERoomSnapshot, CEEPrivateState>
  ) => {
    // 先取走「进入期间被压下的同步欠账」——reset 会清掉它。
    const deferred = sync.takeDeferred();
    const rawSnapshot = sync.snapshot.baseline();
    const sameRoom = rawSnapshot?.roomId === result.roomId && rawSnapshot.source === result.source;
    if (!sameRoom) {
      sync.reset();
      sync.snapshot.adopt(result.snapshot);
      sync.privateState.adopt(result.privateState);
    }
    writeCEESession(result.roomId, result.sessionToken);
    set({
      source: result.source,
      roomId: result.roomId,
      sessionToken: result.sessionToken,
      snapshot: sync.snapshot.baseline(),
      privateState: sync.privateState.baseline() ?? result.privateState,
      roomClosedAt: null,
    });
    // 进入房间期间若收到过无法应用的状态补丁，此刻凭据已就绪，补一次全量同步。
    if (deferred) sync.flushDeferred();
  };
  runtime = createRoomRuntime<
    ws.CEECommandMap,
    CEERoomSnapshot,
    CEEPrivateState,
    CEERoomEnterResult
  >({
    ws,
    // 取图、目录同步这类直接调用不经命令执行器，超时口径同样只落在策略表一处。
    policy: ws.CEE_COMMAND_POLICY,
    tokens: { read: readCEESession, save: writeCEESession, clear: removeCEESession },
    requestSync: "cee.room.requestSync",
    identity: get,
    events: {
      lobbyRooms: "cee.lobby.rooms",
      snapshot: "cee.room.snapshot",
      privateState: "cee.game.privateState",
      ended: {
        "cee.room.closed": ceeEndedText,
        "cee.player.kicked": ceeEndedText,
        "session.replaced": ceeEndedText,
      },
      extra: {
        "cee.player.spectateResult": (payload) => {
          // 房主对旁观请求的显式处理结果只发给请求者；身份本身随快照下发，这里只给一条反馈。
          const approved = (payload as { approved?: boolean }).approved === true;
          get().showToast(
            approved ? SPECTATE_APPROVED_TEXT : SPECTATE_REJECTED_TEXT,
            approved ? "success" : "error"
          );
        },
      },
    },
    sync: {
      // 凭据未写回时抢发全量，信封不带凭据，原版会话校验必判 SESSION_INVALID，
      // 还会连带触发永久错误处理清掉刚建立的会话；只记欠账，等入房 ACK 写回凭据后补发。
      defer: () => runtime.isEntering() && !useCEEStore.getState().sessionToken,
      onError: (error) => useCEEStore.getState().reportError(error),
    },
    entry: {
      apply: (result, { sync }) => enter(result, sync),
      discard: async (result, { generation }) => {
        // ACK 已建立服务器会话，但页面不再拥有该意图：用 ACK 凭据释放，不写入本地身份。
        const before = generation();
        try {
          await ws.send(
            "cee.room.leave",
            {},
            { roomId: result.roomId, sessionToken: result.sessionToken }
          );
          removeCEESession(result.roomId);
        } finally {
          if (before === generation()) get().resetRoom(get().roomClosedAt !== null);
        }
      },
    },
    status: {
      generationOn: "everyStatus",
      syncOn: "resetOnEveryStatus",
      write: (connected) =>
        set({ connected, lobbyReady: false, snapshot: null, privateState: null }),
      subscribeLobby: () => {
        const generation = runtime.generation();
        // URL 房间会话仅由 useCEERoomLifecycle 恢复，避免订阅 ACK 与页面 effect 争抢重连。
        void get()
          .subscribeLobby()
          .catch((error: unknown) => {
            if (runtime.isInitialized() && generation === runtime.generation() && get().connected)
              get().showToast(ceeErrorMessage(error));
          });
      },
      restore: { by: "page" },
    },
    cleanup: {
      disconnectFirst: true,
      bumpGeneration: false,
      finish: () => {
        runtime.cancelEntry();
        get().resetRoom();
      },
    },
    handlers: {
      lobbyRooms: (payload) => set({ rooms: payload as CEERoomSummary[] }),
      snapshot: applyCEESnapshotEvent,
      privateState: (privateState) => set({ privateState }),
      roomEnded: (text) => {
        get().resetRoom(true);
        get().showToast(text);
      },
      shutdown: (payload) => {
        // 原地待命：不清会话、不重置房间、也不作废在途入房。重启后由 useCEERoomLifecycle
        // 带原票据重进；真回不去时会走会话结束分支。
        const { message, reason } = payload as { message?: string; reason?: string };
        get().showToast(message ?? reason ?? "服务正在重启，稍后将自动重连");
      },
    },
  });
  /** 只读查询的共用壳：复用窗口 + 取 results，房间身份只由 sendCommand 注入一处。 */
  const query = <TResult>(
    cache: QueryReuseCache<TResult>,
    key: string,
    load: () => Promise<{ results: TResult }>
  ) => cache.run(key, async () => (await load()).results);
  return {
    ...createRoomCoreSlice(set),
    originalAvailable: false,
    source: null,
    ...createToastSlice(set, { mode: "slot", defaultType: "error", defaultMs: 5000 }),
    requestLoginAt: 0,
    promptLogin: () => set({ requestLoginAt: Date.now() }),
    reportError: (error) => {
      get().showToast(ceeErrorMessage(error));
      if (isProtocolError(error) && isLoginRequiredCode(error.code)) get().promptLogin();
    },
    subscribeLobby: async () => {
      const generation = runtime.generation();
      const result = await ws.send("cee.lobby.subscribeRooms", {});
      if (generation !== runtime.generation()) return;
      set({ lobbyReady: true, originalAvailable: result.originalAvailable });
    },
    createRoom: (payload, signal) =>
      runtime.enter(() => ws.send("cee.room.create", payload, { timeout: 0 }), signal),
    joinRoom: (roomId, userName, password, signal) =>
      runtime.enter(
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
      return runtime.restore(
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
      runtime.cancelEntry();
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
    sendCommand: runtime.sendCommand,
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

function applyCEESnapshotEvent(snapshot: CEERoomSnapshot, previous: CEERoomSnapshot | null): void {
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

/** CEE 对外的消息入口：分发规则在运行时里，这里只保留玩法自己的公开名字。 */
export function handleCEEMessage(message: ServerMessage) {
  runtime.handleMessage(message);
}

/** 玩法对外的连接入口：幂等门闩、事件分发与清理都在运行时里。 */
export function initCEEWs() {
  return runtime.init();
}
