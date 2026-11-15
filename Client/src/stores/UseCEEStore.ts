import { createRoomCoreSlice, type RoomCoreState } from "./room/RoomCoreSlice";
import { ROOM_ENDED_TEXT } from "./room/RoomEndedEvent";
import { createRoomRuntime, type EndedRoomPayload, type RoomRuntime } from "./room/RoomRuntime";
import type { StateSyncChannel } from "./room/StateSyncChannel";
import { SHUTDOWN_TOAST_MS, createToastSlice, type ToastState } from "./room/ToastSlice";
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
import { isPermanentRoomError, mergeChatWindow, protocolErrorCode } from "@bakagame/shared/values";
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
import { isAbortError } from "@/lib/ErrorMessage";
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
  /**
   * 重连后运行时没能回座的时刻（座位已失效或回座临时失败，房间本身没被关）。
   * 房间已让出、画面已清空；房间页据此重新走一遍直链入房。
   */
  seatLostAt: number | null;
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
  /**
   * 退房：立刻让出本地房间并作废在途入房，退房命令带离开前的身份发出。
   * 回包之前的入房与大厅订阅都排在它后面，服务端不会撞上还没离开的座位。
   */
  leaveRoom: () => Promise<void>;
  /** 在途的那次退房；没有时为 null。大厅据此在退房落定后重新订阅。 */
  roomRelease: () => Promise<void> | null;
  /**
   * 玩家在房间页点了离开：先换页，房间页卸载时才退房。大厅挂载时房间还没让出，
   * 据此知道这次退房有房间页负责，不再为它显示骨架。退房发出即撤下。
   */
  exitPending: boolean;
  markExit: () => void;
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

/** 在途的退房；入房与大厅订阅要等它落定（成败都算）再发。 */
let pendingLeave: Promise<void> | null = null;
const afterLeave = async <T>(request: () => Promise<T>): Promise<T> => {
  if (pendingLeave) await pendingLeave.catch(() => {});
  return request();
};

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
    const baseline = sync.snapshot.baseline();
    set({
      source: result.source,
      roomId: result.roomId,
      sessionToken: result.sessionToken,
      snapshot: baseline && withChatHistory(baseline, get().snapshot),
      privateState: sync.privateState.baseline() ?? result.privateState,
      roomClosedAt: null,
    });
    // 进入房间期间若收到过无法应用的状态补丁，此刻凭据已就绪，补一次全量同步。
    if (deferred) sync.flushDeferred();
  };
  /**
   * 关房与被移出：服务端给了原因就用那一句——增强房会说明是谁、为什么（管理员关闭、房主移出、
   * 长时间无人活动），原版房是上游的说法；没给才用三款同一句。
   */
  const reasonedText = (payload: EndedRoomPayload, text: string): string =>
    payload.message ?? payload.reason ?? text;
  /**
   * 席位被接管：只有原版房取上游句子，增强房这类事件带的原因是协议标记，不是给玩家看的话。
   * 是否原版房先看事件自带的来源（入房在途时本地还没有快照），再看当前快照。
   */
  const replacedText = (payload: EndedRoomPayload): string =>
    payload.source === "original" || get().snapshot?.source === "original"
      ? reasonedText(payload, ROOM_ENDED_TEXT.replaced)
      : ROOM_ENDED_TEXT.replaced;
  /**
   * 重连后的回座。回不去而房间还在时（座位失效、临时失败）让出房间并记下失座，
   * 由房间页按直链入房重来：座位失效就按名字重新加入，临时失败再恢复一次、仍失败才回大厅。
   * 作废（又断线、主动退房、房间被关）不算失座：下一次连上或关闭分支各自接手。
   */
  const restoreSeat = async (roomId: string): Promise<boolean> => {
    try {
      if (await get().reconnectRoom(roomId)) return true;
    } catch (error) {
      if (isAbortError(error) || get().roomId !== roomId) return false;
      get().resetRoom();
    }
    if (get().roomClosedAt === null) set({ seatLostAt: Date.now() });
    return false;
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
        "cee.room.closed": (payload) => reasonedText(payload, ROOM_ENDED_TEXT.closed),
        "cee.player.kicked": (payload) => reasonedText(payload, ROOM_ENDED_TEXT.kicked),
        "session.replaced": replacedText,
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
      // 断线保留房间画面与已输入的内容，顶栏给断线提示；同步基线照样作废，
      // 重连后的展示态由回座 ACK 的服务端全量整体替换，不在旧画面上续补丁。
      write: (connected) => set(connected ? { connected } : { connected, lobbyReady: false }),
      subscribeLobby: () => {
        const generation = runtime.generation();
        void get()
          .subscribeLobby()
          .catch((error: unknown) => {
            if (runtime.isInitialized() && generation === runtime.generation() && get().connected)
              get().showToast(ceeErrorMessage(error), "error");
          });
      },
      // 订阅大厅先发、回座后发：服务端按到达顺序受理，订阅不会撞上已落座的连接。
      reconnect: restoreSeat,
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
        get().showToast(text, "error");
      },
      shutdown: (payload) => {
        // 原地待命：不清会话、不重置房间、也不作废在途入房。重启后由 useCEERoomLifecycle
        // 带原票据重进；真回不去时会走会话结束分支。
        const { message, reason } = payload as { message?: string; reason?: string };
        get().showToast(
          message ?? reason ?? "服务正在重启，稍后将自动重连",
          "error",
          SHUTDOWN_TOAST_MS
        );
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
    seatLostAt: null,
    ...createToastSlice(set, get),
    requestLoginAt: 0,
    promptLogin: () => set({ requestLoginAt: Date.now() }),
    reportError: (error) => {
      get().showToast(ceeErrorMessage(error), "error");
      if (isProtocolError(error) && isLoginRequiredCode(error.code)) get().promptLogin();
    },
    subscribeLobby: async () => {
      const generation = runtime.generation();
      // 还在房里时服务端拒绝订阅大厅：等在途的退房落定再发。
      const result = await afterLeave(() => ws.send("cee.lobby.subscribeRooms", {}));
      if (generation !== runtime.generation()) return;
      set({ lobbyReady: true, originalAvailable: result.originalAvailable });
    },
    createRoom: (payload, signal) =>
      runtime.enter(
        () => afterLeave(() => ws.send("cee.room.create", payload, { timeout: 0 })),
        signal
      ),
    joinRoom: (roomId, userName, password, signal) =>
      runtime.enter(
        () =>
          afterLeave(() =>
            ws.send(
              "cee.room.join",
              { userName, ...(password ? { password } : {}) },
              { roomId: normalizeCEERoomId(roomId), timeout: 0 }
            )
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
        () =>
          afterLeave(() =>
            ws.send("cee.room.reconnect", { roomId, sessionToken: token }, { timeout: 0 })
          ),
        (error) => {
          if (!isPermanentCEEError(error)) return false;
          removeCEESession(roomId);
          get().resetRoom(roomIsGone(error));
          // 原版房的会话过期码不在共享表里，文案仍用服务端给的那句。
          if (isPermanentRoomError(error))
            get().showToast(permanentRoomErrorMessage(error), "error");
          else get().reportError(error);
          return true;
        },
        signal
      );
    },
    leaveRoom: () => {
      // 退房同时作废在途入房：晚到的 ACK 不能再把刚离开的房间写回本地。
      runtime.cancelEntry();
      set({ exitPending: false });
      const { roomId } = get();
      if (!roomId) return Promise.resolve();
      // 命令在发出的那一刻带上离开前的身份；之后本地立刻让出房间，大厅不必等回包。
      const leaving = get()
        .sendCommand("cee.room.leave", {})
        .then(() => undefined);
      removeCEESession(roomId);
      get().resetRoom();
      pendingLeave = leaving;
      const settle = () => {
        if (pendingLeave === leaving) pendingLeave = null;
      };
      void leaving.then(settle, settle);
      return leaving;
    },
    roomRelease: () => pendingLeave,
    exitPending: false,
    markExit: () => set({ exitPending: true }),
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

/**
 * 聊天展示层：服务端快照只带最近一段聊天，同一房间里把它续在已展示的历史后面供玩家往回翻，
 * 口径与另两款同一份（按 id 去重、按时间排序、保留有上限的条数）。只换展示态，原始基线不动，
 * 补丁的下标仍对着服务端那一段。
 */
function withChatHistory(next: CEERoomSnapshot, shown: CEERoomSnapshot | null): CEERoomSnapshot {
  return {
    ...next,
    chat: mergeChatWindow(shown?.roomId === next.roomId ? shown.chat : [], next.chat),
  };
}

function applyCEESnapshotEvent(snapshot: CEERoomSnapshot, previous: CEERoomSnapshot | null): void {
  useCEEStore.setState({ snapshot: withChatHistory(snapshot, useCEEStore.getState().snapshot) });
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
