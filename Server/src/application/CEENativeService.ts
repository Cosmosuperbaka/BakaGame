import type { GameRecorder } from "../domain/GameRecord";
import type { TestRoomPolicy } from "../domain/TestRooms";
import type { EventLogger } from "../infrastructure/EventLogger";
import type { SnapshottedRoom } from "../shared/RoomSnapshot";
import type { CEERoomClientMessage, ConnectionRecord } from "../shared/Index";
import { AppError } from "../domain/Errors";
import type { CEEPlayerRecord, CEERoom } from "../domain/CEEModel";
import { surrenderCEE, tickCEERound } from "../domain/CEERound";
import { validateCEESettings } from "../domain/CEERules";
import type { CEEDataProvider } from "../infrastructure/CEEData";
import { CEEImageHints } from "../infrastructure/CEEImageHints";
import type { CEEAntiCheatReviewQueue, CEESearchProvenance } from "./CEEAntiCheatSignals";
import {
  cancelCEEPreparation,
  chooseCEESetter,
  requestCEEImageHint,
  startCEEGame,
  submitCEEAnswer,
  submitCEEGuess,
  type CEENativeContext,
} from "./CEENativeRoundActions";
import { runCEEDataCommand } from "./CEEDataCommands";
import { CEERooms } from "./CEERooms";
import type { TimerSeam } from "./room/RoomTimers";

/** 每间房唯一的定时器名：到最近一个截止时刻时推进回合并重发快照。 */
const ROOM_DEADLINE_TIMER = "deadline";

/** 增强房处理的命令：大厅订阅由统一入口 `CEEService` 先行处理，不会下沉到这里。 */
export type CEENativeMessage = Exclude<CEERoomClientMessage, { type: "cee.lobby.subscribeRooms" }>;

export class CEENativeService {
  readonly state: CEERooms;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly data: CEEDataProvider;
  private readonly imageHints: CEEImageHints;
  /** 检索台账由入口层持有（原版房与增强房共用一条命令入口），这里只读。 */
  private readonly provenance?: CEESearchProvenance;
  private readonly ctx: CEENativeContext;
  constructor(options: {
    data: CEEDataProvider;
    now?: () => number;
    random?: () => number;
    imageHints?: CEEImageHints;
    isRoomIdReserved?: (roomId: string) => boolean;
    gameRecorder?: GameRecorder;
    reviewQueue?: CEEAntiCheatReviewQueue;
    provenance?: CEESearchProvenance;
    testRooms?: TestRoomPolicy;
    eventLogger?: EventLogger;
    /** 定时器接缝：测试注入，用来数残留定时器或手动触发到点回调。 */
    setTimer?: TimerSeam;
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
      options.reviewQueue,
      { testRooms: options.testRooms, logger: options.eventLogger, setTimer: options.setTimer }
    );
    this.ctx = {
      state: this.state,
      data: this.data,
      imageHints: this.imageHints,
      now: this.now,
      random: this.random,
      provenance: this.provenance,
      inFlight: new Set<string>(),
      schedule: (room) => this.schedule(room),
    };
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
    this.state.timers.clearAll();
  }
  runHousekeeping() {
    this.state.housekeeping();
    this.rescheduleAll();
  }
  async execute(connectionId: string, message: CEENativeMessage): Promise<unknown> {
    const connection = this.state.connections.getConnection(connectionId);
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
          return runCEEDataCommand(this.data, message.type, message.payload);
        case "cee.subject.search":
          this.requireSubjectSearch(room, player);
          return runCEEDataCommand(this.data, message.type, message.payload);
        case "cee.subject.characters":
          this.requireSubjectSearch(room, player);
          return runCEEDataCommand(this.data, message.type, message.payload);
        case "cee.subject.lookup":
          return runCEEDataCommand(this.data, message.type, message.payload);
        case "cee.directory.import":
          this.state.requireHost(room, player);
          this.state.requireWaiting(room);
          return runCEEDataCommand(this.data, message.type, message.payload);
        case "cee.character.image":
          return runCEEDataCommand(this.data, message.type, message.payload);
        case "cee.subject.image":
          return runCEEDataCommand(this.data, message.type, message.payload);
        case "cee.game.start":
          await startCEEGame(this.ctx, room, player);
          break;
        case "cee.game.chooseSetter":
          chooseCEESetter(this.ctx, room, player, message.payload.playerId);
          break;
        case "cee.game.setAnswer":
          await submitCEEAnswer(
            this.ctx,
            room,
            player,
            message.payload.characterId,
            message.payload.hints
          );
          break;
        case "cee.game.cancel":
          cancelCEEPreparation(this.ctx, room, player);
          break;
        case "cee.game.guess":
          await submitCEEGuess(this.ctx, connection, room, player, message.payload.characterId);
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
          return requestCEEImageHint(this.ctx, room, player);
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
  /** 关房已由房间集合清掉本房的定时器，这里只给仍在的房间重挂。 */
  private rescheduleAll() {
    for (const room of this.state.rooms.values()) this.schedule(room);
  }
  /** 每房只留一个「最近截止」定时器：每次命令、巡检与到点回调之后重算。 */
  private schedule(room: CEERoom): void {
    const { timers } = this.state;
    if (!this.state.rooms.has(room.id)) {
      timers.clear(room.id);
      return;
    }
    const times = [
      room.phaseDeadlineAt,
      ...[...(room.round?.units.values() ?? [])].map((unit) => unit.deadlineAt),
    ].filter((value): value is number => value !== null);
    if (!times.length) {
      timers.clear(room.id, ROOM_DEADLINE_TIMER);
      return;
    }
    timers.arm(room.id, ROOM_DEADLINE_TIMER, Math.max(1, Math.min(...times) - this.now()), () => {
      if (!this.state.rooms.has(room.id)) return;
      if (room.phaseDeadlineAt !== null && this.now() >= room.phaseDeadlineAt)
        this.state.resetWaiting(room);
      tickCEERound(room, this.now());
      this.state.publishRoom(room);
      this.schedule(room);
    });
  }
}
