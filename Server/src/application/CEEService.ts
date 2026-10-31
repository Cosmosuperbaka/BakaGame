import type { AdminRoomControl, AdminRoomView } from "../domain/AdminRoom";
import type { SnapshottedRoom } from "../shared/RoomSnapshot";
import type { GameRecorder } from "../domain/GameRecord";
import type {
  CEEClientMessage,
  CEERoomClientMessage,
  CEERoomEnterResult,
  CEERoomSummary,
  ConnectionRecord,
} from "../shared/Index";
import type { CEERankedCommand } from "../shared/CEERanked";
import { CEE_LOBBY_ROOMS_EVENT } from "../shared/CEE";
import { AppError } from "../domain/Errors";
import type { CEEDataProvider } from "../infrastructure/CEEData";
import type { EventLogger } from "../infrastructure/EventLogger";
import { SlidingWindowRateLimiter } from "../infrastructure/RateLimiter";
import { createEvent } from "../transport/Packets";
import { CEENativeService } from "./CEENativeService";
import {
  CEESearchProvenance,
  ceeCharacterIdsOf,
  type CEEAntiCheatReviewQueue,
} from "./CEEAntiCheatSignals";
import { CEERankedService } from "./CEERankedService";
import type { CEERankedPoolProvider } from "./CEERankedPool";
import type { CEERankedStore } from "./CEERankedStore";
import { CEESearchQuota, isCEESearchCommand } from "./CEESearchQuota";
import type { CEEUpstreamRoom } from "./CEEOriginalModel";
import { CEEOriginalService } from "./CEEOriginalService";
import { CEERoomDirectory, normalizeCEERoomId, type CEERoomTarget } from "./CEERoomDirectory";
import { LobbyFanout } from "./LobbyFanout";

/** 上游房间列表的缓存时长；失败后同样等待该时长再重试，避免每次房号未命中都回源。 */
const REMOTE_ROOMS_TTL_MS = 5000;

/** 统一入口的排位命令：`cee.ranked.` 前缀在类型层与运行层都用同一条判据分流。 */
type CEERankedClientMessage = Extract<CEEClientMessage, { type: CEERankedCommand }>;
const isCEERankedMessage = (message: CEEClientMessage): message is CEERankedClientMessage =>
  message.type.startsWith("cee.ranked.");

export class CEEService implements AdminRoomControl {
  readonly native: CEENativeService;
  readonly original: CEEOriginalService;
  readonly ranked: CEERankedService;
  /** 统一房号目录：增强房与原版房共用一个 4 位号空间，客户端只见到这一个号。 */
  readonly directory: CEERoomDirectory;
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly limiter = new SlidingWindowRateLimiter({ windowMs: 10000, maxRequests: 80 });
  private readonly chatLimiter = new SlidingWindowRateLimiter({ windowMs: 10000, maxRequests: 8 });
  private readonly searchQuota: CEESearchQuota;
  private readonly provenance: CEESearchProvenance;
  private readonly entering = new Set<string>();
  private readonly lobbyFanout: LobbyFanout;
  private readonly now: () => number;
  private remoteRooms: CEEUpstreamRoom[] = [];
  private remoteFetchedAt = Number.NEGATIVE_INFINITY;
  private remoteRequest: Promise<void> | null = null;
  private lastLobby = "";
  constructor(
    private readonly options: {
      data: CEEDataProvider;
      eventLogger?: EventLogger;
      serverUrl?: string;
      aesSecret?: string;
      now?: () => number;
      random?: () => number;
      originalService?: CEEOriginalService;
      /** 只记录增强房：原版房的对局在上游服务器进行，本端拿不到完整答案与全员猜测。 */
      gameRecorder?: GameRecorder;
      /** 反作弊人工复核队列：只在反作弊房产生条目，任何处罚都由人决定。 */
      reviewQueue?: CEEAntiCheatReviewQueue;
      /** 排位审计仓储；未注入时排位整体不可用。 */
      rankedStore?: CEERankedStore;
      /** 排位题库；未注入时排位整体不可用。 */
      rankedPool?: CEERankedPoolProvider;
      /** 取账号昵称作为排位显示名。 */
      resolveRankedName?: (userId: string) => Promise<string | null>;
    }
  ) {
    this.now = options.now ?? Date.now;
    this.searchQuota = new CEESearchQuota(this.now);
    this.provenance = new CEESearchProvenance(this.now);
    this.directory = new CEERoomDirectory((roomId) => this.native.state.rooms.has(roomId));
    this.native = new CEENativeService({
      ...options,
      provenance: this.provenance,
      isRoomIdReserved: (roomId) => this.directory.isAliasTaken(roomId),
    });
    this.original =
      options.originalService ??
      new CEEOriginalService({ ...options, logger: options.eventLogger });
    this.ranked = new CEERankedService({
      data: options.data,
      provenance: this.provenance,
      store: options.rankedStore,
      pool: options.rankedPool,
      resolveName: options.resolveRankedName,
      logger: options.eventLogger,
      now: options.now,
      random: options.random,
    });
    this.lobbyFanout = new LobbyFanout({
      event: CEE_LOBBY_ROOMS_EVENT,
      now: () => this.now(),
      broadcast: (payload) => this.native.state.connections.broadcastToLobby(payload),
      summaries: () => this.listRooms(),
    });
    this.native.state.onChange = () => this.broadcastLobby();
  }
  registerConnection(connection: ConnectionRecord): void {
    this.connections.set(connection.id, connection);
    this.native.registerConnection(connection);
    this.original.registerConnection(connection);
    this.ranked.registerConnection(connection);
  }
  async unregisterConnection(id: string): Promise<void> {
    const connection = this.connections.get(id);
    const isOriginal = Boolean(connection?.roomId?.startsWith("original:"));
    if (isOriginal && connection) this.native.state.connections.detach(connection);
    this.original.unregisterConnection(id);
    this.native.unregisterConnection(id);
    this.ranked.unregisterConnection(id);
    this.provenance.forget(id);
    this.connections.delete(id);
  }
  async execute(id: string, message: CEEClientMessage): Promise<unknown> {
    const connection = this.connections.get(id);
    if (!connection) throw new AppError("CONNECTION_NOT_FOUND", "连接已经断开");
    if (!this.limiter.allow(id, this.now()))
      throw new AppError("RATE_LIMITED", "操作过于频繁，请稍后再试");
    if (message.type === "cee.chat.send" && !this.chatLimiter.allow(id, this.now()))
      throw new AppError("RATE_LIMITED", "消息发送过快，请稍后再试");
    // 三条检索命令在入口统一配额：回源之后才检查会让并发请求在挂起窗口内全部穿透。
    if (isCEESearchCommand(message.type)) this.searchQuota.require(message.type, connection);
    if (isCEERankedMessage(message)) {
      const result = await this.ranked.execute(connection, message);
      // 排位检索与增强房共用台账：猜测时的「先搜后猜」判据要能查到这次检索。
      if (message.type === "cee.ranked.characterSearch")
        this.provenance.note(connection.id, ceeCharacterIdsOf(result));
      return result;
    }
    if (message.type === "cee.lobby.subscribeRooms") {
      if (connection.roomId) throw new AppError("ALREADY_IN_ROOM", "请先离开当前房间");
      connection.lobbySubscribed = true;
      await this.refreshRemote();
      const rooms = this.listRooms();
      connection.send(createEvent(CEE_LOBBY_ROOMS_EVENT, rooms));
      return { rooms, originalAvailable: this.original.configured };
    }
    if (
      message.type === "cee.room.create" ||
      message.type === "cee.room.join" ||
      message.type === "cee.room.reconnect"
    ) {
      if (connection.roomId || this.entering.has(id))
        throw new AppError("ALREADY_IN_ROOM", "请先离开当前房间，或等待加入完成");
      this.entering.add(id);
      try {
        return await this.enter(id, message);
      } finally {
        this.entering.delete(id);
        this.broadcastLobby();
      }
    }
    if (this.original.hasSession(id)) {
      if (!message.sessionToken || !connection.roomId?.startsWith("original:"))
        throw new AppError("SESSION_INVALID", "请重新加入房间");
      try {
        const result = await this.original.execute(id, message);
        return result;
      } finally {
        this.broadcastLobby();
      }
    }
    try {
      const result = await this.native.execute(id, message);
      // 检索台账只在增强房登记：原版房的答案与猜测在上游，本端拿不到可判定的对局。
      if (message.type === "cee.character.search")
        this.provenance.note(connection.id, ceeCharacterIdsOf(result));
      return result;
    } finally {
      this.broadcastLobby();
    }
  }
  /** 后台只管增强房：原版房在上游服务器，本端没有关房与移人的权限。 */
  adminListRooms(): AdminRoomView[] {
    return this.native.adminListRooms();
  }
  async adminCloseRoom(roomId: string): Promise<void> {
    this.native.adminCloseRoom(roomId);
  }
  async adminKickPlayer(roomId: string, playerId: string): Promise<void> {
    try {
      this.native.adminKickPlayer(roomId, playerId);
    } finally {
      this.broadcastLobby();
    }
  }
  /** 大厅：增强房（含带锁的私密房）在前，原版服务器的公开房按上游顺序在后。 */
  listRooms(): CEERoomSummary[] {
    const remote = this.remoteRooms
      .filter((room) => room.isPublic)
      .flatMap((room): CEERoomSummary[] => {
        const alias = this.directory.aliasOf(room.id);
        return alias
          ? [
              {
                roomId: alias,
                source: "original",
                name: room.name,
                phase: room.phase,
                playerCount: room.playerCount,
                spectatorCount: null,
                hasPassword: false,
                allowSpectators: true,
                bakaAntiCheat: false,
                allowAgents: false,
              },
            ]
          : [];
      });
    return [...this.native.listRooms(), ...remote];
  }
  getHealthSnapshot() {
    const local = this.native.getHealthSnapshot();
    const remote = this.original.getHealthSnapshot();
    return {
      roomCount: local.roomCount + remote.rooms,
      onlinePlayerCount: local.onlinePlayerCount + remote.onlineSessions,
      playerCount: local.playerCount + remote.sessions,
      connectionCount: this.connections.size,
    };
  }
  async runHousekeeping(): Promise<void> {
    this.native.runHousekeeping();
    this.original.runHousekeeping();
    this.ranked.runHousekeeping();
    if (
      [...this.connections.values()].some(
        (connection) => connection.lobbySubscribed && !connection.roomId
      )
    )
      await this.refreshRemote();
    this.broadcastLobby();
  }
  notifyShutdown(): void {
    this.native.notifyShutdown();
    this.ranked.notifyShutdown();
  }
  /** 只有本地原生房间进快照；原版房是上游代理，恢复时按上游重新同步即可。 */
  exportSnapshots(): SnapshottedRoom[] {
    return this.native.exportSnapshots();
  }
  restoreSnapshots(rooms: readonly SnapshottedRoom[], savedAt: number): number {
    return this.native.restoreSnapshots(rooms, savedAt);
  }
  async close(): Promise<void> {
    this.ranked.close();
    this.native.close();
    this.original.close();
    this.directory.clear();
    await this.options.data.close();
  }

  private async enter(
    id: string,
    message: Extract<
      CEERoomClientMessage,
      { type: "cee.room.create" | "cee.room.join" | "cee.room.reconnect" }
    >
  ): Promise<CEERoomEnterResult> {
    if (message.type === "cee.room.create") {
      if (message.payload.source === "native")
        return this.native.execute(id, message) as Promise<CEERoomEnterResult>;
      this.original.assertAvailable();
      const target = this.directory.claimOriginal(message.payload.roomId);
      try {
        return await this.original.create(id, target, message.payload);
      } catch (error) {
        this.directory.release(target.roomId);
        throw error;
      }
    }
    const roomId = message.type === "cee.room.join" ? message.roomId : message.payload.roomId;
    const target = await this.resolveRoom(roomId);
    if (target.source === "native") {
      // 增强房自己的入房流程只认规范化后的房号。
      const normalized =
        message.type === "cee.room.join"
          ? { ...message, roomId: target.roomId }
          : { ...message, payload: { ...message.payload, roomId: target.roomId } };
      return this.native.execute(id, normalized) as Promise<CEERoomEnterResult>;
    }
    return message.type === "cee.room.join"
      ? this.original.join(id, target, message.payload)
      : this.original.reconnect(id, target, message.payload.sessionToken);
  }

  /** 房号未命中时回源刷新一次（受缓存时长节流）：服务重启后的首个分享链接也能解析到原版房。 */
  private async resolveRoom(roomId: string | undefined): Promise<CEERoomTarget> {
    if (!roomId?.trim()) throw new AppError("ROOM_NOT_FOUND", "房间不存在或已关闭");
    const id = normalizeCEERoomId(roomId);
    const known = this.directory.resolve(id);
    if (known) return known;
    await this.refreshRemote();
    const refreshed = this.directory.resolve(id);
    if (!refreshed) throw new AppError("ROOM_NOT_FOUND", "房间不存在或已关闭");
    return refreshed;
  }

  private broadcastLobby(): void {
    // 内容没变就不进合并窗：CEE 的每条命令都会走到这里，不去重等于任何操作都向大厅重发整张表。
    const serialized = JSON.stringify(this.listRooms());
    if (serialized === this.lastLobby) return;
    this.lastLobby = serialized;
    this.lobbyFanout.request();
  }
  /** 只有成功的列表才对齐别名：上游暂时不可达时保留现有别名，大厅暂不展示原版房。 */
  private async refreshRemote(): Promise<void> {
    if (!this.original.configured || this.now() - this.remoteFetchedAt < REMOTE_ROOMS_TTL_MS)
      return;
    if (this.remoteRequest) return this.remoteRequest;
    this.remoteRequest = this.original
      .listUpstreamRooms()
      .then((rooms) => {
        this.directory.syncUpstream(
          rooms.map((room) => room.id),
          this.original.activeUpstreamRoomIds()
        );
        this.remoteRooms = rooms;
      })
      .catch((error: unknown) => {
        this.options.eventLogger?.warn("原版房间列表暂不可用", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.remoteRooms = [];
      })
      .finally(() => {
        this.remoteFetchedAt = this.now();
        this.remoteRequest = null;
      });
    return this.remoteRequest;
  }
}
