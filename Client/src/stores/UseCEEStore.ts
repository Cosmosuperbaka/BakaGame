import { create } from "zustand";
import type {
  CEECommand,
  CEEPayload,
  CEEPrivateState,
  CEERoomEnterResult,
  CEERoomSnapshot,
  CEERoomSummary,
  CEESource,
  ServerMessage,
} from "@bakagame/shared";
import { ceeWs, sendCEE, type CEEResponse } from "@/lib/CEEWs";
import {
  normalizeCEERoomId,
  readCEESession,
  removeCEESession,
  writeCEESession,
} from "@/lib/CEESession";
import { createQueryReuseCache, keywordQueryKey } from "@/lib/QueryReuse";
import { consumeStateSync } from "@/lib/StateSync";
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

export interface CEEStore {
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
  notice: { text: string; type: "info" | "error" | "success" } | null;
  setNotice: (text: string, type?: "info" | "error" | "success") => void;
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
  sendCommand: <T extends CEECommand>(
    command: T,
    payload: CEEPayload<T>
  ) => Promise<CEEResponse<T>>;
  /** 搜角色；同一关键词在复用窗口内不会重复请求上游。 */
  searchCharacters: (keyword: string) => Promise<CEEResponse<"cee.character.search">["results"]>;
  /** 搜作品；同一关键词在复用窗口内不会重复请求上游。 */
  searchSubjects: (keyword: string) => Promise<CEEResponse<"cee.subject.search">["results"]>;
  /** 取某作品的登场角色；切走再切回同一作品时复用上次结果。 */
  loadSubjectCharacters: (
    subjectId: CEEPayload<"cee.subject.characters">["subjectId"]
  ) => Promise<CEEResponse<"cee.subject.characters">["results"]>;
}

let snapshotRevision: number | undefined;
let privateRevision: number | undefined;
let rawSnapshot: CEERoomSnapshot | null = null;
let rawPrivate: CEEPrivateState | null = null;
let syncPending = false;
/**
 * 凭据尚未就绪时被压下的全量同步请求。
 *
 * 服务端建立会话后会先推快照事件、再回进入房间的 ACK（见 `requestSync` 的说明）。
 * 快照先到而凭据未就绪时不能立刻同步，否则必然收到 `SESSION_INVALID`；
 * 这里记下「有同步欠账」，等 `enter()` 写回凭据后立即补发。
 */
let syncDeferred = false;
/**
 * 是否正处在「进入房间」的往返中（join / create / reconnect 已发出、结果未回）。
 *
 * 服务端会在结果返回前就推送新房间状态，这期间客户端还没有可用凭据，
 * 任何主动同步都会被原版会话校验拒绝。
 */
let enteringRoom = false;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let connectionGeneration = 0;
const permanentErrors = new Set([
  "ROOM_NOT_FOUND",
  "SESSION_NOT_FOUND",
  "SESSION_INVALID",
  "SESSION_EXPIRED",
  "PLAYER_KICKED",
  "CEE_SESSION_INVALID",
]);
const serverTimedCommands = new Set<CEECommand>([
  "cee.game.start",
  "cee.game.next",
  "cee.game.setAnswer",
  "cee.game.imageHint",
  "cee.character.image",
  "cee.subject.image",
  "cee.directory.import",
]);

export function resetCEEStateSync() {
  snapshotRevision = undefined;
  privateRevision = undefined;
  rawSnapshot = null;
  rawPrivate = null;
  syncDeferred = false;
}

export const ceeErrorMessage = (error: unknown) =>
  error instanceof Error || isProtocolError(error) ? error.message : "操作失败，请重试";

export const useCEEStore = create<CEEStore>((set, get) => {
  const enter = (result: CEERoomEnterResult) => {
    // 先取走「进入期间被压下的同步欠账」——resetCEEStateSync 会清掉它。
    const deferred = syncDeferred;
    const sameRoom = rawSnapshot?.roomId === result.roomId && rawSnapshot.source === result.source;
    if (!sameRoom) {
      resetCEEStateSync();
      rawSnapshot = result.snapshot;
      rawPrivate = result.privateState;
    }
    writeCEESession(result.roomId, result.sessionToken);
    set({
      source: result.source,
      roomId: result.roomId,
      sessionToken: result.sessionToken,
      snapshot: rawSnapshot,
      privateState: rawPrivate ?? result.privateState,
      roomClosedAt: null,
    });
    // 进入房间期间若收到过无法应用的状态补丁，此刻凭据已就绪，补一次全量同步。
    if (deferred) requestSync();
  };
  let entryTail: Promise<void> | null = null;
  let restoring: {
    roomId: string;
    token: string;
    owners: Set<AbortSignal | undefined>;
    promise: Promise<boolean>;
  } | null = null;
  const enterRequest = (
    request: () => Promise<CEERoomEnterResult>,
    abandoned: () => boolean
  ): Promise<void> => {
    // StrictMode 重挂载或路由切换时，先结清旧意图，再允许新会话使用同一连接。
    const predecessor = entryTail;
    const generation = connectionGeneration;
    const run = async () => {
      if (generation !== connectionGeneration) throw new DOMException("连接已更换", "AbortError");
      if (abandoned()) throw new DOMException("入房操作已取消", "AbortError");
      resetCEEStateSync();
      enteringRoom = true;
      try {
        const result = await request();
        if (generation !== connectionGeneration) throw new DOMException("连接已更换", "AbortError");
        if (abandoned()) {
          // ACK 已建立服务器会话，但页面不再拥有该意图：用 ACK 凭据释放，不写入本地身份。
          try {
            await sendCEE(
              "cee.room.leave",
              {},
              { roomId: result.roomId, sessionToken: result.sessionToken }
            );
            removeCEESession(result.roomId);
          } finally {
            if (generation === connectionGeneration) get().resetRoom();
          }
          throw new DOMException("入房操作已取消", "AbortError");
        }
        enter(result);
      } finally {
        enteringRoom = false;
      }
    };
    const pending = predecessor ? predecessor.then(run, run) : run();
    entryTail = pending;
    const release = () => {
      if (entryTail === pending) entryTail = null;
    };
    void pending.then(release, release);
    return pending;
  };
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
    notice: null,
    setNotice: (text, type = "error") => {
      clearTimeout(noticeTimer);
      set({ notice: { text, type } });
      noticeTimer = setTimeout(() => set({ notice: null }), 5000);
    },
    subscribeLobby: async () => {
      const generation = connectionGeneration;
      const result = await sendCEE("cee.lobby.subscribeRooms", {});
      if (generation !== connectionGeneration) return;
      set({ lobbyReady: true, originalAvailable: result.originalAvailable });
    },
    createRoom: (payload, signal) =>
      enterRequest(
        () => sendCEE("cee.room.create", payload, { timeout: 0 }),
        () => signal?.aborted ?? false
      ),
    joinRoom: (roomId, userName, password, signal) =>
      enterRequest(
        () =>
          sendCEE(
            "cee.room.join",
            { userName, ...(password ? { password } : {}) },
            { roomId: normalizeCEERoomId(roomId), timeout: 0 }
          ),
        () => signal?.aborted ?? false
      ),
    reconnectRoom: (roomId, signal) => {
      roomId = normalizeCEERoomId(roomId);
      const token = readCEESession(roomId);
      if (!token) return Promise.resolve(false);
      // 同一恢复意图可由 StrictMode 的新 effect 接管；只有所有所有者都撤销才释放 ACK 会话。
      if (!restoring || restoring.roomId !== roomId || restoring.token !== token) {
        const owners = new Set<AbortSignal | undefined>();
        owners.add(signal);
        const promise = enterRequest(
          () => sendCEE("cee.room.reconnect", { roomId, sessionToken: token }, { timeout: 0 }),
          () => [...owners].every((owner) => owner?.aborted)
        )
          .then(() => true)
          .catch((error: unknown) => {
            if (!isProtocolError(error) || !permanentErrors.has(error.code)) throw error;
            removeCEESession(roomId);
            get().resetRoom();
            get().setNotice(ceeErrorMessage(error));
            return false;
          });
        const entry = { roomId, token, owners, promise };
        restoring = entry;
        const release = () => {
          if (restoring === entry) restoring = null;
        };
        void promise.then(release, release);
      } else restoring.owners.add(signal);
      return restoring.promise.then((result) => {
        if (signal?.aborted) throw new DOMException("恢复操作已取消", "AbortError");
        return result;
      });
    },
    leaveRoom: async () => {
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
    sendCommand: (command, payload) => {
      const { roomId, sessionToken } = get();
      return sendCEE(command, payload, {
        roomId: roomId ?? undefined,
        sessionToken: sessionToken ?? undefined,
        timeout: serverTimedCommands.has(command) ? 0 : undefined,
      });
    },
    searchCharacters: (keyword) =>
      ceeCharacterSearchCache.run(keyword, async () => {
        const { results } = await get().sendCommand("cee.character.search", { keyword });
        return results;
      }),
    searchSubjects: (keyword) =>
      ceeSubjectSearchCache.run(keyword, async () => {
        const { results } = await get().sendCommand("cee.subject.search", { keyword });
        return results;
      }),
    loadSubjectCharacters: (subjectId) =>
      ceeSubjectCharactersCache.run(String(subjectId), async () => {
        const { results } = await get().sendCommand("cee.subject.characters", { subjectId });
        return results;
      }),
  };
});

/**
 * 请求全量房态。
 *
 * **必须等会话凭据就绪**：服务端在 `enter()` 返回结果**之前**就会推送新房间的快照事件
 * （`publish()` 先于 ACK 到达），此时客户端 `sessionToken` 还是初值 `null`。若立刻发
 * `requestSync`，信封不带凭据，服务端原版会话校验（`message.sessionToken !== session.token`）
 * 会直接判定 `SESSION_INVALID`。该错误发生在服务端会话已建立之后，会连带触发
 * `reconnectRoom` 的永久错误处理、把刚建立的原版会话清掉——表现为「加入原版房间失败」。
 * 因此仅在「正在进入房间且凭据尚未写回」时登记欠账，等 `enter()` 落定后补发；
 * 其余情况（房内已有凭据、只是补丁出现缺口）照常立即请求。
 */
function requestSync() {
  if (syncPending) return;
  if (!useCEEStore.getState().sessionToken && enteringRoom) {
    syncDeferred = true;
    return;
  }
  syncPending = true;
  void useCEEStore
    .getState()
    .sendCommand("cee.room.requestSync", {})
    .catch((error: unknown) => useCEEStore.getState().setNotice(ceeErrorMessage(error)))
    .finally(() => {
      syncPending = false;
    });
}

export function handleCEEMessage(message: ServerMessage) {
  if (message.type !== "event") return;
  const store = useCEEStore.getState();
  if (message.event === "cee.lobby.rooms") {
    useCEEStore.setState({ rooms: message.payload as CEERoomSummary[] });
  } else if (message.event === "cee.room.snapshot") {
    const result = consumeStateSync<CEERoomSnapshot>(
      rawSnapshot,
      snapshotRevision,
      message.payload
    );
    if (result.needsFullSync || !result.state) {
      requestSync();
      return;
    }
    rawSnapshot = result.state;
    snapshotRevision = result.revision;
    useCEEStore.setState({ snapshot: rawSnapshot });
  } else if (message.event === "cee.game.privateState") {
    const result = consumeStateSync<CEEPrivateState>(rawPrivate, privateRevision, message.payload);
    if (result.needsFullSync || !result.state) {
      requestSync();
      return;
    }
    rawPrivate = result.state;
    privateRevision = result.revision;
    useCEEStore.setState({ privateState: rawPrivate });
  } else if (
    [
      "cee.room.closed",
      "cee.player.kicked",
      "session.replaced",
      "cee.session.replaced",
      "server.shutdown",
    ].includes(message.event)
  ) {
    if (store.roomId) removeCEESession(store.roomId);
    store.resetRoom(true);
    const payload = message.payload as { reason?: string; message?: string };
    store.setNotice(payload.message ?? payload.reason ?? "房间会话已结束，请重新加入");
  }
}

let initialized = false;
export function initCEEWs() {
  if (initialized) return () => {};
  initialized = true;
  const unsubscribeMessage = ceeWs.onMessage(handleCEEMessage);
  const unsubscribeStatus = ceeWs.onStatus((connected) => {
    connectionGeneration++;
    resetCEEStateSync();
    useCEEStore.setState({ connected, lobbyReady: false, snapshot: null, privateState: null });
    if (!connected) return;
    const store = useCEEStore.getState();
    const generation = connectionGeneration;
    // URL 房间会话仅由 useCEERoomLifecycle 恢复，避免订阅 ACK 与页面 effect 争抢重连。
    void store.subscribeLobby().catch((error: unknown) => {
      if (initialized && generation === connectionGeneration && useCEEStore.getState().connected)
        store.setNotice(ceeErrorMessage(error));
    });
  });
  ceeWs.connect();
  return () => {
    initialized = false;
    ceeWs.disconnect();
    unsubscribeMessage();
    unsubscribeStatus();
    useCEEStore.getState().resetRoom();
  };
}
