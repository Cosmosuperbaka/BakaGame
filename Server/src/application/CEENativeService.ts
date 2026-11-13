import type { GameRecorder } from "../domain/GameRecord";
import type { TestRoomPolicy } from "../domain/TestRooms";
import type { EventLogger } from "../infrastructure/EventLogger";
import type { SnapshottedRoom } from "../shared/RoomSnapshot";
import type { ConnectionRecord } from "../shared/Index";
import type { CEERoom } from "../domain/CEEModel";
import { tickCEERound } from "../domain/CEERound";
import type { CEEDataProvider } from "../infrastructure/CEEData";
import { CEEImageHints } from "../infrastructure/CEEImageHints";
import type { CEEAntiCheatReviewQueue, CEESearchProvenance } from "./CEEAntiCheatSignals";
import {
  createCEENativeCommands,
  type CEENativeDispatcher,
  type CEENativeMessage,
} from "./CEENativeCommands";
import type { CEENativeContext } from "./CEENativeRoundActions";
import { dispatchCommand } from "./room/CommandTable";
import { CEERooms } from "./CEERooms";
import type { TimerSeam } from "./room/RoomTimers";

/** 每间房唯一的定时器名：到最近一个截止时刻时推进回合并重发快照。 */
const ROOM_DEADLINE_TIMER = "deadline";

export class CEENativeService {
  readonly state: CEERooms;
  private readonly now: () => number;
  private readonly dispatcher: CEENativeDispatcher;
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
    this.now = options.now ?? Date.now;
    this.state = new CEERooms(
      this.now,
      options.isRoomIdReserved,
      options.gameRecorder,
      options.reviewQueue,
      { testRooms: options.testRooms, logger: options.eventLogger, setTimer: options.setTimer }
    );
    const ctx: CEENativeContext = {
      state: this.state,
      data: options.data,
      imageHints: options.imageHints ?? new CEEImageHints(),
      now: this.now,
      random: options.random ?? Math.random,
      // 检索台账由入口层持有（原版房与增强房共用一条命令入口），这里只读。
      provenance: options.provenance,
      inFlight: new Set<string>(),
      schedule: (room) => this.schedule(room),
      rescheduleAll: () => this.rescheduleAll(),
    };
    this.dispatcher = {
      table: createCEENativeCommands(this.state.testRooms),
      deps: ctx,
      resolveSeat: (target, command) => this.resolveSeat(target, command),
      isRoomRegistered: (room) => this.state.rooms.get(room.id) === room,
      isSeated: (room, seat) => room.players.get(seat.id) === seat,
      hostIdOf: (room) => room.hostPlayerId,
      phaseOf: (room) => room.phase,
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
    // 命令是否进了房间要到身份确认之后才知道：确认失败的请求不发布、不重排，
    // 确认之后无论成功、被守卫拒绝还是处理中抛错，都要发布并重排定时器。
    let seated: CEERoom | undefined;
    const dispatcher: CEENativeDispatcher = {
      ...this.dispatcher,
      resolveSeat: (target, command) => {
        const resolved = this.resolveSeat(target, command);
        seated = resolved.room;
        return resolved;
      },
    };
    try {
      return (await dispatchCommand(dispatcher, connection, message)) ?? {};
    } finally {
      if (seated) {
        this.state.publishRoom(seated);
        this.schedule(seated);
      }
    }
  }
  /** 凭会话令牌确认身份；到点的回合在命令生效前先推进，让守卫看到的是最新状态。 */
  private resolveSeat(connection: ConnectionRecord, message: CEENativeMessage) {
    const { room, player } = this.state.authenticate(
      connection,
      message.sessionToken,
      message.roomId
    );
    tickCEERound(room, this.now());
    return { room, seat: player };
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
