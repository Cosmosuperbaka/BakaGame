import type { CommandPolicy, CommandSpecMap, GameSendCommand, GameWs } from "@/lib/GameWs";
import { createRoomEntry } from "@/lib/RoomEntry";
import type { ServerMessage } from "@bakagame/shared";
import { resolveEndedRoom } from "./RoomEndedEvent";
import { createStateSyncChannel, type StateSyncChannel } from "./StateSyncChannel";

/** 席位凭据的存取口径：三款各用自己的存储前缀，运行时只按房号读写。 */
export interface RoomTokens {
  read: (roomId: string) => string | null;
  save: (roomId: string, token: string) => void;
  clear: (roomId: string) => void;
}

export interface RoomIdentity {
  roomId: string | null;
  sessionToken: string | null;
}

/** 入房 ACK 的公共部分；各款在此基础上带自己的首屏状态与旧凭据。 */
export interface RoomEnterReceipt {
  roomId: string;
  sessionToken: string;
  previousToken?: string | null;
}

/** 结束类事件的载荷：房号决定清哪间的凭据，CEE 另取服务端给的句子。 */
export interface EndedRoomPayload {
  roomId?: string;
  message?: string;
  reason?: string;
}

/** 入房事务回调拿到的运行时内部件：同步基线与当前连接代次。 */
export interface RoomEntryContext<TSnapshot, TPrivate> {
  sync: StateSyncChannel<TSnapshot, TPrivate>;
  generation: () => number;
}

/**
 * 三款房间运行时的差异全部落在这些参数上，骨架只有一份。
 * 参数取值照各款现状，不是审美选项：统一任何一处都会改变玩家能感受到的行为。
 */
export interface RoomRuntimeOptions<
  M extends CommandSpecMap,
  TSnapshot,
  TPrivate,
  TReceipt extends RoomEnterReceipt,
> {
  ws: GameWs<M>;
  /** 命令超时策略表；只有 CEE 在发送处查表，另两款由命令执行器显式传超时。 */
  policy?: CommandPolicy<M>;
  tokens: RoomTokens;
  requestSync: keyof M & string;
  identity: () => RoomIdentity;
  events: {
    lobbyRooms: string;
    snapshot: string;
    privateState: string;
    /** 结束类事件 → 提示文案；函数形式取服务端句子。 */
    ended: Record<string, string | ((payload: EndedRoomPayload) => string)>;
    /** 本玩法独有事件。 */
    extra?: Record<string, (payload: unknown) => void>;
  };
  sync?: {
    defer?: () => boolean;
    onError?: (error: unknown) => void;
  };
  entry: {
    apply: (receipt: TReceipt, context: RoomEntryContext<TSnapshot, TPrivate>) => void;
    discard: (receipt: TReceipt, context: RoomEntryContext<TSnapshot, TPrivate>) => Promise<void>;
  };
  status: {
    /** 连接代次递增时机：CEE 每次状态变化都加，另两款只在断线时加。 */
    generationOn: "disconnect" | "everyStatus";
    /** 状态变化时同步基线的作废口径。 */
    syncOn: "resetOnConnect" | "clearRevisionsOnConnect" | "resetOnEveryStatus";
    /** 写回连接态与展示态；CEE 在这里清空快照与私有态。 */
    write: (connected: boolean) => void;
    /** 连上后怎么订阅大厅：另两款发完不管，CEE 等 ACK 并带代次守卫。 */
    subscribeLobby: () => void;
    /** 谁触发回座：运行时自动恢复，或页面自己恢复。 */
    restore: { by: "page" } | { by: "runtime"; reconnect: (roomId: string) => Promise<boolean> };
  };
  cleanup: {
    /** CEE 先断连接再退订阅，断线回调仍会被处理；另两款先退订阅。 */
    disconnectFirst: boolean;
    /** 清理是否让连接代次前进；CEE 不加。 */
    bumpGeneration: boolean;
    finish: () => void;
  };
  handlers: {
    lobbyRooms: (payload: unknown) => void;
    /** previous 是消费前的基线，CEE 用它判断回合是否真的前进。 */
    snapshot: (snapshot: TSnapshot, previous: TSnapshot | null) => void;
    privateState: (privateState: TPrivate) => void;
    /** 凭据已清、在途入房已作废后，各款自己重置房间态并给提示。 */
    roomEnded: (text: string) => void;
    shutdown: (payload: unknown) => void;
  };
}

export interface RoomRuntime<
  M extends CommandSpecMap,
  TSnapshot,
  TPrivate,
  TReceipt extends RoomEnterReceipt,
> {
  /** 幂等门闩：重复调用不叠加第二路订阅；返回清理。 */
  init: () => () => void;
  /** 事件分发入口：玩法自己留了公开的事件入口时转交给它。 */
  handleMessage: (message: ServerMessage) => void;
  sync: StateSyncChannel<TSnapshot, TPrivate>;
  generation: () => number;
  isInitialized: () => boolean;
  enter: (request: () => Promise<TReceipt>, signal?: AbortSignal) => Promise<void>;
  restore: (
    key: string,
    request: () => Promise<TReceipt>,
    onFailure: (error: unknown) => boolean,
    signal?: AbortSignal
  ) => Promise<boolean>;
  cancelEntry: () => void;
  isEntering: () => boolean;
  /** 补房号与令牌、按策略表定超时；身份注入只在这里一处。 */
  sendCommand: GameSendCommand<M>;
}

/**
 * 一条游戏连接的房间运行时：连接代次、入房事务、同步基线、事件分发与初始化门闩。
 * 玩法自己的展示态写法、凭据存储与提示文案由参数注入，运行时不替它们做决定。
 */
export function createRoomRuntime<
  M extends CommandSpecMap,
  TSnapshot,
  TPrivate,
  TReceipt extends RoomEnterReceipt,
>(
  options: RoomRuntimeOptions<M, TSnapshot, TPrivate, TReceipt>
): RoomRuntime<M, TSnapshot, TPrivate, TReceipt> {
  const { ws, tokens, identity, events, status, cleanup, handlers } = options;
  let generation = 0;
  let initialized = false;

  const sendCommand: GameSendCommand<M> = async (type, payload = {}, commandOptions) => {
    const { roomId, sessionToken } = identity();
    return ws.send(type, payload, {
      roomId: roomId ?? undefined,
      sessionToken: sessionToken ?? undefined,
      timeout: commandOptions?.timeout ?? options.policy?.[type]?.timeout,
    });
  };

  const sync = createStateSyncChannel<TSnapshot, TPrivate>({
    requestFull: () => sendCommand(options.requestSync, {}),
    defer: options.sync?.defer ?? (() => false),
    onError: options.sync?.onError ?? (() => {}),
  });
  const context: RoomEntryContext<TSnapshot, TPrivate> = { sync, generation: () => generation };
  const entry = createRoomEntry<TReceipt>({
    generation: () => generation,
    begin: () => sync.reset(),
    apply: (receipt) => options.entry.apply(receipt, context),
    discard: (receipt) => options.entry.discard(receipt, context),
  });

  const extraEvents = new Map(Object.entries(events.extra ?? {}));
  const endedEvents = new Map(Object.entries(events.ended));

  /** 房间已结束：事件指向别的房间时只清它的凭据，口径见 RoomEndedEvent。 */
  const endRoom = (payload: EndedRoomPayload, text: string) => {
    const { roomId, foreign } = resolveEndedRoom(payload.roomId, identity().roomId);
    if (roomId) tokens.clear(roomId);
    if (foreign) return;
    entry.cancel();
    handlers.roomEnded(text);
  };

  const handleMessage = (message: ServerMessage) => {
    if (message.type !== "event") return;
    const { event, payload } = message;
    if (event === events.lobbyRooms) {
      handlers.lobbyRooms(payload);
      return;
    }
    if (event === events.snapshot) {
      const previous = sync.snapshot.baseline();
      const snapshot = sync.snapshot.consume(payload);
      // 入房在途的推送只进同步基线：展示态等 ACK 落定后一次安装（Engineering §5）。
      if (snapshot && !entry.isPending()) handlers.snapshot(snapshot, previous);
      return;
    }
    if (event === events.privateState) {
      const privateState = sync.privateState.consume(payload);
      if (privateState && !entry.isPending()) handlers.privateState(privateState);
      return;
    }
    const extra = extraEvents.get(event);
    if (extra) {
      extra(payload);
      return;
    }
    const ended = endedEvents.get(event);
    if (ended !== undefined) {
      const endedPayload = payload as EndedRoomPayload;
      endRoom(endedPayload, typeof ended === "function" ? ended(endedPayload) : ended);
      return;
    }
    if (event === "server.shutdown") handlers.shutdown(payload);
  };

  const handleStatus = (connected: boolean) => {
    if (status.generationOn === "everyStatus" || !connected) generation += 1;
    if (status.syncOn === "resetOnEveryStatus") sync.reset();
    status.write(connected);
    if (!connected) return;
    if (status.syncOn === "resetOnConnect") sync.reset();
    else if (status.syncOn === "clearRevisionsOnConnect") sync.clearRevisions();
    status.subscribeLobby();
    if (status.restore.by !== "runtime") return;
    const { roomId, sessionToken } = identity();
    if (roomId && sessionToken) {
      tokens.save(roomId, sessionToken);
      void status.restore.reconnect(roomId).catch(() => {});
    }
  };

  const init = () => {
    if (initialized) return () => {};
    initialized = true;
    const unsubscribeMessage = ws.onMessage(handleMessage);
    const unsubscribeStatus = ws.onStatus(handleStatus);
    ws.connect();
    return () => {
      initialized = false;
      if (cleanup.disconnectFirst) ws.disconnect();
      unsubscribeMessage();
      unsubscribeStatus();
      if (cleanup.bumpGeneration) generation += 1;
      if (!cleanup.disconnectFirst) ws.disconnect();
      cleanup.finish();
    };
  };

  return {
    init,
    handleMessage,
    sync,
    generation: () => generation,
    isInitialized: () => initialized,
    enter: (request, signal) => entry.enter(request, signal),
    restore: (key, request, onFailure, signal) => entry.restore(key, request, onFailure, signal),
    cancelEntry: () => entry.cancel(),
    isEntering: () => entry.isPending(),
    sendCommand,
  };
}
