import { createHash, randomUUID } from "node:crypto";
import { LRUCache } from "lru-cache";
import { AppError } from "../domain/Errors";
import { validateCEESettings } from "../domain/CEERules";
import { safeEqualToken } from "../domain/Rules";
import type { ConnectionRecord } from "../shared/Index";
import { CEEImageHints } from "../infrastructure/CEEImageHints";
import { SlidingWindowRateLimiter } from "../infrastructure/RateLimiter";
import { createCEEOriginalSocket } from "../infrastructure/CEEOriginalSocket";
import {
  originalObject,
  originalString,
  toOriginalSettings,
} from "../infrastructure/CEEOriginalProtocol";
import {
  createDefaultCEESettings,
  type CEERoomClientMessage,
  type CEEPayload,
  type CEERoomEnterResult,
  type CEESettings,
} from "../shared/CEE";
import {} from "./CEEOriginalEvents";
import { createEvent } from "../transport/Packets";
import type { CEEOriginalChatRoom, CEEOriginalSession, CEEUpstreamRoom } from "./CEEOriginalModel";
import type { CEEOriginalTarget } from "./CEERoomDirectory";
import { originalPrivateState, originalSnapshot } from "./CEEOriginalView";
import { runCEEDataCommand } from "./CEEDataCommands";
import {
  cancelPreparation,
  selfOf,
  publish,
  requireHost,
  revoke,
  upstreamConfirmed,
  upstreamRequest,
  type CEEOriginalContext,
  type CEEOriginalOptions,
} from "./CEEOriginalContext";
import { fetchRooms, listUpstreamRooms } from "./CEEOriginalLobby";
import {
  enterChoosingSetter,
  leaveChoosingSetter,
  requestImageHint,
  startRound,
  submitAnswer,
  submitGuess,
} from "./CEEOriginalRoundFlow";
import { listenToUpstream } from "./CEEOriginalGameEvents";

export class CEEOriginalService {
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly sessions = new Map<string, CEEOriginalSession>();
  private readonly byConnection = new Map<string, CEEOriginalSession>();
  private readonly entering = new Set<string>();
  private readonly chats = new Map<string, CEEOriginalChatRoom>();
  private readonly chatLimiter = new SlidingWindowRateLimiter({ windowMs: 10_000, maxRequests: 8 });
  private readonly now: () => number;
  private readonly fetcher: NonNullable<CEEOriginalOptions["fetcher"]>;
  private readonly imageHints: Pick<CEEImageHints, "render">;
  private readonly ctx: CEEOriginalContext;
  readonly sourceKey: string;
  readonly configured: boolean;

  constructor(private readonly options: CEEOriginalOptions) {
    this.now = options.now || Date.now;
    this.fetcher = options.fetcher || fetch;
    this.imageHints = options.imageHints || new CEEImageHints();
    this.configured = !!options.serverUrl && !!options.aesSecret;
    if (options.serverUrl) {
      const url = new URL(options.serverUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new AppError("CEE_ORIGINAL_CONFIG", "原版地址必须是无凭据的 HTTP 或 HTTPS 地址");
      }
    }
    this.ctx = {
      options,
      connections: this.connections,
      sessions: this.sessions,
      byConnection: this.byConnection,
      chats: this.chats,
      now: this.now,
      fetcher: this.fetcher,
      imageHints: this.imageHints,
      configured: this.configured,
    };
    this.sourceKey = createHash("sha256")
      .update(options.serverUrl || "")
      .digest("hex")
      .slice(0, 12);
  }

  registerConnection(connection: ConnectionRecord): void {
    this.connections.set(connection.id, connection);
  }
  unregisterConnection(id: string): void {
    this.connections.delete(id);
    const session = this.byConnection.get(id);
    this.byConnection.delete(id);
    if (session) {
      cancelPreparation(session);
      session.connectionId = undefined;
      session.detachedAt = this.now();
    }
  }
  hasSession(id: string): boolean {
    return this.byConnection.has(id) || this.entering.has(id);
  }
  getHealthSnapshot() {
    return {
      configured: this.configured,
      sessions: this.sessions.size,
      rooms: this.chats.size,
      onlineSessions: [...this.sessions.values()].filter(
        (session) => session.confirmed && session.connectionId && session.socket.connected
      ).length,
    };
  }

  /** 上游完整房间列表（含非公开房），供统一房号目录分配别名；大厅只展示其中的公开房。 */
  async listUpstreamRooms(): Promise<CEEUpstreamRoom[]> {
    return listUpstreamRooms(this.ctx);
  }

  /** 仍有本地会话（含建房确认途中）的上游房号：这些房间的别名不能释放。 */
  activeUpstreamRoomIds(): Set<string> {
    return new Set([...this.sessions.values()].map((session) => session.roomId));
  }

  assertAvailable(): void {
    if (!this.configured)
      throw new AppError("CEE_ORIGINAL_UNAVAILABLE", "原版服务器兼容配置尚未完成");
  }

  /** 在原版服务器建房；`target` 由统一房号目录占号得到，别名与上游房号相同。 */
  async create(
    connectionId: string,
    target: CEEOriginalTarget,
    payload: CEEPayload<"cee.room.create">
  ): Promise<CEERoomEnterResult> {
    const connection = this.requireConnection(connectionId);
    if (connection.isAgent === true || connection.agentDriven?.() === true)
      throw new AppError("AGENTS_NOT_ALLOWED", "原版房不支持 Agent 进入");
    if (payload.password || !payload.allowSpectators)
      this.unsupported("原版房间不支持密码或禁止观战");
    return this.enterOnce(connection, target, payload.userName, payload);
  }

  async join(
    connectionId: string,
    target: CEEOriginalTarget,
    payload: CEEPayload<"cee.room.join">
  ): Promise<CEERoomEnterResult> {
    const connection = this.requireConnection(connectionId);
    if (connection.isAgent === true || connection.agentDriven?.() === true)
      throw new AppError("AGENTS_NOT_ALLOWED", "原版房不支持 Agent 进入");
    if (payload.password) this.unsupported("原版房间不支持密码");
    return this.enterOnce(connection, target, payload.userName);
  }

  reconnect(
    connectionId: string,
    target: CEEOriginalTarget,
    token: string | null | undefined
  ): CEERoomEnterResult {
    const connection = this.requireConnection(connectionId);
    // 载荷里的凭据允许为空/缺席（解析层不拦可恢复状态），这里给出明确的失效语义。
    if (!token) throw new AppError("SESSION_EXPIRED", "原版会话已失效，请重新加入房间");
    return this.resume(connection, target, token);
  }

  /** 已进入原版房间后的指令；信封房号是客户端见到的别名。 */
  async execute(connectionId: string, message: CEERoomClientMessage): Promise<unknown> {
    this.requireConnection(connectionId);
    const session = this.requireSession(connectionId);
    if (!safeEqualToken(message.sessionToken, session.token))
      throw new AppError("SESSION_INVALID", "原版会话凭据无效，请重新加入");
    if (message.roomId && message.roomId !== session.alias)
      throw new AppError("ROOM_NOT_FOUND", "房间与当前会话不一致");
    // 离房撤销是生命周期边界，不能排在悬挂的资料查询后等待。
    if (message.type === "cee.room.leave") {
      revoke(this.ctx, session, "已离开房间", false);
      return {};
    }
    const task = session.queue.then(() => {
      if (
        session.connectionId !== connectionId ||
        this.byConnection.get(connectionId) !== session ||
        !this.connections.has(connectionId)
      ) {
        throw new AppError("CEE_ROUND_CHANGED", "操作连接已变化，请重新操作");
      }
      return this.executeInRoom(session, message);
    });
    session.queue = task.catch(() => undefined);
    return task;
  }

  private requireConnection(connectionId: string): ConnectionRecord {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new AppError("CONNECTION_NOT_FOUND", "连接不存在或已断开");
    this.assertAvailable();
    return connection;
  }

  private sendToRoom(
    session: CEEOriginalSession,
    event: string,
    payload: Record<string, unknown> = {}
  ): Promise<unknown> {
    return upstreamRequest(this.ctx, session.socket, event, { roomId: session.roomId, ...payload });
  }

  /** 房主没有准备态，开局只看其他玩家，与增强房一致。 */
  private async toggleReady(session: CEEOriginalSession, ready: boolean): Promise<unknown> {
    if (selfOf(session).isHost || selfOf(session).ready === ready) return {};
    await upstreamConfirmed(
      this.ctx,
      session.socket,
      "updatePlayers",
      () => selfOf(session).ready === ready,
      () => session.socket.emit("toggleReady", { roomId: session.roomId })
    );
    return {};
  }

  /** 出题方式不经上游：先记在本服务端同房的所有会话上，上游回推设置时沿用这一项。 */
  private async applyRoomSettings(
    session: CEEOriginalSession,
    settings: CEESettings
  ): Promise<unknown> {
    requireHost(session);
    validateCEESettings(settings);
    const { answerMode } = settings;
    for (const peer of this.sessions.values())
      if (peer.roomId === session.roomId) peer.settings = { ...peer.settings, answerMode };
    return this.sendToRoom(session, "updateGameSettings", {
      settings: toOriginalSettings(settings),
    });
  }

  private async chooseSetter(session: CEEOriginalSession, playerId: string): Promise<unknown> {
    requireHost(session);
    if (session.phase !== "choosingSetter")
      throw new AppError("INVALID_PHASE", "请先开始游戏再指定出题人");
    await this.sendToRoom(session, "enterManualMode");
    const result = await this.sendToRoom(session, "setAnswerSetter", { setterId: playerId });
    // 上游确认出题人后会推 waitForAnswer 切到出题阶段；还没到的话先退出选人阶段，免得停在这里。
    if (session.phase === "choosingSetter") leaveChoosingSetter(session);
    publish(this.ctx, session);
    return result;
  }

  private async executeInRoom(
    session: CEEOriginalSession,
    message: CEERoomClientMessage
  ): Promise<unknown> {
    if (!session.confirmed || session.revoked || !session.socket.connected)
      throw new AppError("CEE_ORIGINAL_DISCONNECTED", "原版连接已中断，请重新加入");
    const { data } = this.options;
    const send = (event: string, payload: Record<string, unknown> = {}) =>
      this.sendToRoom(session, event, payload);
    switch (message.type) {
      case "cee.room.requestSync":
        if (session.connectionId) this.connections.get(session.connectionId)?.resetStateSync?.();
        publish(this.ctx, session);
        return this.enterResult(session);
      case "cee.character.search":
        return runCEEDataCommand(data, message.type, message.payload);
      case "cee.subject.search":
        this.requireSubjectSearch(session);
        return runCEEDataCommand(data, message.type, message.payload);
      case "cee.subject.characters":
        this.requireSubjectSearch(session);
        return runCEEDataCommand(data, message.type, message.payload);
      case "cee.subject.lookup":
        return runCEEDataCommand(data, message.type, message.payload);
      case "cee.directory.import":
        // 导入会改本地的目录库，并占用耗时的后台任务：与增强房同一口径，只有房主能在等待阶段发起。
        requireHost(session);
        this.requireWaiting(session);
        return runCEEDataCommand(data, message.type, message.payload);
      case "cee.character.image":
        return runCEEDataCommand(data, message.type, message.payload);
      case "cee.subject.image":
        return runCEEDataCommand(data, message.type, message.payload);
      case "cee.game.imageHint":
        return requestImageHint(this.ctx, session);
      case "cee.chat.send":
        return this.chat(session, message.payload.text);
      case "cee.player.team":
        return send("updatePlayerTeam", {
          team: message.payload.team === null ? null : String(message.payload.team),
        });
      case "cee.player.spectate":
        return send("updatePlayerTeam", { team: message.payload.spectator ? "0" : null });
      case "cee.player.ready":
        return this.toggleReady(session, message.payload.ready);
      case "cee.room.settings":
        return this.applyRoomSettings(session, message.payload.settings);
      case "cee.room.update": {
        requireHost(session);
        if (!message.payload.allowSpectators) this.unsupported("原版房间不支持禁止观战");
        await this.updateRoom(
          session,
          message.payload.name,
          message.payload.visibility === "public"
        );
        return {};
      }
      case "cee.room.kick":
        requireHost(session);
        return send("kickPlayer", { playerId: message.payload.playerId });
      case "cee.room.transferHost":
        requireHost(session);
        return send("transferHost", { newHostId: message.payload.playerId });
      case "cee.game.chooseSetter":
        return this.chooseSetter(session, message.payload.playerId);
      case "cee.game.start":
      case "cee.game.next":
        if (session.settings.answerMode === "manual") return enterChoosingSetter(this.ctx, session);
        return startRound(this.ctx, session);
      case "cee.game.setAnswer":
        return submitAnswer(this.ctx, session, message.payload.characterId, message.payload.hints);
      case "cee.game.guess":
        return submitGuess(this.ctx, session, message.payload.characterId);
      case "cee.game.surrender":
        return send("enterObserverMode");
      case "cee.game.cancel":
        // 选人阶段只在本服务端，可以退回；进入出题后原版服务器没有取消指令。
        if (session.phase === "choosingSetter") {
          requireHost(session);
          leaveChoosingSetter(session);
          publish(this.ctx, session);
          return {};
        }
        return this.unsupported("原版服务器没有取消出题或中止对局的指令，可重新指定出题人");
      default:
        return this.unsupported("当前原版房间不支持此操作");
    }
  }

  private async enter(
    connection: ConnectionRecord,
    target: CEEOriginalTarget,
    name: string,
    create?: { name: string; visibility: "public" | "private" }
  ): Promise<CEERoomEnterResult> {
    const roomId = target.upstreamRoomId;
    if (connection.roomId || this.byConnection.has(connection.id))
      throw new AppError("ALREADY_IN_ROOM", "请先离开当前房间");
    if (!create && !(await fetchRooms(this.ctx)).some((room) => room.id === roomId))
      throw new AppError("ROOM_NOT_FOUND", "原版房间不存在");
    if (!this.connections.has(connection.id))
      throw new AppError("CONNECTION_NOT_FOUND", "加入期间连接已断开");
    const socket = (this.options.socketFactory || createCEEOriginalSocket)(this.options.serverUrl!);
    const session: CEEOriginalSession = {
      token: `cee_original_${this.sourceKey}_${randomUUID()}`,
      connectionId: connection.id,
      roomId,
      alias: target.roomId,
      name,
      socket,
      // 出题方式只记在本服务端：同房已有会话的话沿用它的取值，后来者不会被默认值带回随机出题。
      confirmed: false,
      revoked: false,
      players: [],
      phase: "waiting",
      settings: { ...createDefaultCEESettings(), answerMode: this.peerAnswerMode(roomId) },
      roomName: "",
      isPublic: true,
      setterId: null,
      roundNumber: 0,
      syncRound: 1,
      roundKey: null,
      answer: null,
      hints: [],
      guesses: [],
      bannedTags: new Map(),
      winners: [],
      roundSummary: null,
      deadlineAt: null,
      queue: Promise.resolve(),
    };
    this.sessions.set(session.token, session);
    this.byConnection.set(connection.id, session);
    listenToUpstream(this.ctx, session);
    try {
      await upstreamConfirmed(
        this.ctx,
        socket,
        "connect",
        () => true,
        () => socket.connect()
      );
      // 原版会自行裁剪/规范化用户名，谓词不能做全等比对，否则加入确认要等到 8s 超时才失败。
      const expected = name.trim();
      await upstreamConfirmed(
        this.ctx,
        socket,
        "updatePlayers",
        () =>
          session.players.some(
            (player) => player.id === socket.id && player.name.trim() === expected
          ),
        () => socket.emit(create ? "createRoom" : "joinRoom", { roomId, username: name.trim() })
      );
      if (!this.connections.has(connection.id))
        throw new AppError("CONNECTION_NOT_FOUND", "加入期间连接已断开");
      session.confirmed = true;
      if (!this.chats.has(roomId))
        this.chats.set(roomId, {
          generation: randomUUID(),
          chat: [],
          seenRoundKeys: new LRUCache({ max: 256 }),
        });
      // 后来者沿用共享房间已知局数；否则在下一次开局前，顶栏局数与同房其他人不一致。
      session.roundNumber = this.chats.get(roomId)!.round?.number ?? 0;
      this.adoptChatHistory(this.chats.get(roomId)!, connection.tabKey, socket.id);
      connection.resetStateSync?.();
      connection.roomId = `original:${roomId}`;
      connection.playerId = socket.id;
      if (create) {
        await upstreamRequest(this.ctx, socket, "updateGameSettings", {
          roomId,
          settings: toOriginalSettings(session.settings),
        });
        await this.updateRoom(session, create.name, create.visibility === "public");
      } else socket.emit("requestGameSettings", { roomId });
      publish(this.ctx, session);
      return this.enterResult(session);
    } catch (error) {
      revoke(this.ctx, session, "无法加入原版房间", false);
      throw error;
    }
  }

  /** 同一张标签页换了上游 socket 后，本地聊天记录仍算它发的；没有标签页身份的连接不做关联。 */
  private adoptChatHistory(
    room: CEEOriginalChatRoom,
    tabKey: string | undefined,
    playerId: string | undefined
  ): void {
    if (!tabKey || !playerId) return;
    const authors = (room.chatAuthors ??= new Map());
    const previous = authors.get(tabKey);
    authors.set(tabKey, playerId);
    if (!previous || previous === playerId) return;
    room.chat = room.chat.map((message) =>
      message.playerId === previous ? { ...message, playerId } : message
    );
  }

  private async enterOnce(
    connection: ConnectionRecord,
    target: CEEOriginalTarget,
    name: string,
    create?: { name: string; visibility: "public" | "private" }
  ): Promise<CEERoomEnterResult> {
    if (this.entering.has(connection.id))
      throw new AppError("CEE_JOIN_PENDING", "正在加入原版房间，请稍候");
    this.entering.add(connection.id);
    try {
      return await this.enter(connection, target, name, create);
    } finally {
      this.entering.delete(connection.id);
    }
  }

  private resume(
    connection: ConnectionRecord,
    target: CEEOriginalTarget,
    token: string
  ): CEERoomEnterResult {
    const session = this.sessions.get(token);
    const roomId = target.upstreamRoomId;
    if (
      !session ||
      session.roomId !== roomId ||
      !session.confirmed ||
      session.revoked ||
      !session.socket.connected ||
      (session.detachedAt !== undefined && this.now() - session.detachedAt >= 60_000)
    ) {
      throw new AppError("SESSION_EXPIRED", "原版会话已失效，请重新加入房间");
    }
    if (connection.roomId && this.byConnection.get(connection.id) !== session)
      throw new AppError("ALREADY_IN_ROOM", "请先离开当前房间");
    if (session.connectionId && session.connectionId !== connection.id) {
      const previous = this.connections.get(session.connectionId);
      // 旧连接多半已经死了（换页面才会恢复），通知不许抛：顶号失败会把新连接一起挡在门外。
      try {
        previous?.send(createEvent("session.replaced", { reason: "已在其他页面恢复原版房间" }));
      } catch {
        /* 发不出去就不发，接管照常 */
      }
      if (previous) {
        previous.roomId = undefined;
        previous.playerId = undefined;
      }
      this.byConnection.delete(session.connectionId);
    }
    cancelPreparation(session);
    session.connectionId = connection.id;
    session.detachedAt = undefined;
    this.byConnection.set(connection.id, session);
    connection.roomId = `original:${roomId}`;
    connection.playerId = session.socket.id;
    connection.resetStateSync?.();
    publish(this.ctx, session);
    return this.enterResult(session);
  }

  private async updateRoom(
    session: CEEOriginalSession,
    name: string,
    isPublic: boolean
  ): Promise<void> {
    if (name !== session.roomName)
      await upstreamConfirmed(
        this.ctx,
        session.socket,
        "roomNameUpdated",
        (payload) => originalString(originalObject(payload).roomName) === name.trim().slice(0, 30),
        () => session.socket.emit("updateRoomName", { roomId: session.roomId, roomName: name })
      );
    if (isPublic !== session.isPublic)
      await upstreamConfirmed(
        this.ctx,
        session.socket,
        "updatePlayers",
        () => session.isPublic === isPublic,
        () => session.socket.emit("toggleRoomVisibility", { roomId: session.roomId })
      );
  }

  private peerAnswerMode(roomId: string): CEESettings["answerMode"] {
    for (const peer of this.sessions.values())
      if (peer.roomId === roomId && peer.confirmed) return peer.settings.answerMode;
    return "random";
  }

  private chat(session: CEEOriginalSession, text: string): unknown {
    const connectionId = session.connectionId;
    // 桶键用服务端分配的连接号，不用会话凭据：凭据每次进房都重新签发，
    // 离开再进来就换一个全新桶，配额变成「每次重进送 8 条」；同时签发过的凭据个数没有上限，
    // 限流 Map 会随对方重进的次数一直长。
    if (!connectionId || !this.chatLimiter.allow(connectionId, this.now()))
      throw new AppError("CHAT_RATE_LIMIT", "发送消息太快，请稍后重试");
    const me = selfOf(session);
    const room = this.chats.get(session.roomId)!;
    const message = {
      id: `cee_chat_${randomUUID()}`,
      playerId: me.id,
      playerName: me.name,
      text: text.trim(),
      createdAt: this.now(),
      system: false,
    };
    if (!message.text) throw new AppError("CHAT_EMPTY", "消息不能为空");
    room.chat = [...room.chat, message].slice(-100);
    for (const peer of this.sessions.values())
      if (peer.confirmed && peer.roomId === session.roomId) publish(this.ctx, peer);
    return { message };
  }

  private requireSession(id: string): CEEOriginalSession {
    const session = this.byConnection.get(id);
    if (!session?.confirmed) throw new AppError("NOT_IN_ROOM", "尚未加入原版房间");
    return session;
  }
  private requireWaiting(session: CEEOriginalSession): void {
    if (session.phase !== "waiting") throw new AppError("INVALID_PHASE", "请在等待阶段修改");
  }
  private requireSubjectSearch(session: CEEOriginalSession): void {
    if (
      session.phase === "guessing" &&
      !session.settings.subjectSearch &&
      !originalPrivateState(session).answer
    ) {
      throw new AppError("SUBJECT_SEARCH_DISABLED", "本局关闭了作品搜索");
    }
  }
  private unsupported(message: string): never {
    throw new AppError("CEE_ORIGINAL_UNSUPPORTED", message);
  }
  private enterResult(session: CEEOriginalSession): CEERoomEnterResult {
    return {
      roomId: session.alias,
      source: "original",
      sessionToken: session.token,
      snapshot: originalSnapshot(session, this.chats.get(session.roomId)),
      privateState: originalPrivateState(session),
    };
  }
  runHousekeeping(): void {
    for (const session of this.sessions.values()) {
      if (session.detachedAt !== undefined && this.now() - session.detachedAt >= 60_000)
        revoke(this.ctx, session, "重连等待已结束", false);
      else publish(this.ctx, session, true);
    }
  }
  close(): void {
    for (const session of this.sessions.values()) revoke(this.ctx, session, "服务已关闭", false);
    this.connections.clear();
  }
}
