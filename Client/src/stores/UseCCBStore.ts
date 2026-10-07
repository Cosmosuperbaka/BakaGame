import { create } from "zustand";
import type { CCBCommand, CCBPayload, CCBPrivateState, CCBRoomEnterResult, CCBRoomSnapshot, CCBRoomSummary, CCBSource, ServerMessage } from "@bakagame/shared";
import { ccbWs, sendCCB, type CCBResponse } from "@/lib/CCBWs";
import { normalizeCCBRoomId, readCCBSession, removeCCBSession, writeCCBSession } from "@/lib/CCBSession";
import { createQueryReuseCache, keywordQueryKey } from "@/lib/QueryReuse";
import { consumeStateSync } from "@/lib/StateSync";
import { isProtocolError } from "@/lib/WebsocketClient";

/**
 * CCB 只读查询的结果复用窗口，语义见 `lib/QueryReuse`。
 *
 * 覆盖「搜角色 / 搜作品 / 取某作品的登场角色」三条：翻看候选时来回比对、
 * 切换作品再切回来，都会重复提交同一串输入。
 */
const ccbCharacterSearchCache =
  createQueryReuseCache<CCBResponse<"ccb.character.search">["results"]>(keywordQueryKey);
const ccbSubjectSearchCache =
  createQueryReuseCache<CCBResponse<"ccb.subject.search">["results"]>(keywordQueryKey);
const ccbSubjectCharactersCache =
  createQueryReuseCache<CCBResponse<"ccb.subject.characters">["results"]>(keywordQueryKey);

/** 清空 CCB 复用窗口；测试用它隔离用例，运行期无需调用（查询结果与房间无关）。 */
export function clearCCBQueryCache() {
  ccbCharacterSearchCache.clear();
  ccbSubjectSearchCache.clear();
  ccbSubjectCharactersCache.clear();
}

export interface CCBStore {
  connected: boolean; lobbyReady: boolean; originalAvailable: boolean;
  rooms: CCBRoomSummary[]; source: CCBSource | null; roomId: string | null; sessionToken: string | null;
  snapshot: CCBRoomSnapshot | null; privateState: CCBPrivateState | null; roomClosedAt: number | null;
  notice: { text: string; type: "info" | "error" | "success" } | null;
  setNotice: (text: string, type?: "info" | "error" | "success") => void;
  subscribeLobby: () => Promise<void>;
  createRoom: (payload: CCBPayload<"ccb.room.create">, signal?: AbortSignal) => Promise<void>;
  joinRoom: (roomId: string, userName: string, password?: string, signal?: AbortSignal) => Promise<void>;
  reconnectRoom: (roomId: string, signal?: AbortSignal) => Promise<boolean>;
  leaveRoom: () => Promise<void>;
  resetRoom: (closed?: boolean) => void;
  sendCommand: <T extends CCBCommand>(command: T, payload: CCBPayload<T>) => Promise<CCBResponse<T>>;
  /** 搜角色；同一关键词在复用窗口内不会重复请求上游。 */
  searchCharacters: (keyword: string) => Promise<CCBResponse<"ccb.character.search">["results"]>;
  /** 搜作品；同一关键词在复用窗口内不会重复请求上游。 */
  searchSubjects: (keyword: string) => Promise<CCBResponse<"ccb.subject.search">["results"]>;
  /** 取某作品的登场角色；切走再切回同一作品时复用上次结果。 */
  loadSubjectCharacters: (
    subjectId: CCBPayload<"ccb.subject.characters">["subjectId"],
  ) => Promise<CCBResponse<"ccb.subject.characters">["results"]>;
}

let snapshotRevision: number | undefined;
let privateRevision: number | undefined;
let rawSnapshot: CCBRoomSnapshot | null = null;
let rawPrivate: CCBPrivateState | null = null;
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
const permanentErrors = new Set(["ROOM_NOT_FOUND", "SESSION_NOT_FOUND", "SESSION_INVALID", "SESSION_EXPIRED", "PLAYER_KICKED", "CCB_SESSION_INVALID"]);
const serverTimedCommands = new Set<CCBCommand>([
  "ccb.game.start", "ccb.game.next", "ccb.game.setAnswer", "ccb.game.imageHint", "ccb.character.image", "ccb.subject.image", "ccb.directory.import",
]);

export function resetCCBStateSync() {
  snapshotRevision = undefined; privateRevision = undefined;
  rawSnapshot = null; rawPrivate = null;
  syncDeferred = false;
}

export const ccbErrorMessage = (error: unknown) => error instanceof Error || isProtocolError(error) ? error.message : "操作失败，请重试";

export const useCCBStore = create<CCBStore>((set, get) => {
  const enter = (result: CCBRoomEnterResult) => {
    // 先取走「进入期间被压下的同步欠账」——resetCCBStateSync 会清掉它。
    const deferred = syncDeferred;
    const sameRoom = rawSnapshot?.roomId === result.roomId && rawSnapshot.source === result.source;
    if (!sameRoom) { resetCCBStateSync(); rawSnapshot = result.snapshot; rawPrivate = result.privateState; }
    writeCCBSession(result.roomId, result.sessionToken);
    set({ source: result.source, roomId: result.roomId, sessionToken: result.sessionToken,
      snapshot: rawSnapshot, privateState: rawPrivate ?? result.privateState, roomClosedAt: null });
    // 进入房间期间若收到过无法应用的状态补丁，此刻凭据已就绪，补一次全量同步。
    if (deferred) requestSync();
  };
  let entryTail: Promise<void> | null = null;
  let restoring: { roomId: string; token: string; owners: Set<AbortSignal | undefined>; promise: Promise<boolean> } | null = null;
  const enterRequest = (request: () => Promise<CCBRoomEnterResult>, abandoned: () => boolean): Promise<void> => {
    // StrictMode 重挂载或路由切换时，先结清旧意图，再允许新会话使用同一连接。
    const predecessor = entryTail;
    const generation = connectionGeneration;
    const run = async () => {
      if (generation !== connectionGeneration) throw new DOMException("连接已更换", "AbortError");
      if (abandoned()) throw new DOMException("入房操作已取消", "AbortError");
      resetCCBStateSync();
      enteringRoom = true;
      try {
        const result = await request();
        if (generation !== connectionGeneration) throw new DOMException("连接已更换", "AbortError");
        if (abandoned()) {
          // ACK 已建立服务器会话，但页面不再拥有该意图：用 ACK 凭据释放，不写入本地身份。
          try {
            await sendCCB("ccb.room.leave", {}, { roomId: result.roomId, sessionToken: result.sessionToken });
            removeCCBSession(result.roomId);
          } finally {
            if (generation === connectionGeneration) get().resetRoom();
          }
          throw new DOMException("入房操作已取消", "AbortError");
        }
        enter(result);
      } finally { enteringRoom = false; }
    };
    const pending = predecessor ? predecessor.then(run, run) : run();
    entryTail = pending;
    const release = () => { if (entryTail === pending) entryTail = null; };
    void pending.then(release, release);
    return pending;
  };
  return {
    connected: false, lobbyReady: false, originalAvailable: false,
    rooms: [], source: null, roomId: null, sessionToken: null, snapshot: null, privateState: null,
    roomClosedAt: null, notice: null,
    setNotice: (text, type = "error") => {
      clearTimeout(noticeTimer);
      set({ notice: { text, type } });
      noticeTimer = setTimeout(() => set({ notice: null }), 5000);
    },
    subscribeLobby: async () => {
      const generation = connectionGeneration;
      const result = await sendCCB("ccb.lobby.subscribeRooms", {});
      if (generation !== connectionGeneration) return;
      set({ lobbyReady: true, originalAvailable: result.originalAvailable });
    },
    createRoom: (payload, signal) => enterRequest(() => sendCCB("ccb.room.create", payload, { timeout: 0 }), () => signal?.aborted ?? false),
    joinRoom: (roomId, userName, password, signal) => enterRequest(() =>
      sendCCB("ccb.room.join", { userName, ...(password ? { password } : {}) }, { roomId: normalizeCCBRoomId(roomId), timeout: 0 }), () => signal?.aborted ?? false),
    reconnectRoom: (roomId, signal) => {
      roomId = normalizeCCBRoomId(roomId);
      const token = readCCBSession(roomId);
      if (!token) return Promise.resolve(false);
      // 同一恢复意图可由 StrictMode 的新 effect 接管；只有所有所有者都撤销才释放 ACK 会话。
      if (!restoring || restoring.roomId !== roomId || restoring.token !== token) {
        const owners = new Set<AbortSignal | undefined>();
        owners.add(signal);
        const promise = enterRequest(() => sendCCB("ccb.room.reconnect", { roomId, sessionToken: token }, { timeout: 0 }),
          () => [...owners].every((owner) => owner?.aborted)).then(() => true).catch((error: unknown) => {
          if (!isProtocolError(error) || !permanentErrors.has(error.code)) throw error;
          removeCCBSession(roomId);
          get().resetRoom();
          get().setNotice(ccbErrorMessage(error));
          return false;
        });
        const entry = { roomId, token, owners, promise };
        restoring = entry;
        const release = () => { if (restoring === entry) restoring = null; };
        void promise.then(release, release);
      } else restoring.owners.add(signal);
      return restoring.promise.then((result) => {
        if (signal?.aborted) throw new DOMException("恢复操作已取消", "AbortError");
        return result;
      });
    },
    leaveRoom: async () => {
      const { roomId } = get();
      try { if (roomId) await get().sendCommand("ccb.room.leave", {}); }
      finally {
        if (roomId) removeCCBSession(roomId);
        get().resetRoom();
      }
    },
    resetRoom: (closed = false) => {
      resetCCBStateSync();
      set({ source: null, roomId: null, sessionToken: null, snapshot: null, privateState: null, roomClosedAt: closed ? Date.now() : null });
    },
    sendCommand: (command, payload) => {
      const { roomId, sessionToken } = get();
      return sendCCB(command, payload, { roomId: roomId ?? undefined, sessionToken: sessionToken ?? undefined,
        timeout: serverTimedCommands.has(command) ? 0 : undefined });
    },
    searchCharacters: (keyword) =>
      ccbCharacterSearchCache.run(keyword, async () => {
        const { results } = await get().sendCommand("ccb.character.search", { keyword });
        return results;
      }),
    searchSubjects: (keyword) =>
      ccbSubjectSearchCache.run(keyword, async () => {
        const { results } = await get().sendCommand("ccb.subject.search", { keyword });
        return results;
      }),
    loadSubjectCharacters: (subjectId) =>
      ccbSubjectCharactersCache.run(String(subjectId), async () => {
        const { results } = await get().sendCommand("ccb.subject.characters", { subjectId });
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
  if (!useCCBStore.getState().sessionToken && enteringRoom) { syncDeferred = true; return; }
  syncPending = true;
  void useCCBStore.getState().sendCommand("ccb.room.requestSync", {})
    .catch((error: unknown) => useCCBStore.getState().setNotice(ccbErrorMessage(error)))
    .finally(() => { syncPending = false; });
}

export function handleCCBMessage(message: ServerMessage) {
  if (message.type !== "event") return;
  const store = useCCBStore.getState();
  if (message.event === "ccb.lobby.rooms") {
    useCCBStore.setState({ rooms: message.payload as CCBRoomSummary[] });
  } else if (message.event === "ccb.room.snapshot") {
    const result = consumeStateSync<CCBRoomSnapshot>(rawSnapshot, snapshotRevision, message.payload);
    if (result.needsFullSync || !result.state) { requestSync(); return; }
    rawSnapshot = result.state; snapshotRevision = result.revision;
    useCCBStore.setState({ snapshot: rawSnapshot });
  } else if (message.event === "ccb.game.privateState") {
    const result = consumeStateSync<CCBPrivateState>(rawPrivate, privateRevision, message.payload);
    if (result.needsFullSync || !result.state) { requestSync(); return; }
    rawPrivate = result.state; privateRevision = result.revision;
    useCCBStore.setState({ privateState: rawPrivate });
  } else if (["ccb.room.closed", "ccb.player.kicked", "session.replaced", "ccb.session.replaced", "server.shutdown"].includes(message.event)) {
    if (store.roomId) removeCCBSession(store.roomId);
    store.resetRoom(true);
    const payload = message.payload as { reason?: string; message?: string };
    store.setNotice(payload.message ?? payload.reason ?? "房间会话已结束，请重新加入");
  }
}

let initialized = false;
export function initCCBWs() {
  if (initialized) return () => {};
  initialized = true;
  const unsubscribeMessage = ccbWs.onMessage(handleCCBMessage);
  const unsubscribeStatus = ccbWs.onStatus((connected) => {
    connectionGeneration++;
    resetCCBStateSync();
    useCCBStore.setState({ connected, lobbyReady: false, snapshot: null, privateState: null });
    if (!connected) return;
    const store = useCCBStore.getState();
    const generation = connectionGeneration;
    // URL 房间会话仅由 useCCBRoomLifecycle 恢复，避免订阅 ACK 与页面 effect 争抢重连。
    void store.subscribeLobby().catch((error: unknown) => {
      if (initialized && generation === connectionGeneration && useCCBStore.getState().connected) store.setNotice(ccbErrorMessage(error));
    });
  });
  ccbWs.connect();
  return () => {
    initialized = false;
    ccbWs.disconnect();
    unsubscribeMessage(); unsubscribeStatus();
    useCCBStore.getState().resetRoom();
  };
}
