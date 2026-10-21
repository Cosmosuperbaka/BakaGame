import { createHash, randomUUID } from "node:crypto";
import { LRUCache } from "lru-cache";
import { AppError } from "../domain/Errors";
import { buildCEEFeedback, createCEEHints, validateCEESettings } from "../domain/CEERules";
import { safeEqualToken } from "../domain/Rules";
import type { ConnectionRecord } from "../shared/Index";
import type { CEEDataProvider } from "../infrastructure/CEEData";
import { CEEImageHints } from "../infrastructure/CEEImageHints";
import type { EventLogger } from "../infrastructure/EventLogger";
import { SlidingWindowRateLimiter } from "../infrastructure/RateLimiter";
import {
  createCEEOriginalSocket,
  originalConfirmedEvent,
  originalRequest,
  type CEEOriginalSocketFactory,
} from "../infrastructure/CEEOriginalSocket";
import {
  decodeOriginalCharacter,
  encodeOriginalCharacter,
  originalArray,
  originalCharacter,
  originalNumber,
  originalObject,
  originalPlayers,
  originalScores,
  originalSettings,
  originalString,
  originalStrings,
  toOriginalCharacter,
  toOriginalSettings,
} from "../infrastructure/CEEOriginalProtocol";
import {
  createDefaultCEESettings,
  type CEECharacterView,
  type CEEClientMessage,
  type CEEGuess,
  type CEEPayload,
  type CEERoomEnterResult,
  type CEESettings,
} from "../shared/CEE";
import { createEvent } from "../transport/Packets";
import type {
  CEEOriginalChatRoom,
  CEEOriginalPreparation,
  CEEOriginalSession,
  CEEUpstreamRoom,
} from "./CEEOriginalModel";
import type { CEEOriginalTarget } from "./CEERoomDirectory";
import { originalPrivateState, originalSnapshot } from "./CEEOriginalView";
import { CEEOriginalRoundData } from "./CEEOriginalRoundData";

interface CEEOriginalOptions {
  data: CEEDataProvider;
  serverUrl?: string;
  aesSecret?: string;
  now?: () => number;
  logger?: Pick<EventLogger, "warn">;
  socketFactory?: CEEOriginalSocketFactory;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  imageHints?: Pick<CEEImageHints, "render">;
}

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
      this.cancelPreparation(session);
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
    if (!this.configured) return [];
    return (await this.fetchRooms())
      .map((room): CEEUpstreamRoom => ({
        id: originalString(room.id),
        isPublic: room.isPublic === true,
        name:
          originalString(room.displayRoomName) ||
          originalString(room.roomName) ||
          `${originalString(room.hostName)}的房间`,
        phase: room.isGameStarted === true ? "guessing" : "waiting",
        playerCount: originalNumber(room.playerCount),
      }))
      .filter((room) => room.id);
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
    if (connection.isAgent === true)
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
    if (connection.isAgent === true)
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
  async execute(connectionId: string, message: CEEClientMessage): Promise<unknown> {
    this.requireConnection(connectionId);
    const session = this.requireSession(connectionId);
    if (!safeEqualToken(message.sessionToken, session.token))
      throw new AppError("SESSION_INVALID", "原版会话凭据无效，请重新加入");
    if (message.roomId && message.roomId !== session.alias)
      throw new AppError("ROOM_NOT_FOUND", "房间与当前会话不一致");
    // 离房撤销是生命周期边界，不能排在悬挂的资料查询后等待。
    if (message.type === "cee.room.leave") {
      this.revoke(session, "已离开房间", false);
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
    return originalRequest(session.socket, event, { roomId: session.roomId, ...payload });
  }

  /** 房主没有准备态，开局只看其他玩家，与增强房一致。 */
  private async toggleReady(session: CEEOriginalSession, ready: boolean): Promise<unknown> {
    if (this.me(session).isHost || this.me(session).ready === ready) return {};
    await originalConfirmedEvent(
      session.socket,
      "updatePlayers",
      () => this.me(session).ready === ready,
      () => session.socket.emit("toggleReady", { roomId: session.roomId })
    );
    return {};
  }

  /** 出题方式不经上游：先记在本服务端同房的所有会话上，上游回推设置时沿用这一项。 */
  private async applyRoomSettings(
    session: CEEOriginalSession,
    settings: CEESettings
  ): Promise<unknown> {
    this.requireHost(session);
    validateCEESettings(settings);
    const { answerMode } = settings;
    for (const peer of this.sessions.values())
      if (peer.roomId === session.roomId) peer.settings = { ...peer.settings, answerMode };
    return this.sendToRoom(session, "updateGameSettings", {
      settings: toOriginalSettings(settings),
    });
  }

  private async chooseSetter(session: CEEOriginalSession, playerId: string): Promise<unknown> {
    this.requireHost(session);
    if (session.phase !== "choosingSetter")
      throw new AppError("INVALID_PHASE", "请先开始游戏再指定出题人");
    await this.sendToRoom(session, "enterManualMode");
    const result = await this.sendToRoom(session, "setAnswerSetter", { setterId: playerId });
    // 上游确认出题人后会推 waitForAnswer 切到出题阶段；还没到的话先退出选人阶段，免得停在这里。
    if (session.phase === "choosingSetter") this.leaveChoosingSetter(session);
    this.publish(session);
    return result;
  }

  private async executeInRoom(
    session: CEEOriginalSession,
    message: CEEClientMessage
  ): Promise<unknown> {
    if (!session.confirmed || session.revoked || !session.socket.connected)
      throw new AppError("CEE_ORIGINAL_DISCONNECTED", "原版连接已中断，请重新加入");
    const { data } = this.options;
    const send = (event: string, payload: Record<string, unknown> = {}) =>
      this.sendToRoom(session, event, payload);
    switch (message.type) {
      case "cee.room.requestSync":
        if (session.connectionId) this.connections.get(session.connectionId)?.resetStateSync?.();
        this.publish(session);
        return this.enterResult(session);
      case "cee.character.search":
        return { results: await data.searchCharacters(message.payload.keyword) };
      case "cee.subject.search":
        this.requireSubjectSearch(session);
        return { results: await data.searchSubjects(message.payload.keyword) };
      case "cee.subject.characters":
        this.requireSubjectSearch(session);
        return { results: await data.getSubjectCharacters(message.payload.subjectId) };
      case "cee.subject.lookup":
        return { results: await data.getSubjects(message.payload.subjectIds) };
      case "cee.directory.import":
        return data.importDirectory(message.payload.indexId);
      case "cee.character.image":
        return {
          imageUrl: await data.resolveCharacterImage(
            message.payload.characterId,
            message.payload.size ?? "grid"
          ),
        };
      case "cee.subject.image":
        return { imageUrl: await data.resolveSubjectImage(message.payload.subjectId) };
      case "cee.game.imageHint":
        return this.imageHint(session);
      case "cee.chat.send":
        return this.chat(session, message.payload.text);
      case "cee.chat.plusOne":
        return this.plusOne(session, message.payload.messageId);
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
        this.requireHost(session);
        if (!message.payload.allowSpectators) this.unsupported("原版房间不支持禁止观战");
        await this.updateRoom(
          session,
          message.payload.name,
          message.payload.visibility === "public"
        );
        return {};
      }
      case "cee.room.kick":
        this.requireHost(session);
        return send("kickPlayer", { playerId: message.payload.playerId });
      case "cee.room.transferHost":
        this.requireHost(session);
        return send("transferHost", { newHostId: message.payload.playerId });
      case "cee.game.chooseSetter":
        return this.chooseSetter(session, message.payload.playerId);
      case "cee.game.start":
      case "cee.game.next":
        if (session.settings.answerMode === "manual") return this.enterChoosingSetter(session);
        return this.start(session);
      case "cee.game.setAnswer":
        return this.setAnswer(session, message.payload.characterId, message.payload.hints);
      case "cee.game.guess":
        return this.guess(session, message.payload.characterId);
      case "cee.game.surrender":
        return send("enterObserverMode");
      case "cee.game.cancel":
        // 选人阶段只在本服务端，可以退回；进入出题后原版服务器没有取消指令。
        if (session.phase === "choosingSetter") {
          this.requireHost(session);
          this.leaveChoosingSetter(session);
          this.publish(session);
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
    if (!create && !(await this.fetchRooms()).some((room) => room.id === roomId))
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
    this.listen(session);
    try {
      await originalConfirmedEvent(
        socket,
        "connect",
        () => true,
        () => socket.connect()
      );
      // 原版会自行裁剪/规范化用户名，谓词不能做全等比对，否则加入确认要等到 8s 超时才失败。
      const expected = name.trim();
      await originalConfirmedEvent(
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
      connection.resetStateSync?.();
      connection.roomId = `original:${roomId}`;
      connection.playerId = socket.id;
      if (create) {
        await originalRequest(socket, "updateGameSettings", {
          roomId,
          settings: toOriginalSettings(session.settings),
        });
        await this.updateRoom(session, create.name, create.visibility === "public");
      } else socket.emit("requestGameSettings", { roomId });
      this.publish(session);
      return this.enterResult(session);
    } catch (error) {
      this.revoke(session, "无法加入原版房间", false);
      throw error;
    }
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
    this.cancelPreparation(session);
    session.connectionId = connection.id;
    session.detachedAt = undefined;
    this.byConnection.set(connection.id, session);
    connection.roomId = `original:${roomId}`;
    connection.playerId = session.socket.id;
    connection.resetStateSync?.();
    this.publish(session);
    return this.enterResult(session);
  }

  private async updateRoom(
    session: CEEOriginalSession,
    name: string,
    isPublic: boolean
  ): Promise<void> {
    if (name !== session.roomName)
      await originalConfirmedEvent(
        session.socket,
        "roomNameUpdated",
        (payload) => originalString(originalObject(payload).roomName) === name.trim().slice(0, 30),
        () => session.socket.emit("updateRoomName", { roomId: session.roomId, roomName: name })
      );
    if (isPublic !== session.isPublic)
      await originalConfirmedEvent(
        session.socket,
        "updatePlayers",
        () => session.isPublic === isPublic,
        () => session.socket.emit("toggleRoomVisibility", { roomId: session.roomId })
      );
  }

  private beginPreparation(session: CEEOriginalSession): CEEOriginalPreparation {
    const phase = session.phase;
    if (
      !session.connectionId ||
      (phase !== "waiting" && phase !== "settled" && phase !== "answering")
    ) {
      throw new AppError("CEE_ROUND_CHANGED", "准备状态已变化");
    }
    const room = this.chats.get(session.roomId)!;
    const operation: CEEOriginalPreparation = {
      id: randomUUID(),
      connectionId: session.connectionId,
      phase,
      hostId: session.players.find((player) => player.isHost)?.id || "",
      setterId: session.setterId,
      roomGeneration: room.generation,
      roundKey: room.round?.id ?? null,
      settings: structuredClone(session.settings),
    };
    session.preparation = operation;
    if (phase !== "answering") {
      session.phase = "preparing";
      this.publish(session);
    }
    return operation;
  }

  private ownsPreparation(session: CEEOriginalSession, operation: CEEOriginalPreparation): boolean {
    const room = this.chats.get(session.roomId);
    const phase = operation.phase === "answering" ? "answering" : "preparing";
    const state = originalPrivateState({ ...session, phase: operation.phase });
    return (
      session.preparation?.id === operation.id &&
      !session.revoked &&
      session.confirmed &&
      session.socket.connected &&
      session.connectionId === operation.connectionId &&
      this.connections.has(operation.connectionId) &&
      this.byConnection.get(operation.connectionId) === session &&
      session.phase === phase &&
      room?.generation === operation.roomGeneration &&
      (room.round?.id ?? null) === operation.roundKey &&
      (session.players.find((player) => player.isHost)?.id || "") === operation.hostId &&
      session.setterId === operation.setterId &&
      (operation.phase === "answering" ? state.canSetAnswer : state.canStart)
    );
  }

  private requirePreparation(session: CEEOriginalSession, operation: CEEOriginalPreparation): void {
    if (!this.ownsPreparation(session, operation))
      throw new AppError("CEE_ROUND_CHANGED", "准备操作已失效，请重新操作");
  }

  private cancelPreparation(session: CEEOriginalSession): void {
    const operation = session.preparation;
    if (!operation) return;
    if (session.phase === "preparing") session.phase = operation.phase;
    delete session.preparation;
  }

  /** 手动出题：开局条件与随机出题相同，满足后进入本服务端的选出题人阶段。 */
  private enterChoosingSetter(session: CEEOriginalSession): unknown {
    this.requireHost(session);
    if (!originalPrivateState(session).canStart)
      throw new AppError("CEE_CANNOT_START", "请等待玩家准备或本局结束");
    session.choosingSetterFrom = session.phase === "settled" ? "settled" : "waiting";
    session.phase = "choosingSetter";
    this.publish(session);
    return {};
  }

  private peerAnswerMode(roomId: string): CEESettings["answerMode"] {
    for (const peer of this.sessions.values())
      if (peer.roomId === roomId && peer.confirmed) return peer.settings.answerMode;
    return "random";
  }

  private leaveChoosingSetter(session: CEEOriginalSession): void {
    if (session.phase === "choosingSetter") session.phase = session.choosingSetterFrom ?? "waiting";
    delete session.choosingSetterFrom;
  }

  private async start(session: CEEOriginalSession): Promise<unknown> {
    this.requireHost(session);
    if (!originalPrivateState(session).canStart)
      throw new AppError("CEE_CANNOT_START", "请等待玩家准备或本局结束");
    const operation = this.beginPreparation(session);
    try {
      const character = await this.options.data.chooseRandomCharacter(operation.settings);
      this.requirePreparation(session, operation);
      if (!character.imageUrl) {
        character.imageUrl = await this.options.data.resolveCharacterImage(character.id);
        this.requirePreparation(session, operation);
      }
      return await originalRequest(session.socket, "gameStart", {
        roomId: session.roomId,
        character: encodeOriginalCharacter(character, this.options.aesSecret!),
        settings: toOriginalSettings(operation.settings),
      });
    } finally {
      if (session.preparation?.id === operation.id) {
        this.cancelPreparation(session);
        this.publish(session);
      }
    }
  }

  private async setAnswer(
    session: CEEOriginalSession,
    id: number,
    hints: string[]
  ): Promise<unknown> {
    if (!originalPrivateState(session).canSetAnswer)
      throw new AppError("CEE_NOT_SETTER", "只有指定出题人可以提交答案");
    const operation = this.beginPreparation(session);
    try {
      const character = await this.options.data.getCharacter(id, operation.settings);
      this.requirePreparation(session, operation);
      if (!character.imageUrl) {
        character.imageUrl = await this.options.data.resolveCharacterImage(id);
        this.requirePreparation(session, operation);
      }
      return await originalRequest(session.socket, "setAnswer", {
        roomId: session.roomId,
        character: encodeOriginalCharacter(character, this.options.aesSecret!),
        hints,
      });
    } finally {
      if (session.preparation?.id === operation.id) this.cancelPreparation(session);
    }
  }

  private async guess(session: CEEOriginalSession, id: number): Promise<unknown> {
    if (!originalPrivateState(session).canGuess || !session.answer)
      throw new AppError("CEE_CANNOT_GUESS", "当前不能猜测");
    const roundKey = session.roundKey;
    const syncRound = session.syncRound;
    const attempts = this.me(session).attempts;
    const data = this.roundData(session);
    if (this.chats.get(session.roomId)!.round!.phase !== "guessing")
      throw new AppError("CEE_ROUND_CHANGED", "本局状态已变化");
    const [answer, character] = await Promise.all([
      this.supplementAnswer(session),
      data.getCharacter(id, session.settings),
    ]);
    if (
      !this.isCurrentRound(session, roundKey) ||
      session.syncRound !== syncRound ||
      this.me(session).attempts !== attempts ||
      !originalPrivateState(session).canGuess
    )
      throw new AppError("CEE_ROUND_CHANGED", "本轮状态已变化，请重新操作");
    const feedback = buildCEEFeedback(character, answer, session.settings);
    const tags = session.settings.tagBan
      ? feedback.tags.filter((tag) => tag.matched).map((tag) => tag.text)
      : [];
    const result = await originalRequest(session.socket, "playerGuess", {
      roomId: session.roomId,
      guessResult: {
        isCorrect: id === answer.id,
        isPartialCorrect: feedback.sharedAppearances.length > 0,
        guessData: toOriginalCharacter(character),
      },
      sharedMetaTags: tags,
    });
    if (!this.isCurrentRound(session, roundKey))
      throw new AppError("CEE_ROUND_CHANGED", "本局状态已变化");
    // 旧部署只有独立标签事件；新部署在猜测事务中登记并通过 ACK 确认。
    if (
      result.tagBanApplied !== true &&
      tags.length &&
      this.isCurrentRound(session, roundKey) &&
      session.phase === "guessing" &&
      this.chats.get(session.roomId)?.round?.phase === "guessing"
    ) {
      session.socket.emit("tagBanSharedMetaTags", { roomId: session.roomId, tags });
    }
    return result;
  }

  private roundData(session: CEEOriginalSession): CEEOriginalRoundData {
    if (!this.isCurrentRound(session)) throw new AppError("CEE_ROUND_CHANGED", "本局状态已变化");
    return this.chats.get(session.roomId)!.round!.data;
  }

  private isCurrentRound(session: CEEOriginalSession, key = session.roundKey): boolean {
    return (
      !session.revoked &&
      key !== null &&
      session.roundKey === key &&
      this.chats.get(session.roomId)?.round?.id === key
    );
  }

  private async supplementAnswer(session: CEEOriginalSession): Promise<CEECharacterView> {
    const key = session.roundKey;
    if (!session.answer) throw new AppError("CEE_ROUND_CHANGED", "本局状态已变化");
    const answer = await this.roundData(session).supplement(session.answer);
    if (!this.isCurrentRound(session, key))
      throw new AppError("CEE_ROUND_CHANGED", "本局状态已变化");
    session.answer = answer;
    if (session.roundSummary) session.roundSummary.answer = answer;
    return answer;
  }

  private async imageHint(session: CEEOriginalSession): Promise<{ dataUrl: string }> {
    this.roundData(session);
    const state = originalPrivateState(session);
    if (!state.imageHintAvailable || !session.answer)
      throw new AppError("CEE_HINT_LOCKED", "图片提示尚未解锁");
    const roundKey = session.roundKey;
    const image =
      session.answer.imageUrl || (await this.options.data.resolveCharacterImage(session.answer.id));
    if (!image) throw new AppError("CEE_IMAGE_UNAVAILABLE", "暂时无法取得图片提示");
    const dataUrl = await this.imageHints.render(image, Math.max(1, state.imageHintLevel));
    if (!this.isCurrentRound(session, roundKey))
      throw new AppError("CEE_ROUND_CHANGED", "本局状态已变化");
    return { dataUrl };
  }

  private chat(session: CEEOriginalSession, text: string): unknown {
    const connectionId = session.connectionId;
    // 桶键用服务端分配的连接号，不用会话凭据：凭据每次进房都重新签发，
    // 离开再进来就换一个全新桶，配额变成「每次重进送 8 条」；同时签发过的凭据个数没有上限，
    // 限流 Map 会随对方重进的次数一直长。
    if (!connectionId || !this.chatLimiter.allow(connectionId, this.now()))
      throw new AppError("CHAT_RATE_LIMIT", "发送消息太快，请稍后重试");
    const me = this.me(session);
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
      if (peer.confirmed && peer.roomId === session.roomId) this.publish(peer);
    return { message };
  }

  private plusOne(
    session: CEEOriginalSession,
    messageId: string
  ): { updated: boolean; active?: boolean; count?: number } {
    const connectionId = session.connectionId;
    if (!connectionId || !this.chatLimiter.allow(connectionId, this.now()))
      throw new AppError("CHAT_RATE_LIMIT", "操作太快，请稍后再试");
    const me = this.me(session);
    const room = this.chats.get(session.roomId)!;
    const message = room.chat.find((entry) => entry.id === messageId);
    if (!message) return { updated: false };
    if (message.system) throw new AppError("CHAT_PLUS_ONE_SYSTEM", "系统消息不能 +1");
    if (message.playerId === me.id)
      throw new AppError("CHAT_PLUS_ONE_SELF", "不能给自己的消息 +1");
    const voters = message.plusOneBy ?? [];
    const active = !voters.includes(me.id);
    message.plusOneBy = active ? [...voters, me.id] : voters.filter((id) => id !== me.id);
    for (const peer of this.sessions.values())
      if (peer.confirmed && peer.roomId === session.roomId) this.publish(peer);
    return { updated: true, active, count: message.plusOneBy.length };
  }

  private async fetchRooms(): Promise<Record<string, unknown>[]> {
    try {
      const response = await this.fetcher(new URL("/api/list-rooms", this.options.serverUrl), {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error("HTTP");
      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) throw new Error("shape");
      return payload.map(originalObject);
    } catch {
      throw new AppError("CEE_ORIGINAL_UNAVAILABLE", "暂时无法连接原版服务器");
    }
  }

  private requireSession(id: string): CEEOriginalSession {
    const session = this.byConnection.get(id);
    if (!session?.confirmed) throw new AppError("NOT_IN_ROOM", "尚未加入原版房间");
    return session;
  }
  private me(session: CEEOriginalSession) {
    const player = session.players.find((player) => player.id === session.socket.id);
    if (!player) throw new AppError("NOT_IN_ROOM", "原版房间内没有当前玩家");
    return player;
  }
  private requireHost(session: CEEOriginalSession): void {
    if (!this.me(session).isHost) throw new AppError("HOST_ONLY", "只有房主可以操作");
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
  private publish(session: CEEOriginalSession, calibration = false): void {
    if (!session.confirmed || !session.connectionId) return;
    const connection = this.connections.get(session.connectionId);
    if (!connection) return;
    const send = calibration ? connection.sendStateSyncCalibration : connection.send;
    send?.(
      createEvent("cee.room.snapshot", originalSnapshot(session, this.chats.get(session.roomId)))
    );
    send?.(createEvent("cee.game.privateState", originalPrivateState(session)));
  }

  private revoke(session: CEEOriginalSession, reason: string, notify = true, kicked = false): void {
    if (session.revoked) return;
    this.cancelPreparation(session);
    session.revoked = true;
    session.confirmed = false;
    if (session.connectionId) {
      const connection = this.connections.get(session.connectionId);
      if (notify)
        connection?.send(
          createEvent(kicked ? "cee.player.kicked" : "cee.room.closed", {
            roomId: session.alias,
            source: "original",
            reason,
          })
        );
      if (connection) {
        connection.roomId = undefined;
        connection.playerId = undefined;
      }
      this.byConnection.delete(session.connectionId);
    }
    this.sessions.delete(session.token);
    session.socket.removeAllListeners();
    session.socket.disconnect();
    if (
      ![...this.sessions.values()].some((peer) => peer.confirmed && peer.roomId === session.roomId)
    )
      this.chats.delete(session.roomId);
  }
  runHousekeeping(): void {
    for (const session of this.sessions.values()) {
      if (session.detachedAt !== undefined && this.now() - session.detachedAt >= 60_000)
        this.revoke(session, "重连等待已结束", false);
      else this.publish(session, true);
    }
  }
  close(): void {
    for (const session of this.sessions.values()) this.revoke(session, "服务已关闭", false);
    this.connections.clear();
  }

  private listen(session: CEEOriginalSession): void {
    const on = (event: string, apply: (payload: Record<string, unknown>) => void) => {
      session.socket.on(event, (value) => {
        try {
          apply(value === undefined ? {} : originalObject(value));
          this.publish(session);
        } catch {
          this.options.logger?.warn("原版房间状态转换失败", { event });
          this.revoke(session, "原版返回的房间状态无法解析，请重新加入");
        }
      });
    };
    on("updatePlayers", (payload) => {
      session.players = originalPlayers(payload.players, session.phase, session.syncRound);
      if (typeof payload.isPublic === "boolean") session.isPublic = payload.isPublic;
      if (payload.answerSetterId !== undefined)
        session.setterId = originalString(payload.answerSetterId) || null;
      if (session.preparation && !this.ownsPreparation(session, session.preparation))
        this.cancelPreparation(session);
      if (session.confirmed && !session.players.some((player) => player.id === session.socket.id))
        this.revoke(session, "已离开原版房间", true, true);
    });
    on("roomNameUpdated", (payload) => {
      session.roomName = originalString(payload.roomName);
    });
    on("updateGameSettings", (payload) => {
      this.cancelPreparation(session);
      session.settings = originalSettings(payload.settings, session.settings.answerMode);
    });
    on("waitForAnswer", (payload) => {
      this.cancelPreparation(session);
      delete session.choosingSetterFrom;
      session.setterId = originalString(payload.answerSetterId);
      session.phase = "answering";
    });
    on("waitForAnswerCanceled", () => {
      this.cancelPreparation(session);
      delete session.choosingSetterFrom;
      session.setterId = null;
      session.phase = "waiting";
    });
    on("gameStart", (payload) => this.gameStarted(session, payload));
    on("guessHistoryUpdate", (payload) => this.updateHistory(session, payload.guesses));
    on("resetTimer", (payload) => {
      session.deadlineAt = originalNumber(payload.deadlineAt) || null;
    });
    on("syncRoundStart", (payload) => {
      session.syncRound = originalNumber(payload.round, 1);
      session.players.forEach((player) => {
        player.syncCompleted = false;
      });
    });
    on("syncWaiting", (payload) => {
      session.syncRound = originalNumber(payload.round, session.syncRound);
      const completed = new Set(
        originalArray(payload.syncStatus)
          .map(originalObject)
          .filter((item) => item.completed === true)
          .map((item) => originalString(item.id))
      );
      session.players.forEach((player) => {
        player.syncCompleted = completed.has(player.id);
      });
    });
    on("tagBanStateUpdate", (payload) => {
      session.bannedTags = new Map(
        originalArray(payload.tagBanState).map((value) => {
          const entry = originalObject(value);
          return [originalString(entry.tag), new Set(originalStrings(entry.revealer))];
        })
      );
    });
    on("nonstopProgress", (payload) => {
      session.winners = originalArray(payload.winners).map((value) => {
        const winner = originalObject(value);
        return {
          playerId: session.players.find((player) => player.name === winner.username)?.id || "",
          rank: originalNumber(winner.rank),
          score: originalNumber(winner.score),
        };
      });
    });
    on("gameEnded", (payload) => {
      if (!session.answer && session.roundKey === null) return;
      this.cancelPreparation(session);
      delete session.choosingSetterFrom;
      this.updateHistory(session, payload.guesses);
      session.phase = "settled";
      session.deadlineAt = null;
      if (!session.answer) throw new AppError("CEE_ORIGINAL_PROTOCOL", "缺少本局答案");
      const scores = originalScores(payload.scoreDetails, session.players);
      session.roundSummary = {
        answer: session.answer,
        scores,
        guesses: session.guesses,
        winners: session.winners.length
          ? session.winners
          : scores
              .filter((score) => score.base > 0)
              .map((score) => ({
                playerId: score.playerId,
                rank: score.rank || 1,
                score: score.score,
              })),
      };
      const round = this.chats.get(session.roomId)?.round;
      if (round?.id === session.roundKey) round.phase = "settled";
    });
    on("playerKicked", (payload) => {
      if (payload.playerId === session.socket.id)
        this.revoke(session, "已被房主移出原版房间", true, true);
    });
    on("roomClosed", () => {
      for (const peer of this.sessions.values())
        if (peer.roomId === session.roomId) this.revoke(peer, "原版房间已关闭");
    });
    session.socket.on("disconnect", () => this.revoke(session, "原版连接已中断，请重新加入房间"));
  }

  private gameStarted(session: CEEOriginalSession, payload: Record<string, unknown>): void {
    const characterKey = createHash("sha256")
      .update(JSON.stringify(payload.character))
      .digest("hex");
    const answer = decodeOriginalCharacter(payload.character, this.options.aesSecret!);
    const settings = originalSettings(payload.settings, session.settings.answerMode);
    if (!this.chats.has(session.roomId))
      this.chats.set(session.roomId, {
        generation: randomUUID(),
        chat: [],
        seenRoundKeys: new LRUCache({ max: 256 }),
      });
    const chat = this.chats.get(session.roomId)!;
    const previous = chat.round;
    const crossedEnd =
      previous?.phase === "settled" &&
      session.roundKey === previous.id &&
      session.phase !== "guessing";
    if (
      previous &&
      characterKey !== previous.characterKey &&
      chat.seenRoundKeys.has(characterKey) &&
      !crossedEnd
    )
      return;
    // 旧连接的快照只能追上已确认的新局，不能把共享房间退回旧载荷。
    if (
      previous &&
      session.roundKey &&
      session.roundKey !== previous.id &&
      characterKey !== previous.characterKey
    )
      return;
    const nextRound = !previous || characterKey !== previous.characterKey || crossedEnd;
    if (nextRound)
      chat.round = {
        id: randomUUID(),
        number: (previous?.number ?? 0) + 1,
        characterKey,
        phase: "guessing",
        hints: Array.isArray(payload.hints)
          ? originalStrings(payload.hints)
          : createCEEHints(answer.summary, settings.useHints.length, Math.random),
        data: new CEEOriginalRoundData(this.options.data),
      };
    const round = chat.round!;
    chat.seenRoundKeys.set(characterKey, round.number);
    const key = round.id;
    const isNew = session.roundKey !== key;
    session.settings = settings;
    session.answer = answer;
    this.cancelPreparation(session);
    delete session.choosingSetterFrom;
    session.phase = "guessing";
    session.setterId = null;
    session.players = originalPlayers(payload.players, session.phase, session.syncRound);
    if (typeof payload.isPublic === "boolean") session.isPublic = payload.isPublic;
    const me = session.players.find((player) => player.id === session.socket.id);
    if (me && payload.isAnswerSetter === true) me.isSetter = true;
    session.setterId = session.players.find((player) => player.isSetter)?.id || null;
    if (isNew) {
      session.roundNumber = round.number;
      session.syncRound = 1;
      session.roundKey = key;
      session.guesses = [];
      session.bannedTags.clear();
      session.winners = [];
      session.roundSummary = null;
      session.deadlineAt = null;
    }
    session.hints = round.hints;
    void this.supplementAnswer(session)
      .then(() => this.publish(session))
      .catch(() => {
        if (this.isCurrentRound(session, key))
          this.options.logger?.warn("原版答案附加标签读取失败", { roomId: session.roomId });
      });
  }

  private updateHistory(session: CEEOriginalSession, value: unknown): void {
    if (!session.answer) return;
    const previous = new Map(session.guesses.map((guess) => [guess.id, guess]));
    session.guesses = originalArray(value).flatMap((value) => {
      const history = originalObject(value);
      return originalArray(history.guesses).map((value, index): CEEGuess => {
        const raw = originalObject(value);
        const playerId =
          originalString(raw.playerId) ||
          session.players.find((player) => player.name === history.username)?.id ||
          "";
        const id = `${session.roundNumber}:${playerId}:${index}`;
        const existing = previous.get(id);
        if (existing) return existing;
        const character = originalCharacter(raw.guessData);
        const guess: CEEGuess = {
          id,
          playerId,
          playerName: originalString(raw.playerName) || originalString(history.username),
          character: {
            id: character.id,
            name: character.name,
            nameCn: character.nameCn,
            imageUrl: character.imageUrl,
          },
          correct: raw.isCorrect === true,
          partial: raw.isPartialCorrect === true,
          syncRound: originalNumber(raw.round, session.syncRound),
          createdAt: previous.get(id)?.createdAt || this.now(),
          feedback: buildCEEFeedback(character, session.answer!, session.settings),
        };
        const key = session.roundKey;
        if (!this.isCurrentRound(session, key)) return guess;
        void Promise.all([
          this.roundData(session).supplement(character),
          this.supplementAnswer(session),
        ])
          .then(([supplemented, answer]) => {
            if (!this.isCurrentRound(session, key) || !session.guesses.includes(guess)) return;
            const feedback = buildCEEFeedback(supplemented, answer, session.settings);
            guess.feedback = {
              ...guess.feedback,
              extraTags: feedback.extraTags,
              sharedAppearances: feedback.sharedAppearances,
            };
            this.publish(session);
          })
          .catch(() => {
            if (this.isCurrentRound(session, key))
              this.options.logger?.warn("原版猜测附加标签读取失败", { roomId: session.roomId });
          });
        return guess;
      });
    });
  }
}
