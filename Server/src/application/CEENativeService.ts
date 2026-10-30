import type { GameRecorder } from "../domain/GameRecord";
import type { SnapshottedRoom } from "../shared/RoomSnapshot";
import type { CEEClientMessage, CEEGuess, ConnectionRecord } from "../shared/Index";
import { AppError } from "../domain/Errors";
import type { CEEPlayerRecord, CEERoom } from "../domain/CEEModel";
import { ceeUnitId } from "../domain/CEEModel";
import {
  applyCEEGuess,
  beginCEERound,
  ceeParticipants,
  requireCEEAction,
  surrenderCEE,
  tickCEERound,
} from "../domain/CEERound";
import { validateCEESettings } from "../domain/CEERules";
import type { CEEDataProvider } from "../infrastructure/CEEData";
import { CEEImageHints } from "../infrastructure/CEEImageHints";
import type { CEEAntiCheatReviewQueue, CEESearchProvenance } from "./CEEAntiCheatSignals";
import { ceeClientTypeOf } from "./CEEAntiCheatSignals";
import { CEERooms } from "./CEERooms";
import { ceePrivateState } from "./CEEViews";

export class CEENativeService {
  readonly state: CEERooms;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly data: CEEDataProvider;
  private readonly imageHints: CEEImageHints;
  /** 检索台账由入口层持有（原版房与增强房共用一条命令入口），这里只读。 */
  private readonly provenance?: CEESearchProvenance;
  private readonly inFlight = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(options: {
    data: CEEDataProvider;
    now?: () => number;
    random?: () => number;
    imageHints?: CEEImageHints;
    isRoomIdReserved?: (roomId: string) => boolean;
    gameRecorder?: GameRecorder;
    reviewQueue?: CEEAntiCheatReviewQueue;
    provenance?: CEESearchProvenance;
  }) {
    this.data = options.data;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.imageHints = options.imageHints ?? new CEEImageHints();
    this.provenance = options.provenance;
    this.state = new CEERooms(
      this.now,
      options.isRoomIdReserved,
      options.gameRecorder,
      options.reviewQueue
    );
  }
  registerConnection(connection: ConnectionRecord) {
    this.state.registerConnection(connection);
  }
  unregisterConnection(connectionId: string) {
    this.state.unregisterConnection(connectionId);
    this.rescheduleAll();
  }
  getHealthSnapshot() {
    return this.state.getHealthSnapshot();
  }
  listRooms() {
    return this.state.listRooms();
  }
  adminListRooms() {
    return this.state.adminListRooms();
  }
  adminCloseRoom(roomId: string) {
    this.state.adminCloseRoom(roomId);
    this.rescheduleAll();
  }
  adminKickPlayer(roomId: string, playerId: string) {
    this.state.adminKickPlayer(roomId, playerId);
    const room = this.state.rooms.get(roomId);
    if (room) this.schedule(room);
    else this.rescheduleAll();
  }
  notifyShutdown() {
    this.state.notifyShutdown();
  }
  /** 快照直接委托给房间集合：本地 CEE 房间的状态全在 CEERooms 里。 */
  exportSnapshots(): SnapshottedRoom[] {
    return this.state.exportSnapshots();
  }
  restoreSnapshots(rooms: readonly SnapshottedRoom[], savedAt: number): number {
    return this.state.restoreSnapshots(rooms, savedAt);
  }
  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  runHousekeeping() {
    for (const room of this.state.rooms.values()) {
      if (tickCEERound(room, this.now())) this.state.publishRoom(room);
    }
    this.state.housekeeping();
    this.rescheduleAll();
  }
  async execute(connectionId: string, message: CEEClientMessage): Promise<unknown> {
    const connection = this.state.connections.getConnection(connectionId);
    this.state.assertMcpManualControl(connection, message.type);
    if (message.type === "mcp.focus")
      return this.state.publishAgentFocus(connection, message.payload);
    if (message.type === "mcp.claim" || message.type === "mcp.release") {
      return this.state.handleMcpCommand(connection, message);
    }
    switch (message.type) {
      case "cee.room.create":
        return this.state.createRoom(connection, message.payload);
      case "cee.room.join":
        return this.state.joinRoom(connection, message.roomId, message.payload);
      case "cee.room.reconnect": {
        const result = this.state.reconnectRoom(connection, message.payload);
        this.rescheduleAll();
        return result;
      }
      case "cee.lobby.subscribeRooms":
        connection.lobbySubscribed = true;
        return { rooms: this.listRooms() };
    }
    const { room, player } = this.state.authenticate(
      connection,
      message.sessionToken,
      message.roomId
    );
    tickCEERound(room, this.now());
    try {
      switch (message.type) {
        case "cee.room.leave":
          this.state.leaveRoom(connection, room, player);
          break;
        case "cee.room.requestSync":
          connection.resetStateSync?.();
          break;
        case "cee.room.settings": {
          this.state.requireHost(room, player);
          this.state.requireWaiting(room);
          validateCEESettings(message.payload.settings);
          // 反作弊那一位由建房决定，`applySettings` 会把它换回房里的现值：中途改不了。
          this.state.applySettings(room, message.payload.settings);
          break;
        }
        case "cee.room.update":
          await this.state.updateSettings(room, player, message.payload);
          break;
        // 房主没有准备态：开局权在房主手里，准备与否对他没有意义，界面也不显示准备按钮。
        case "cee.player.ready":
          this.state.requireWaiting(room);
          if (player.id !== room.hostPlayerId) player.ready = message.payload.ready;
          break;
        case "cee.player.team":
          this.state.requireWaiting(room);
          player.team = message.payload.team;
          break;
        case "cee.player.spectate": {
          this.state.requireWaiting(room);
          const pending = this.state.requestSpectate(room, player, message.payload.spectator);
          return { pending, membership: player.membership };
        }
        case "cee.player.approveSpectate":
          this.state.approveSpectate(
            room,
            player,
            message.payload.playerId,
            message.payload.approved
          );
          return { pending: false, membership: player.membership };
        case "cee.room.kick":
          this.state.kick(room, player, message.payload.playerId);
          break;
        case "cee.room.transferHost":
          this.state.transferHost(room, player, message.payload.playerId);
          break;
        case "cee.chat.send":
          this.state.sendChat(room, player, message.payload.text);
          break;
        case "cee.character.search":
          return { results: await this.data.searchCharacters(message.payload.keyword) };
        case "cee.subject.search":
          this.requireSubjectSearch(room, player);
          return { results: await this.data.searchSubjects(message.payload.keyword) };
        case "cee.subject.characters":
          this.requireSubjectSearch(room, player);
          return { results: await this.data.getSubjectCharacters(message.payload.subjectId) };
        case "cee.subject.lookup":
          return { results: await this.data.getSubjects(message.payload.subjectIds) };
        case "cee.directory.import":
          this.state.requireHost(room, player);
          this.state.requireWaiting(room);
          return this.data.importDirectory(message.payload.indexId);
        // 列表是方形缩略图，尺寸缺省即方格图；大图用途走服务端内部调用，不带这条命令。
        case "cee.character.image":
          return {
            imageUrl: await this.data.resolveCharacterImage(
              message.payload.characterId,
              message.payload.size ?? "grid"
            ),
          };
        case "cee.subject.image":
          return { imageUrl: await this.data.resolveSubjectImage(message.payload.subjectId) };
        case "cee.game.start":
          await this.start(room, player);
          break;
        case "cee.game.chooseSetter":
          this.chooseSetter(room, player, message.payload.playerId);
          break;
        case "cee.game.setAnswer":
          await this.setAnswer(room, player, message.payload.characterId, message.payload.hints);
          break;
        case "cee.game.cancel":
          this.cancelPreparation(room, player);
          break;
        case "cee.game.guess":
          await this.guess(connection, room, player, message.payload.characterId);
          break;
        case "cee.game.surrender":
          surrenderCEE(room, player, this.now());
          break;
        case "cee.game.next":
          this.state.requireHost(room, player);
          if (room.phase !== "settled") throw new AppError("INVALID_PHASE", "请等待本局结束");
          this.state.resetWaiting(room);
          break;
        case "cee.game.imageHint":
          return this.imageHint(room, player);
        default: {
          // 编译期穷尽：新增 CEE 命令却没接到这里时类型检查不过，而不是全套测试照绿、运行时静默回 {}。
          const unhandled: never = message;
          throw new AppError(
            "UNKNOWN_MESSAGE_TYPE",
            `未处理的指令：${(unhandled as { type: string }).type}`
          );
        }
      }
      return {};
    } finally {
      this.state.publishRoom(room);
      this.schedule(room);
    }
  }
  /** 关闭作品搜索的那一局里，正在猜题的玩家不能靠搜索绕过题目线索。 */
  private requireSubjectSearch(room: CEERoom, player: CEEPlayerRecord): void {
    if (room.phase === "guessing" && !room.settings.subjectSearch && player.status === "playing")
      throw new AppError("SUBJECT_SEARCH_DISABLED", "本局关闭了作品搜索");
  }
  private chooseSetter(room: CEERoom, player: CEEPlayerRecord, playerId: string): void {
    this.state.requireHost(room, player);
    if (room.phase !== "choosingSetter")
      throw new AppError("INVALID_PHASE", "请先开始游戏再指定出题人");
    const setter = this.state.member(room, playerId);
    if (!setter.online) throw new AppError("PLAYER_OFFLINE", "出题人已离线");
    if (!ceeParticipants(room, setter.id).length)
      throw new AppError("NO_PARTICIPANTS", "出题人及其队友不能参与猜测，请保留其他猜题者");
    room.setterPlayerId = setter.id;
    room.phase = "answering";
    room.preparationId = crypto.randomUUID();
    room.phaseDeadlineAt = this.now() + 120000;
  }
  private cancelPreparation(room: CEERoom, player: CEEPlayerRecord): void {
    this.state.requireHost(room, player);
    // 选出题人阶段还没开局，退回等待只换阶段，大家的准备状态原样保留。
    if (room.phase === "choosingSetter") {
      room.phase = "waiting";
      return;
    }
    if (room.phase !== "answering" && room.phase !== "preparing")
      throw new AppError("INVALID_PHASE", "当前没有等待中的出题任务");
    this.state.resetWaiting(room);
  }
  /** 开始游戏：随机出题直接抽题开局；手动出题进入选出题人阶段，由房主在那里指定出题人。 */
  private async start(room: CEERoom, player: CEEPlayerRecord): Promise<void> {
    this.state.requireHost(room, player);
    if (room.phase !== "waiting" && room.phase !== "settled")
      throw new AppError("INVALID_PHASE", "当前阶段无法开始游戏");
    if (!ceePrivateState(room, player).canStart)
      throw new AppError("PLAYERS_NOT_READY", "至少两名玩家在线，且其他参与者准备后才能开始");
    validateCEESettings(room.settings);
    room.round = null;
    room.summary = null;
    room.setterPlayerId = null;
    if (room.settings.answerMode === "manual") {
      room.phase = "choosingSetter";
      return;
    }
    room.phase = "preparing";
    room.phaseDeadlineAt = this.now() + 30000;
    const preparationId = crypto.randomUUID();
    room.preparationId = preparationId;
    this.state.publishRoom(room);
    this.schedule(room);
    try {
      const answer = await this.data.chooseRandomCharacter(room.settings, this.random);
      if (
        this.state.rooms.get(room.id) !== room ||
        room.phase !== "preparing" ||
        room.preparationId !== preparationId ||
        this.now() >= room.phaseDeadlineAt!
      )
        throw new AppError("ROUND_CANCELLED", "本次出题已经取消");
      beginCEERound(room, answer, null, this.now(), this.random);
    } catch (error) {
      if (room.phase === "preparing" && room.preparationId === preparationId)
        this.state.resetWaiting(room);
      this.state.publishRoom(room);
      this.schedule(room);
      throw error;
    }
  }
  private async setAnswer(
    room: CEERoom,
    player: CEEPlayerRecord,
    id: number,
    hints: string[]
  ): Promise<void> {
    if (room.phase !== "answering" || room.setterPlayerId !== player.id)
      throw new AppError("NOT_SETTER", "仅当前出题人可以提交答案");
    const key = `answer:${room.id}`;
    if (this.inFlight.has(key)) throw new AppError("ACTION_PENDING", "答案正在提交");
    this.inFlight.add(key);
    const preparationId = room.preparationId;
    try {
      const answer = await this.data.getCharacter(id, room.settings);
      if (
        this.state.rooms.get(room.id) !== room ||
        room.phase !== "answering" ||
        room.setterPlayerId !== player.id ||
        room.preparationId !== preparationId ||
        this.now() >= room.phaseDeadlineAt! ||
        !player.online
      )
        throw new AppError("ROUND_CANCELLED", "本次出题已经取消");
      beginCEERound(room, answer, hints, this.now(), this.random);
    } finally {
      this.inFlight.delete(key);
    }
  }
  private async guess(
    connection: ConnectionRecord,
    room: CEERoom,
    player: CEEPlayerRecord,
    id: number
  ): Promise<void> {
    const { round, unit } = requireCEEAction(room, player);
    const syncRound = round.syncRound;
    const attempts = unit.attempts;
    const key = `guess:${room.id}:${ceeUnitId(player)}`;
    if (this.inFlight.has(key)) throw new AppError("ACTION_PENDING", "队伍猜测正在提交");
    this.inFlight.add(key);
    try {
      const loaded = round.characters.get(id) ?? (await this.data.getCharacter(id, round.settings));
      if (this.state.rooms.get(room.id) !== room || room.round !== round)
        throw new AppError("ROUND_CANCELLED", "本局已经结束");
      // 查询期间时钟仍继续运行；到期先执行扣次，再重新校验行动资格。
      tickCEERound(room, this.now());
      requireCEEAction(room, player);
      if (round.syncRound !== syncRound || unit.attempts !== attempts)
        throw new AppError("ROUND_CANCELLED", "本次行动已超时，请重新猜测");
      const character = round.characters.get(id) ?? structuredClone(loaded);
      const guess = applyCEEGuess(room, player, character, this.now());
      round.characters.set(id, character);
      this.noteGuessSignal(connection, room, guess, unit.attempts, id);
    } finally {
      this.inFlight.delete(key);
    }
  }
  /**
   * 登记本条猜测的服务端可观测切片：谁在猜、第几次、从哪个平台、猜之前有没有检索过。
   * 检索台账按连接记，同一玩家换连接后旧台账不跟着走——那是「同一个人」的判定，不是本特征要问的。
   */
  private noteGuessSignal(
    connection: ConnectionRecord,
    room: CEERoom,
    guess: CEEGuess,
    attempts: number,
    characterId: number
  ): void {
    if (!this.provenance) return;
    const { at, matched } = this.provenance.match(connection.id, characterId);
    this.state.noteGuessSignal(room.id, {
      guessId: guess.id,
      playerId: guess.playerId,
      attempts,
      clientType: ceeClientTypeOf(connection.clientChannel),
      searchedAt: at,
      searchMatched: matched,
      correct: guess.correct,
      createdAt: guess.createdAt,
    });
  }
  private async imageHint(room: CEERoom, player: CEEPlayerRecord): Promise<{ dataUrl: string }> {
    const state = ceePrivateState(room, player);
    const round = room.round;
    if (!state.imageHintAvailable || !round) throw new AppError("HINT_LOCKED", "图片提示尚未解锁");
    const url = await this.data.resolveCharacterImage(round.answer.id);
    if (!url) throw new AppError("IMAGE_UNAVAILABLE", "该角色暂时没有图片");
    const dataUrl = await this.imageHints.render(url, state.imageHintLevel);
    if (room.round !== round || !ceePrivateState(room, player).imageHintAvailable)
      throw new AppError("HINT_LOCKED", "图片提示已失效");
    return { dataUrl };
  }
  private rescheduleAll() {
    for (const [id, timer] of this.timers)
      if (!this.state.rooms.has(id)) {
        clearTimeout(timer);
        this.timers.delete(id);
      }
    for (const room of this.state.rooms.values()) this.schedule(room);
  }
  private schedule(room: CEERoom): void {
    const current = this.timers.get(room.id);
    if (current) clearTimeout(current);
    this.timers.delete(room.id);
    if (!this.state.rooms.has(room.id)) return;
    const times = [
      room.phaseDeadlineAt,
      ...[...(room.round?.units.values() ?? [])].map((unit) => unit.deadlineAt),
    ].filter((value): value is number => value !== null);
    if (!times.length) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(room.id);
        if (!this.state.rooms.has(room.id)) return;
        if (room.phaseDeadlineAt !== null && this.now() >= room.phaseDeadlineAt)
          this.state.resetWaiting(room);
        tickCEERound(room, this.now());
        this.state.publishRoom(room);
        this.schedule(room);
      },
      Math.max(1, Math.min(...times) - this.now())
    );
    timer.unref();
    this.timers.set(room.id, timer);
  }
}
