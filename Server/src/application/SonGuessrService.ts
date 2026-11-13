import {
  computeSongAnswererFactors,
  computeSongDifficulty,
  computeSongSubmitterScore,
} from "../domain/SongRules";
import { createManualLyricClip, createSongLyricClip } from "./songuessr/LyricClip";
import { songTitleNames } from "./songuessr/LyricTitleGuard";
import { isAudioTicketMatch } from "./songuessr/AudioTicket";
import { publicAnime, publicSong } from "./songuessr/RoomViews";
import { resolveAnimeSong, resolveSpecifiedAnimeSong } from "./songuessr/AnimeResolution";
import {
  clearMusicSession,
  hasEnabledPoolAccount,
  loadSongWithSources,
  musicPool,
  primaryPoolEntry,
  refreshMusicSessionAccount,
  refreshRoundAudio,
  scheduleMusicSessionRefresh,
  wakeMusicPoolWaiters,
  withSongAccount,
} from "./songuessr/MusicAccounts";
import {
  normalizeAnimeAutoFilters,
  normalizeAutoFilters,
  startAutomaticRound,
} from "./songuessr/AutomaticRounds";
import { NOOP_GAME_RECORDER, type GameRecorder } from "../domain/GameRecord";
import {
  BOT_NAME_SUFFIXES,
  ROOM_EXPIRING_WARNING_MS,
  TEST_BOT_BATCH_LIMIT,
  TEST_MODE_MAX_PLAYERS,
} from "../config/Constants";
import { tabSeatId } from "./TabSeat";
import { ADMIN_CLOSE_REASON, AdminRoomView } from "../domain/AdminRoom";
import type { GameService } from "./GameService";
import { AppError } from "../domain/Errors";
import { assertTextAllowed } from "../infrastructure/SensitiveText";
import { ensureRoomId, normalizeName, normalizeWord } from "../domain/Rules";
import {
  SERVER_SHUTDOWN_MESSAGE,
  SONGUESSR_MAX_TEAM,
  SonGuessrClientMessage,
  SonGuessrRoomSummary,
  SonGuessrRoundSummary,
  SonGuessrScoreBreakdown,
  SongClipPreview,
  SongClipRange,
  SongDetails,
  SongGuessAttempt,
  SongGuessFeedback,
  type BangumiSubjectDetails,
  type ConnectionRecord,
  type SonGuessrRoundMark,
} from "../shared/Index";
import { type SnapshottedRoom } from "../shared/RoomSnapshot";
import { describeError } from "../infrastructure/EventLogger";
import { SONG_ROOM_SHAPE } from "./songuessr/RoomShape";
import type { SonGuessrServiceOptions } from "./songuessr/Options";
import {
  createSonGuessrContext,
  publishPrivateState,
  publishRoomCalibration,
  type SonGuessrContext,
} from "./songuessr/Context";
import {
  buildPrivateState,
  buildRoomSnapshot,
  buildScores,
  listRoomSummaries,
} from "./songuessr/RoomViews";
import {
  type SongCommandAt,
  isRoomStarting,
  activePlayers,
  appendSystemMessage,
  canTestSubmitterGuess,
  getRoom,
  isTestRoom,
  requireRoomPlayer,
} from "./songuessr/RoomAccess";
import {
  clearRoundMarks,
  ensureRoundPlayerState,
  submitterCandidates,
} from "./songuessr/RoundParticipants";
import { installRound } from "./songuessr/RoundInstall";
import { createSonGuessrCommands, type SonGuessrDispatcher } from "./songuessr/Commands";
import { dispatchCommand } from "./room/CommandTable";
import { requireMusicQuota } from "./songuessr/MusicCommands";
import { broadcastRoomEvent } from "./songuessr/Chat";
import { exportSnapshots, restoreSnapshots } from "./songuessr/SnapshotCodec";

import { reassignHost, resolveHostGrace, transferHost } from "./room/HostPolicy";
import { adminRoomView, countOnline, requireAdminRoom } from "./room/RoomSummaries";
import { RoomIdReservations } from "./room/RoomIdReservations";
import { RoomPasswordGate } from "./room/RoomPasswordGate";
import {
  expiredOfflineSeats,
  forEachRoomIsolated,
  isIdleWarningDue,
  judgeReclaim,
  markIdleWarningSent,
} from "./room/RoomJanitor";
import {
  assertAgentAdmission,
  assertSeatResumable,
  assertTabAgentsAllowed,
  bindSeat,
  dissolveRoom,
  findSeat,
  markSeatOffline,
  roomsOfTab,
  type SeatBindingContext,
  type TabSeatContext,
} from "./room/SeatBinding";
import { musicIpScope } from "../infrastructure/music/MusicIpScope";
import { createEvent } from "../transport/Packets";
import {
  AUDIO_READY_GRACE_MS,
  DEFAULT_SETTINGS,
  MusicAuthPlatform,
  ROUND_HARD_TIMEOUT_MARGIN_S,
  SUBMIT_SONG_TIMEOUT_MS,
  SonGuessrPlayerRecord,
  SonGuessrRoomRecord,
  SonGuessrRoundPlayerState,
  SonGuessrRoundRecord,
  SongUpdateSettingsPayload,
  clampInt,
  cloneSettings,
  direction,
  musicAuthOperationKey,
  roomRuntime,
} from "./songuessr/Records";
import { normalizeSongText, isSameAnswerSong } from "./songuessr/SongTitleMatching";

/** 口令只去首尾空白；摘要绑定规范化后的值，建房、改设置与入房必须同一口径。 */
const normalizeRoomPassword = (password: string): string => password.trim();

/** 巡检的房间回收结论：`skip` 整间跳过、`grace` 已补校准并跳过、`keep` 继续后续阶段。 */
type RoomReclaim = "skip" | "grace" | "keep";

/** 一轮回合巡检的共享扫描状态：同一时刻与同一硬超时判定贯穿「补就绪」与「判超时」两步。 */
type RoundSweep = {
  room: SonGuessrRoomRecord;
  round: NonNullable<SonGuessrRoomRecord["currentRound"]>;
  currentTime: number;
  /** 硬超时只在巡检开始时判一次：`armRoundDeadlines` 会改写回合时限，事后重算会读到新值。 */
  isRoundHardExpired: boolean;
  units: Set<SonGuessrRoundPlayerState>;
};

export class SonGuessrService implements GameService<SonGuessrClientMessage> {
  readonly ctx: SonGuessrContext;
  private readonly dispatcher: SonGuessrDispatcher;
  /** 建房期间的房号占用：占号与「房间可见」分开，登记进房间表之前没有人看得到半成品房间。 */
  private readonly reservations = new RoomIdReservations();
  private readonly passwordGate: RoomPasswordGate;
  /** 座位绑定、转离线与标签页座位共用的内核上下文。 */
  private readonly roomKernel: SeatBindingContext<SonGuessrRoomRecord, SonGuessrPlayerRecord> &
    TabSeatContext<SonGuessrRoomRecord, SonGuessrPlayerRecord> & { recorder: GameRecorder };

  constructor(readonly options: SonGuessrServiceOptions) {
    this.ctx = createSonGuessrContext(options);
    const { ctx } = this;
    this.roomKernel = {
      shape: SONG_ROOM_SHAPE,
      connections: ctx.connections,
      rooms: ctx.rooms,
      now: () => ctx.now(),
      recorder: options.gameRecorder ?? NOOP_GAME_RECORDER,
    };
    this.passwordGate = new RoomPasswordGate({
      now: () => ctx.now(),
      normalize: normalizeRoomPassword,
      missingOnCreate: { code: "PASSWORD_REQUIRED", message: "私密房间需要密码" },
      missingOnJoin: { code: "PASSWORD_INCORRECT", message: "房间密码错误" },
      hasher: options.passwordHasher,
    });
    this.dispatcher = {
      table: createSonGuessrCommands(ctx),
      deps: { ctx, handlers: this },
      resolveSeat: (connection) => {
        const { room, player } = requireRoomPlayer(ctx, connection);
        return { room, seat: player };
      },
      isRoomRegistered: (room) => ctx.rooms.get(room.id) === room,
      isSeated: (room, seat) => room.players[seat.id] === seat,
      hostIdOf: (room) => room.hostPlayerId,
      phaseOf: (room) => room.phase,
    };
  }

  /** 房间表：测试直接读它，写入只走命令与巡检。 */
  get rooms(): Map<string, SonGuessrRoomRecord> {
    return this.ctx.rooms;
  }

  /**
   * 站内播放地址的跳转目标：按房号与票据取当前回合保存在服务端的上游地址。
   * 房间不在、没有进行中的回合、票据不符都返回 undefined，调用方不得把三者区分开来回给客户端。
   * 目标只来自回合记录，不接受任何请求里的地址。
   */
  resolveAudioRedirect(roomId: string, ticket: string): string | undefined {
    const round = this.ctx.rooms.get(roomId)?.currentRound;
    if (!round || !isAudioTicketMatch(ticket, round.audioTicket)) return undefined;
    return round.song.audioUrl || undefined;
  }

  getRoomSummaries(): SonGuessrRoomSummary[] {
    return listRoomSummaries(this.ctx);
  }

  registerConnection(connection: ConnectionRecord): void {
    this.ctx.connections.registerConnection(connection);
  }

  getHealthSnapshot() {
    return {
      roomCount: this.ctx.rooms.size,
      connectionCount: this.ctx.connections.stats.totalConnections,
      onlinePlayerCount: [...this.ctx.rooms.values()].reduce(
        (sum, room) => sum + countOnline(Object.values(room.players)),
        0
      ),
    };
  }

  notifyShutdown(): void {
    this.ctx.connections.broadcastToAll(
      createEvent("server.shutdown", {
        message: SERVER_SHUTDOWN_MESSAGE,
      })
    );
  }

  /** 导出全部房间以供停机保存；两类字段不落盘的理由见快照编解码模块。 */
  exportSnapshots(): SnapshottedRoom[] {
    return exportSnapshots(this.ctx);
  }

  /** 从快照恢复房间，返回真正恢复的房间数。 */
  restoreSnapshots(rooms: readonly SnapshottedRoom[], savedAt: number): number {
    return restoreSnapshots(this.ctx, rooms, savedAt);
  }

  async unregisterConnection(connectionId: string): Promise<void> {
    const connection = this.ctx.connections.unregisterConnection(connectionId);
    if (!connection?.roomId || !connection.playerId) return;
    const room = this.ctx.rooms.get(connection.roomId);
    const player = room?.players[connection.playerId];
    if (!room || !player) return;

    this.ctx.connections.detach(connection);
    if (player.connectionId !== connection.id) return;

    // 断线不是显式离开：保留房主身份和房间音乐会话，给移动端后台重连留出时间。
    markSeatOffline(this.roomKernel, room, player, { emptyRoomExempt: isTestRoom(this.ctx, room) });
    this.releasePendingSubmitter(
      room,
      player.id,
      `${player.name} 断线，出题已中止，请重新指定出题人`
    );
    // 普通断线可能只是刷新或切到后台，不能因此把仍在进行的回合提前结算。
    // 显式离开和踢出会移除正式席位，并在各自路径重新检查回合完成状态。
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
    this.ctx.log("song.player.disconnected", room.id, player.id);
  }

  async execute(connectionId: string, message: SonGuessrClientMessage): Promise<unknown> {
    const connection = this.ctx.connections.getConnection(connectionId);
    // 玩家级伪装 IP 归属：同一连接的匿名请求复用同一个 CN IP，不同玩家各持一个，
    // 避免全服匿名请求共享同一份网易云限流配额（见 NeteaseMusicProvider 的 musicIpScope）。
    // 作用域只能在最外层建立，下游 provider 才可能在任意调用深度读到玩家身份。
    return musicIpScope.run(`player:${connectionId}`, async () =>
      dispatchCommand(this.dispatcher, connection, message)
    );
  }

  async runHousekeeping(): Promise<void> {
    const currentTime = this.ctx.now();
    await forEachRoomIsolated(
      this.ctx.rooms,
      (room) => this.sweepRoom(room, currentTime),
      (room, error) =>
        this.options.eventLogger?.warn("猜歌房间巡检失败，已跳过该房间", {
          roomId: room.id,
          ...describeError(error),
        })
    );
    scheduleMusicSessionRefresh(this.ctx, currentTime);
  }

  /** 单间房的巡检：回收判定之后才做离线清理、房主改选与回合推进。 */
  private sweepRoom(room: SonGuessrRoomRecord, currentTime: number): void {
    if (this.reclaimIdleRoom(room, currentTime) !== "keep") return;
    this.cleanupOfflinePlayers(room, currentTime);
    this.resolveHost(room, currentTime);
    this.expirePendingSubmitter(room, currentTime);
    this.settlePlayingRound(room, currentTime);
    publishRoomCalibration(this.ctx, room);
  }

  /**
   * 无人房间与空闲房间的回收：测试房间只豁免「无人立即回收」，仍受空闲超时约束，
   * 无人房间先给一段宽限期，宽限期内只补一次校准便跳过其余巡检阶段。
   * 闲置关房前提前一段时间预警：每一段闲置只预警一次，有新活动后重新计。
   */
  private reclaimIdleRoom(room: SonGuessrRoomRecord, currentTime: number): RoomReclaim {
    const onlineCount = countOnline(Object.values(room.players));
    const emptyRoomExempt = isTestRoom(this.ctx, room);
    if (isIdleWarningDue(room, onlineCount, currentTime, ROOM_EXPIRING_WARNING_MS)) {
      markIdleWarningSent(room);
      broadcastRoomEvent(this.ctx, room, "song.room.expiring", { roomId: room.id, idle: true });
    }
    const verdict = judgeReclaim(room, onlineCount, currentTime, { emptyRoomExempt });
    switch (verdict) {
      case "grace":
        publishRoomCalibration(this.ctx, room);
        return "grace";
      case "close-empty":
      case "close-idle":
        this.closeRoom(room, onlineCount === 0 ? "empty" : "idle_timeout");
        return "skip";
      case "keep":
        // 测试房常态就是一间等人加入的空房：没人时不推进任何巡检阶段。
        return emptyRoomExempt && onlineCount === 0 ? "skip" : "keep";
    }
  }

  /** 清理离线超过保留时长的真人玩家；被清掉的是房主时先移交，房间空了立即回收。 */
  private cleanupOfflinePlayers(room: SonGuessrRoomRecord, currentTime: number): void {
    for (const player of expiredOfflineSeats(room, Object.values(room.players), currentTime)) {
      delete room.players[player.id];
      // 掉线超过宽限：人和他贡献的号一起清出房间（宽限内号仍在，房主面板也能看到）。
      clearMusicSession(this.ctx, room, player.id);
      if (room.hostPlayerId === player.id) this.reassignRemovedHost(room);
      this.ctx.touch(room);
      if (countOnline(Object.values(room.players)) === 0 && !isTestRoom(this.ctx, room)) {
        this.closeRoom(room, "empty");
      } else {
        this.ctx.publishRoom(room);
        this.ctx.publishLobby();
      }
    }
  }

  /** 出题时限到点：退回选出题人阶段并在房间公告里说明，免得全房以为页面自己跳回去了。 */
  private expirePendingSubmitter(room: SonGuessrRoomRecord, currentTime: number): void {
    const playerId = room.pendingSubmitterPlayerId;
    if (room.phase !== "submittingSong" || !playerId) return;
    const deadlineAt = room.pendingSubmitterDeadlineAt;
    if (deadlineAt === undefined || currentTime < deadlineAt) return;
    const submitter = room.players[playerId];
    const target = room.settings.questionType === "anime" ? "番剧" : "歌曲";
    this.releasePendingSubmitter(
      room,
      playerId,
      `${submitter ? `出题人 ${submitter.name}` : "出题人"} 没有在时限内选好${target}，请重新指定出题人`
    );
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
  }

  /** 进行中的回合：先按人补音频就绪，再按作答单元判超时，最后按变化结算与广播。 */
  private settlePlayingRound(room: SonGuessrRoomRecord, currentTime: number): void {
    const round = room.currentRound;
    if (room.phase !== "playing" || !round) return;
    const sweep: RoundSweep = {
      room,
      round,
      currentTime,
      isRoundHardExpired: round.hardDeadlineAt !== undefined && currentTime >= round.hardDeadlineAt,
      units: new Set<SonGuessrRoundPlayerState>(),
    };
    // 两步都必须跑完：`||` 的短路会让补就绪改动过的回合漏判超时。
    const armed = this.armExpiredAudioUnits(sweep);
    const timedOut = this.recordExpiredGuesses(sweep);
    const changed = armed || timedOut;

    if (changed || sweep.isRoundHardExpired) {
      if (this.isRoundComplete(room) || sweep.isRoundHardExpired) this.finishRound(room);
      this.ctx.publishRoom(room);
    }
  }

  /**
   * 音频就绪宽限期结束的补偿：仅强制置为就绪并启动答题计时，绝不能当作「答题超时」扣除猜测配额。
   * 收下的作答单元交给 `recordExpiredGuesses` 判超时 —— 同队共用一份限时，逐人判会让一次超时扣好几遍。
   */
  private armExpiredAudioUnits(sweep: RoundSweep): boolean {
    const { room, round, currentTime } = sweep;
    const audioReadyDeadlineAt = round.audioReadyDeadlineAt ?? round.audioPreparationDeadlineAt;
    let changed = false;
    for (const [playerId, state] of Object.entries(round.players)) {
      if (
        playerId === round.submitterPlayerId &&
        !canTestSubmitterGuess(this.ctx, room, playerId)
      ) {
        continue;
      }
      if (this.isUnitFinished(round, state)) continue;

      if (!round.audioReady[playerId] && currentTime >= audioReadyDeadlineAt) {
        this.armRoundDeadlines(room);
        round.audioReady[playerId] = true;
        // 宽限期本身就晚于锚点 15 秒，这里的倒计时必须重新起算，
        // 不能再用 audioReadyDeadlineAt —— 那样会立刻得到一个已过期的截止时刻，
        // 下一轮巡检就把补偿出来的答题时间又当成超时收走。队友先就绪时全队计时已在走，不重开。
        if (state.deadlineAt === undefined) this.restartGuessDeadline(room, state);
        changed = true;
      }
      sweep.units.add(state);
    }
    return changed;
  }

  /** 按作答单元判答题超时；in-flight 的猜测由回源流程自己结算，硬超时除外。 */
  private recordExpiredGuesses(sweep: RoundSweep): boolean {
    let changed = false;
    for (const state of sweep.units) {
      // 上游正在校验这次猜测（占位已扣、结果未回）：超时由 in-flight 流程自己判定。
      // 巡检在这里抢先记一次 timeout，会让一次真实猜测扣掉两次配额，
      // 并在 attempts 里留下「timeout + wrong/correct」两条互相矛盾的记录。
      // 例外保留：硬超时必须仍然强制结算，否则一次卡死的 in-flight 会拖住整个回合。
      if (state.inFlight && !sweep.isRoundHardExpired) continue;
      const isGuessTimeout =
        state.deadlineAt !== undefined && state.deadlineAt <= sweep.currentTime;
      if (isGuessTimeout || sweep.isRoundHardExpired) {
        this.recordTimeout(sweep.room, state);
        changed = true;
      }
    }
    return changed;
  }

  async createRoom(
    connection: ConnectionRecord,
    payload: Extract<SonGuessrClientMessage, { type: "song.room.create" }>["payload"]
  ) {
    const roomId = ensureRoomId(payload.roomId, this.ctx.testRooms);
    assertTextAllowed(payload.name, payload.userName);
    // 算摘要要跨一次 await：先同步占号挡住并发建房，房间对象在摘要算完、连接复核通过之前
    // 不进房间表，入房、大厅与巡检都看不到没有摘要的私密房。
    const release = this.reservations.hold(roomId, (id) => this.ctx.rooms.has(id));
    try {
      const password =
        payload.visibility === "private" ? this.passwordGate.require(payload.password) : undefined;

      const player = this.createPlayer(
        payload.userName,
        true,
        false,
        tabSeatId(connection, "song", roomId)
      );
      if (connection.isAgent === true) player.isAgent = true;
      const now = this.ctx.now();
      const solo = payload.solo === true;
      const room: SonGuessrRoomRecord = {
        id: roomId,
        name: normalizeWord(payload.name),
        solo,
        visibility: payload.visibility,
        allowSpectators: solo ? false : payload.allowSpectators,
        hostPlayerId: player.id,
        settings: cloneSettings({
          ...DEFAULT_SETTINGS,
          questionMode: solo ? "automatic" : DEFAULT_SETTINGS.questionMode,
          allowAgents: payload.allowAgents === true || connection.agentDriven?.() === true,
        }),
        phase: "waiting",
        roundNumber: 0,
        players: { [player.id]: player },
        chat: [],
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        recentSongIds: [],
        recentSubjectIds: [],
      };

      if (password) room.passwordHash = await this.passwordGate.hash(password);
      // 摘要期间连接可能已经断开：断开后再登记会留下一个没有连接的在线房主，房间永远不空。
      if (!this.ctx.connections.findConnection(connection.id))
        throw new AppError("SESSION_INVALID", "连接状态已经变化，请重新加入");
      // 目标校验全部通过后才解绑旧席位：被拒绝的建房不得销毁原绑定。
      this.ensureConnectionFree(connection);
      this.ctx.rooms.set(roomId, room);
      this.attachConnection(room, player, connection);
      appendSystemMessage(this.ctx, room, `${player.name} 创建了房间`);
      this.ctx.publishRoom(room);
      this.ctx.publishLobby();
      this.ctx.log("song.room.created", room.id, player.id);
      return {
        roomId,
        playerId: player.id,
        sessionToken: player.sessionToken,
        snapshot: buildRoomSnapshot(this.ctx, room),
        privateState: buildPrivateState(this.ctx, room, player),
      };
    } finally {
      release();
    }
  }

  async joinRoom(
    connection: ConnectionRecord,
    roomIdValue: string | undefined,
    payload: Extract<SonGuessrClientMessage, { type: "song.room.join" }>["payload"]
  ) {
    const room = getRoom(this.ctx, ensureRoomId(roomIdValue ?? "", this.ctx.testRooms));
    // 同一张标签页再次加入就是回到原座位：已经进过门，不重复核对口令，也不会与自己撞名。
    const seat = findSeat(this.roomKernel, room, connection);
    if (seat) return this.resumeSeat(connection, room, seat);
    if (room.solo) throw new AppError("SOLO_ROOM_FORBIDDEN", "单人房间不接受其他玩家加入");
    assertAgentAdmission(connection, SONG_ROOM_SHAPE.admission(room));
    await this.passwordGate.verify(room, room.visibility, payload.password, connection.id);
    // 比对摘要要跨一次 await，期间房间可能已关闭：写入前先确认拿到的还是登记中的那一份。
    if (this.ctx.rooms.get(room.id) !== room) throw new AppError("ROOM_NOT_FOUND", "房间已经关闭");
    const name = this.requireName(payload.userName);
    if (
      Object.values(room.players).some(
        (player) => player.name === name && player.membership !== "kicked"
      )
    ) {
      throw new AppError("NAME_CONFLICT", "该用户名已在房间中");
    }

    const membership = room.phase === "waiting" ? "active" : "spectator";
    if (membership === "spectator" && !room.allowSpectators) {
      throw new AppError("SPECTATORS_DISABLED", "当前房间不允许旁观");
    }

    // 目标校验全部通过后才解绑旧席位：密码错误、房号不存在等拒绝不得销毁原绑定。
    this.ensureConnectionFree(connection);
    const player = this.createPlayer(name, false, false, tabSeatId(connection, "song", room.id));
    if (connection.isAgent === true) player.isAgent = true;
    player.membership = membership;
    room.players[player.id] = player;
    this.attachConnection(room, player, connection);
    this.ctx.touch(room);
    appendSystemMessage(this.ctx, room, `${player.name} 加入了房间`);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
    this.ctx.log("song.room.joined", room.id, player.id);
    return {
      roomId: room.id,
      playerId: player.id,
      sessionToken: player.sessionToken,
      snapshot: buildRoomSnapshot(this.ctx, room),
      privateState: buildPrivateState(this.ctx, room, player),
    };
  }

  async reconnectRoom(connection: ConnectionRecord, roomIdValue: string, token: string) {
    const targetRoomId = ensureRoomId(roomIdValue, this.ctx.testRooms);
    const room = getRoom(this.ctx, targetRoomId);
    this.ensureAgentsAllowed(room, connection);

    const player = findSeat(this.roomKernel, room, connection, token);
    if (!player) throw new AppError("SESSION_INVALID", "会话令牌无效");

    return this.resumeSeat(connection, room, player);
  }

  /** 把连接接回既有席位：重连与同标签页再次加入共用，准入判定只有这一份。 */
  private async resumeSeat(
    connection: ConnectionRecord,
    room: SonGuessrRoomRecord,
    player: SonGuessrPlayerRecord
  ) {
    assertSeatResumable(player, connection);

    // 同一条连接重连它本来就在的那个座位时，不能走 detachFromRoom：
    // 那会先把自己的 player 记录删掉，随后的按 token 查找必然落空，重连反而失败。
    // 换房或换座重连则要等目标房号与令牌都校验通过后再释放旧席位：绑定座位的前提是连接空闲。
    if (!(connection.roomId === room.id && connection.playerId === player.id)) {
      this.ensureConnectionFree(connection);
    }

    // 房主空缺时回座的人当场接任：重选只挑在线的人，空缺期间回来的人不会再有第二次机会。
    this.attachConnection(room, player, connection);
    // 不能留给发布时的视图兜底：下面刷新播放地址要等一次 await，期间别人的操作会判
    // 「本回合是否已结束」，缺状态的人会被当成已作答完毕而提前收回合。
    ensureRoundPlayerState(this.ctx, room, player);

    // 网易云播放地址可能带有效期。刷新页面后重新取一次当前回合地址，
    // 只替换 URL，不改动已经固定的答案、歌词片段和回合状态。
    const activeRound = room.phase === "playing" ? room.currentRound : undefined;
    if (activeRound) {
      try {
        const refreshedSong = await withSongAccount(
          this.ctx,
          room,
          activeRound.song.id,
          (cookie) => this.options.musicProvider.getSong(activeRound.song.id, cookie),
          {
            requireVip:
              activeRound.song.id.startsWith("qq:") && activeRound.song.requiresVip === true,
          }
        );
        if (room.phase === "playing" && room.currentRound === activeRound) {
          // 换新对象而不是原地改：provider 可能返回自己缓存/复用的歌曲对象。
          activeRound.song = { ...activeRound.song, audioUrl: refreshedSong.audioUrl };
        }
      } catch (error) {
        // 地址刷新失败不应阻止玩家恢复席位，记录 warning 告警并允许客户端尝试现有地址。
        this.options.eventLogger?.warn("重连刷新歌曲播放地址失败", {
          roomId: room.id,
          songId: activeRound.song.id,
          ...describeError(error),
        });
      }
    }
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
    return {
      roomId: room.id,
      playerId: player.id,
      sessionToken: player.sessionToken,
      snapshot: buildRoomSnapshot(this.ctx, room),
      privateState: buildPrivateState(this.ctx, room, player),
    };
  }

  leaveRoom({ connection }: SongCommandAt) {
    // 显式离开代表账号主动退出：号跟着人一起撤掉。
    return this.detachFromRoom(connection);
  }

  /**
   * 让连接与其当前席位彻底脱钩，并与房间内的 player 记录同步，避免出现
   * 「在线但没有任何连接」的幽灵玩家（onlineCount 永不归零 → 房间永不关闭 →
   * 4 位房间号被耗尽，且只能靠重启进程恢复）。
   *
   * 离开房间一律撤掉自己贡献的号：账号池的定义就是「在房且开关打开者的账号」，
   * 人走了号必须跟着走，否则旧房里会长期挂着一份没有人认领的凭据。网络断线不走这里，
   * 由离线宽限期处理（宽限内号仍在，超期连人带号一起清）。
   */
  private detachFromRoom(connection: ConnectionRecord) {
    const { room, player } = requireRoomPlayer(this.ctx, connection);
    clearMusicSession(this.ctx, room, player.id);
    delete room.players[player.id];
    this.ctx.connections.detach(connection);

    if (Object.keys(room.players).length === 0 && !isTestRoom(this.ctx, room)) {
      this.closeRoom(room, "empty");
      return { left: true, roomClosed: true };
    }

    if (room.hostPlayerId === player.id) this.reassignRemovedHost(room);
    this.releasePendingSubmitter(
      room,
      player.id,
      `${player.name} 离开房间，出题已中止，请重新指定出题人`
    );
    if (room.phase === "playing" && this.isRoundComplete(room)) this.finishRound(room);

    this.ctx.touch(room);
    appendSystemMessage(this.ctx, room, `${player.name} 离开了房间`);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
    return { left: true, roomClosed: false };
  }

  requestSync({ connection, room }: SongCommandAt) {
    connection.resetStateSync?.();
    this.ctx.publishRoom(room, connection);
    return { synced: true };
  }

  setReady(at: SongCommandAt, ready: boolean) {
    const { room, seat: player } = at;
    player.isReady = player.id === room.hostPlayerId ? true : ready;
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    return { ready: player.isReady };
  }

  setSpectator(at: SongCommandAt, spectator: boolean) {
    const { room, seat: player } = at;
    if (room.phase !== "waiting") {
      const targetMembership = spectator ? "spectator" : "active";
      if (targetMembership === "spectator" && !room.allowSpectators) {
        throw new AppError("SPECTATORS_DISABLED", "当前房间不允许旁观");
      }
      // 再次点击同个预约选项时撤销预约
      if (player.nextRoundMembership === targetMembership) {
        player.nextRoundMembership = undefined;
        this.ctx.touch(room);
        this.ctx.publishRoom(room);
        return { spectator: player.membership === "spectator", queued: false };
      }
      player.nextRoundMembership = targetMembership;
      this.ctx.touch(room);
      this.ctx.publishRoom(room);
      return { spectator, queued: true };
    }
    const nextMembership = spectator ? "spectator" : "active";
    player.nextRoundMembership = undefined;
    if (player.membership === nextMembership) return { spectator, queued: false };
    if (spectator) {
      if (!room.allowSpectators) throw new AppError("SPECTATORS_DISABLED", "当前房间不允许旁观");
      player.membership = "spectator";
      player.isReady = false;
      // 旁观者没有队伍：回到玩家组时从个人游玩开始。
      player.team = null;
    } else {
      player.membership = "active";
      player.isReady = player.id === room.hostPlayerId;
    }
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
    return { spectator, queued: false };
  }

  /** 选队伍：只在等待阶段、只给参与玩家，与 CEE 的 `cee.player.team` 同口径。准备状态保留。 */
  setTeam(at: SongCommandAt, team: number | null) {
    const { room, seat: player } = at;
    if (team !== null && (!Number.isInteger(team) || team < 1 || team > SONGUESSR_MAX_TEAM)) {
      throw new AppError("INVALID_TEAM", `队伍号只能是 1–${SONGUESSR_MAX_TEAM}`);
    }
    player.team = team;
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    return { team };
  }

  async updateSettings(at: SongCommandAt, payload: SongUpdateSettingsPayload) {
    const { room } = at;
    const next = { ...room, settings: cloneSettings(room.settings) };
    await this.applyRoomAdmission(next, payload);
    // 口令摘要要跨 await：期间房间可能已开局或关闭，回来先复核再整块覆盖。
    this.assertSettingsEditable(room);
    this.applyRoundSettings(next, room.solo, payload);

    room.name = next.name;
    room.visibility = next.visibility;
    room.passwordHash = next.passwordHash;
    room.allowSpectators = next.allowSpectators;
    room.settings = next.settings;
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
    return { settings: room.settings };
  }

  /**
   * 设置只在「等待且没有开局在途」时可改。开局加载期间阶段仍是 waiting，
   * 只看阶段会放过题型或出题方式的改动，让回合按旧条件选歌却克隆新设置。
   * 这里是跨 await 回来后的复核；入口处的同一判定由命令表的守卫承担。
   */
  private assertSettingsEditable(room: SonGuessrRoomRecord) {
    if (this.ctx.rooms.get(room.id) !== room) throw new AppError("ROOM_NOT_FOUND", "房间已经关闭");
    if (room.phase !== "waiting" || isRoomStarting(room)) {
      throw new AppError("INVALID_PHASE", "只能在等待阶段修改房间设置");
    }
  }

  /** 先算出公开/私密的密码归属再校验，校验失败时 room 上还没有任何写入。 */
  private async applyRoomAdmission(
    next: Pick<SonGuessrRoomRecord, "name" | "visibility" | "passwordHash" | "allowSpectators">,
    payload: SongUpdateSettingsPayload
  ) {
    if (payload.name !== undefined) {
      assertTextAllowed(payload.name);
      next.name = normalizeWord(payload.name) || next.name;
    }
    if (payload.visibility !== undefined) next.visibility = payload.visibility;
    if (payload.allowSpectators !== undefined) next.allowSpectators = payload.allowSpectators;
    if (payload.visibility === "public") next.passwordHash = undefined;
    // 留空保留原口令，给了新值才换摘要：明文只在这段局部变量里存在一次。
    const password = normalizeRoomPassword(payload.password ?? "");
    if (next.visibility === "private" && password) {
      next.passwordHash = await this.passwordGate.hash(password);
    }
    if (next.visibility === "private" && !next.passwordHash) {
      throw new AppError("PASSWORD_REQUIRED", "私密房间需要密码");
    }
  }

  /** 单人房固定由系统出题，不提供手动出题与轮流出题。 */
  private applyRoundSettings(
    next: Pick<SonGuessrRoomRecord, "settings">,
    solo: boolean,
    payload: SongUpdateSettingsPayload
  ) {
    const { settings } = next;
    if (payload.questionType !== undefined) settings.questionType = payload.questionType;
    if (!solo && payload.questionMode !== undefined) settings.questionMode = payload.questionMode;
    if (!solo && payload.autoRotateSubmitter !== undefined) {
      settings.autoRotateSubmitter = payload.autoRotateSubmitter;
    }
    if (!solo && payload.allowCustomClip !== undefined) {
      settings.allowCustomClip = payload.allowCustomClip;
    }
    if (payload.autoFilters !== undefined)
      settings.autoFilters = normalizeAutoFilters(this.ctx, payload.autoFilters);
    if (payload.animeAutoFilters !== undefined) {
      settings.animeAutoFilters = normalizeAnimeAutoFilters(payload.animeAutoFilters);
    }
    if (payload.lyricsLineCount !== undefined) settings.lyricsLineCount = payload.lyricsLineCount;
    if (payload.showLyrics !== undefined) settings.showLyrics = payload.showLyrics;
    if (payload.maxGuessesPerRound !== undefined) {
      settings.maxGuessesPerRound = payload.maxGuessesPerRound;
    }
    if (payload.guessDurationSeconds !== undefined) {
      settings.guessDurationSeconds = payload.guessDurationSeconds;
    }
    if (payload.showGuessTimer !== undefined) settings.showGuessTimer = payload.showGuessTimer;
    if (payload.bloodMode !== undefined) settings.bloodMode = payload.bloodMode;
    if (payload.allowAgents !== undefined) settings.allowAgents = payload.allowAgents;
  }

  kick(at: SongCommandAt, targetPlayerId: string) {
    const { room, seat: player } = at;
    if (targetPlayerId === player.id) throw new AppError("INVALID_TARGET", "房主不能踢出自己");
    const target = room.players[targetPlayerId];
    if (!target || target.membership === "kicked")
      throw new AppError("PLAYER_NOT_FOUND", "玩家不存在");
    this.kickPlayer(room, target);
    return { kicked: true };
  }

  /** 房主踢人与后台移人共用；后台可能移走房主，此时按掉线口径重选房主。 */
  private kickPlayer(room: SonGuessrRoomRecord, target: SonGuessrPlayerRecord) {
    clearMusicSession(this.ctx, room, target.id);
    target.membership = "kicked";
    target.online = false;
    const targetConnection = this.ctx.connections.findConnectionByPlayer(room.id, target.id);
    if (targetConnection) {
      (targetConnection.sendPacket ?? targetConnection.send)(
        createEvent("song.room.kicked", { roomId: room.id })
      );
      this.ctx.connections.detach(targetConnection);
      targetConnection.close(4003, "kicked");
    }

    this.releasePendingSubmitter(
      room,
      target.id,
      `出题人 ${target.name} 已被移出，请重新指定出题人`
    );
    if (room.hostPlayerId === target.id) this.reassignRemovedHost(room);
    if (room.phase === "playing" && this.isRoundComplete(room)) this.finishRound(room);
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
  }

  adminListRooms(): AdminRoomView[] {
    return [...this.ctx.rooms.values()].map((room) =>
      adminRoomView(room, Object.values(room.players), {
        game: "song",
        name: room.name,
        phase: room.phase,
        visibility: room.visibility,
        hidden: isTestRoom(this.ctx, room) || room.solo,
        roundNumber: room.roundNumber,
      })
    );
  }

  async adminCloseRoom(roomId: string): Promise<void> {
    this.closeRoom(requireAdminRoom(this.ctx.rooms, roomId), ADMIN_CLOSE_REASON);
  }

  async adminKickPlayer(roomId: string, playerId: string): Promise<void> {
    const room = requireAdminRoom(this.ctx.rooms, roomId);
    const target = room.players[playerId];
    if (!target || target.membership === "kicked")
      throw new AppError("PLAYER_NOT_FOUND", "玩家不存在");
    this.kickPlayer(room, target);
  }

  transferHost(at: SongCommandAt, targetPlayerId: string) {
    const { room } = at;
    const target = room.players[targetPlayerId];
    const previousHostId = room.hostPlayerId;
    transferHost(room, target);
    this.settleHostChange(room, previousHostId);
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    return { hostPlayerId: room.hostPlayerId };
  }

  addBots(at: SongCommandAt, countValue?: number) {
    const { room } = at;
    const currentCount = Object.values(room.players).length;
    if (currentCount >= TEST_MODE_MAX_PLAYERS) {
      throw new AppError("ROOM_FULL", `测试房间最多 ${TEST_MODE_MAX_PLAYERS} 名玩家`);
    }
    // 单条指令的批量上限只约束「一次能加多少」，必须再卡一次总人数：
    // 否则反复调用就能把房间撑到任意规模，内存与全房广播量都无上界。
    const count = clampInt(
      countValue ?? 1,
      1,
      Math.min(TEST_BOT_BATCH_LIMIT, TEST_MODE_MAX_PLAYERS - currentCount)
    );
    const added: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const botIndex = Object.values(room.players).filter((candidate) => candidate.isBot).length;
      const suffix = BOT_NAME_SUFFIXES[botIndex] ?? String(botIndex + 1);
      const bot = this.createPlayer(`测试人机 ${suffix}`, false, true);
      bot.isReady = true;
      room.players[bot.id] = bot;
      added.push(bot.id);
    }
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    return { addedPlayerIds: added };
  }

  removeBots(at: SongCommandAt, countValue?: number) {
    const { room } = at;
    const count = clampInt(countValue ?? 1, 1, TEST_BOT_BATCH_LIMIT);
    const bots = Object.values(room.players)
      .filter((candidate) => candidate.isBot)
      .sort((left, right) => right.joinedAt - left.joinedAt)
      .slice(0, count);
    for (const bot of bots) delete room.players[bot.id];
    if (room.phase === "playing" && this.isRoundComplete(room)) this.finishRound(room);
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    return { removedPlayerIds: bots.map((bot) => bot.id) };
  }

  async startGame(at: SongCommandAt) {
    const { connection, room, seat: player } = at;
    const automatic = room.solo || room.settings.questionMode === "automatic";

    // 自动与手动开局均先占锁，避免重复点击并发创建两轮。
    const operation = Symbol("automaticRound");
    this.acquireStartLock(room, automatic, operation);
    try {
      if (
        !hasEnabledPoolAccount(this.ctx, room, "netease") &&
        !hasEnabledPoolAccount(this.ctx, room, "qq")
      ) {
        throw new AppError("MUSIC_LOGIN_REQUIRED", "开始游戏前请先扫码登录音乐账号");
      }
      const provider = this.options.musicProvider;
      const getLoginStatus = provider.getLoginStatus?.bind(provider);
      if (!getLoginStatus) {
        throw new AppError("MUSIC_AUTH_UNAVAILABLE", "音乐登录状态校验不可用");
      }
      // 复核每端当前会被选中的那一号：复核的意义是「开局前发现凭据已失效」，
      // 池里排在前面的号失效就会被选中，逐个复核只会把开局拖成 N 倍慢。
      const revalidations = (["netease", "qq"] as const).flatMap((platform) => {
        const entry = primaryPoolEntry(this.ctx, room, platform);
        return entry
          ? [
              {
                platform,
                entry,
                operation:
                  room.runtime?.musicAuthOperations?.[
                    musicAuthOperationKey(entry.playerId, platform)
                  ],
                label: platform === "qq" ? "QQ音乐" : "网易云",
              },
            ]
          : [];
      });
      const verifySession = (platform?: MusicAuthPlatform) => {
        if (
          this.ctx.rooms.get(room.id) !== room ||
          room.hostPlayerId !== player.id ||
          connection.roomId !== room.id ||
          connection.playerId !== player.id ||
          !player.online
        ) {
          throw new AppError("MUSIC_SESSION_INVALID", "音乐会话已变更，请重新开始");
        }
        for (const target of revalidations) {
          if (platform !== undefined && target.platform !== platform) continue;
          const current =
            room.runtime?.musicAuthOperations?.[
              musicAuthOperationKey(target.entry.playerId, target.platform)
            ];
          if (!musicPool(room).includes(target.entry) || current !== target.operation) {
            throw new AppError("MUSIC_SESSION_INVALID", `${target.label}会话已变更，请重新开始`);
          }
        }
      };
      for (const target of revalidations) {
        await refreshMusicSessionAccount(this.ctx, {
          room,
          platform: target.platform,
          entry: target.entry,
          operation: target.operation,
          label: target.label,
          verifySession,
          getLoginStatus,
        });
      }

      // 上面的复核跨了 await：回来先确认房间还在、阶段没被别的流程推进，再动任何状态。
      if (this.ctx.rooms.get(room.id) !== room || room.phase !== "waiting") {
        throw new AppError("ROUND_EXPIRED", "出题操作已失效");
      }

      // 开局同样是轮次起点：把只可能在离线期间留下的席位预约先结算，再按最终席位查准备。
      this.applyQueuedMemberships(room);
      this.ensurePlayersReadyToStart(room, automatic);

      room.pendingSubmitterPlayerId = undefined;
      room.pendingSubmitterDeadlineAt = undefined;
      room.pendingSubmitterAssignedAt = undefined;
      room.submitterPrompt = undefined;
      room.currentRound = undefined;
      room.roundSummary = undefined;
      if (automatic) {
        await startAutomaticRound(this.ctx, room, () => {
          verifySession();
          if (room.phase !== "waiting" || room.runtime?.automaticRoundOperation !== operation) {
            throw new AppError("ROUND_EXPIRED", "出题操作已失效");
          }
        });
      } else {
        room.phase = "choosingSubmitter";
      }
      room.finalScores = undefined;
      this.ctx.touch(room);
      this.ctx.publishRoom(room);
      this.ctx.publishLobby();
      this.ctx.log("song.game.started", room.id, player.id);
      return { started: true };
    } finally {
      this.releaseStartLock(room, automatic, operation);
    }
  }

  /** 自动与手动开局互斥：占住对应的开局标记。 */
  private acquireStartLock(room: SonGuessrRoomRecord, automatic: boolean, operation: symbol) {
    if (!automatic) {
      roomRuntime(room).manualRoundStarting = true;
      return;
    }

    roomRuntime(room).automaticRoundOperation = operation;
    roomRuntime(room).automaticRoundLoading = true;
  }

  /** 开局标记只在仍属于本次操作时清空，避免踩掉后来者的锁。 */
  private releaseStartLock(room: SonGuessrRoomRecord, automatic: boolean, operation: symbol) {
    if (!automatic) {
      roomRuntime(room).manualRoundStarting = false;
      return;
    }

    if (room.runtime?.automaticRoundOperation !== operation) return;
    roomRuntime(room).automaticRoundOperation = undefined;
    roomRuntime(room).automaticRoundLoading = false;
  }

  /** 开局门槛：至少两名在线真人且全部准备；手动开局还得有可选出题人。 */
  private ensurePlayersReadyToStart(room: SonGuessrRoomRecord, automatic: boolean) {
    // 单人房间由系统直接出题，没有出题人与准备环节。
    if (room.solo) return;

    const players = activePlayers(room);
    if (players.length < 2) throw new AppError("NOT_ENOUGH_PLAYERS", "至少需要两名正式玩家");
    if (players.some((candidate) => !candidate.isReady)) {
      throw new AppError("PLAYERS_NOT_READY", "仍有玩家未准备");
    }
    if (!automatic && submitterCandidates(this.ctx, room).length === 0) {
      throw new AppError(
        "NO_SUBMITTER_CANDIDATE",
        "暂无可选出题人：出题人的队友会一起观战，需要留下猜歌的玩家"
      );
    }
  }

  /** 指定出题人：时限从此刻起算，同时记下起点作为后续顺延的封顶基准。 */
  private assignSubmitterDeadline(room: SonGuessrRoomRecord) {
    room.pendingSubmitterAssignedAt = this.ctx.now();
    room.pendingSubmitterDeadlineAt = this.ctx.now() + SUBMIT_SONG_TIMEOUT_MS;
  }

  /** 出题人提交时顺延时限，但以指定时刻起算的两个时限封顶：选题阶段必须有服务端硬上限。 */
  private extendSubmitterDeadline(room: SonGuessrRoomRecord) {
    const assignedAt = room.pendingSubmitterAssignedAt ?? this.ctx.now();
    room.pendingSubmitterDeadlineAt = Math.min(
      this.ctx.now() + SUBMIT_SONG_TIMEOUT_MS,
      assignedAt + 2 * SUBMIT_SONG_TIMEOUT_MS
    );
  }

  chooseSubmitter(at: SongCommandAt, targetPlayerId: string) {
    const { room } = at;
    const target = room.players[targetPlayerId];
    if (!target || !target.online || target.membership === "kicked" || target.isBot) {
      throw new AppError("INVALID_TARGET", "出题人必须是在线真人玩家");
    }
    if (!submitterCandidates(this.ctx, room).includes(target)) {
      throw new AppError("INVALID_TARGET", "指定后没有可以猜歌的玩家：出题人的队友会一起观战");
    }

    room.pendingSubmitterPlayerId = target.id;
    this.assignSubmitterDeadline(room);
    room.submitterPrompt = undefined;
    room.phase = "submittingSong";
    room.roundSummary = undefined;
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
    return { submitterPlayerId: target.id };
  }

  /**
   * 出题人预览自己选中的歌：完整音频地址与逐字歌词，用于片段编辑器。
   *
   * 只允许当前待出题人调用，且猜歌阶段一律拒绝：否则猜测者可以借这个命令拿到答案的
   * 歌词与试听。
   */
  async getSongClipPreview(
    at: SongCommandAt,
    songId: string,
    sources?: readonly string[],
    requiresVip?: boolean
  ): Promise<{ song: SongClipPreview }> {
    const { room, seat: player } = at;
    requireMusicQuota(this.ctx, at);
    const submitterId = player.id;
    const { song, alternateSongIds } = await loadSongWithSources(
      this.ctx,
      room,
      songId,
      sources,
      requiresVip
    );
    if (
      room.phase !== "submittingSong" ||
      room.pendingSubmitterPlayerId !== submitterId ||
      room.players[submitterId] !== player
    ) {
      throw new AppError("NOT_SUBMITTER", "出题人已变更，请重新选歌");
    }
    // 与自动抽题共用同一套切片：编辑器的默认区间就是「不手动改会播的那一段」。
    const suggested = createSongLyricClip(
      song.lyrics,
      room.settings.lyricsLineCount,
      this.ctx.random,
      song.durationMs,
      songTitleNames(song)
    );
    return {
      song: {
        id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        pictureUrl: song.pictureUrl,
        durationMs: song.durationMs,
        audioUrl: song.audioUrl,
        lyrics: song.lyrics,
        chorus: song.chorus,
        sources: [song.id, ...alternateSongIds],
        requiresVip: song.requiresVip,
        suggestedClip: { startTime: suggested.startTime, endTime: suggested.endTime },
      },
    };
  }

  async submitSong(
    at: SongCommandAt,
    songId: string,
    clip?: SongClipRange,
    sources?: readonly string[],
    requiresVip?: boolean
  ) {
    const { room, seat: player } = at;
    const submitterId = player.id;
    // 按下选歌即视为还在出题：时限顺延，慢一点的上游回源不该被巡检判成弃题。
    this.extendSubmitterDeadline(room);
    const { song, alternateSongIds } = await loadSongWithSources(
      this.ctx,
      room,
      songId,
      sources,
      requiresVip
    );
    // 音乐接口是异步的，返回时出题人可能已经退出或被踢；不能再安装一个失去归属的回合。
    if (
      room.phase !== "submittingSong" ||
      room.pendingSubmitterPlayerId !== submitterId ||
      room.players[submitterId] !== player ||
      player.membership === "kicked" ||
      !player.online
    ) {
      return { ignored: true };
    }
    // 不再按会员状态拦截会员专享曲：`getSong` 已经负责把受限歌曲交给解灰链路取回完整音频，
    // 拿不到地址时会直接抛 `SONG_UNAVAILABLE`，出题资格以「实际有没有音频」为准。
    const roundNumber = installRound(
      this.ctx,
      room,
      song,
      player.id,
      undefined,
      undefined,
      // 关闭自选片段后忽略客户端带来的区间，与没传片段完全一致。
      createManualLyricClip(song, room.settings.allowCustomClip === false ? undefined : clip)
    );
    if (room.currentRound?.number === roundNumber) {
      room.currentRound.alternateSongIds = alternateSongIds;
    }
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();

    if (this.isRoundComplete(room)) {
      this.finishRound(room);
      this.ctx.publishRoom(room);
    }
    return { roundNumber };
  }

  async submitAnime(at: SongCommandAt, subjectId: string, songId?: string) {
    const { room, seat: player } = at;
    const provider = this.options.bangumiProvider;
    if (!provider) throw new AppError("BANGUMI_API_UNAVAILABLE", "当前未配置 Bangumi 接口");
    const submitterId = player.id;
    this.extendSubmitterDeadline(room);
    const anime = await provider.getSubject(subjectId);
    const resolved = songId
      ? await resolveSpecifiedAnimeSong(this.ctx, room, anime, songId)
      : await resolveAnimeSong(this.ctx, room, anime);
    if (
      room.phase !== "submittingSong" ||
      room.pendingSubmitterPlayerId !== submitterId ||
      room.players[submitterId] !== player ||
      player.membership === "kicked" ||
      !player.online
    )
      return { ignored: true };
    const roundNumber = installRound(
      this.ctx,
      room,
      resolved.song,
      player.id,
      anime,
      resolved.track
    );
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
    if (this.isRoundComplete(room)) {
      this.finishRound(room);
      this.ctx.publishRoom(room);
    }
    return { roundNumber };
  }

  /**
   * 首名玩家真正具备答题条件时，才锚定本回合的「音频就绪宽限期」与「硬截止」。
   * 幂等：同一回合只锚定一次，后续玩家就绪不会顺延其他玩家的倒计时。
   */
  private armRoundDeadlines(room: SonGuessrRoomRecord) {
    const round = room.currentRound;
    if (!round || round.hardDeadlineAt !== undefined) return;
    const now = this.ctx.now();
    round.audioReadyDeadlineAt = now + AUDIO_READY_GRACE_MS;
    // 硬截止必须覆盖本回合全部猜测窗口：每次作答（猜错、超时或宽限补偿）都会重开
    // 一整段 `guessDurationSeconds`。只按单次窗口计算时，第一次超时后剩余窗口就只会
    // 剩下一段裕量，后续猜测的倒计时被越截越短，最后一次往往提交即判超时。
    // 裕量同样按窗口计，吸收每次校验猜测回源的往返耗时。
    round.hardDeadlineAt =
      now +
      round.settings.maxGuessesPerRound *
        (round.settings.guessDurationSeconds + ROUND_HARD_TIMEOUT_MARGIN_S) *
        1_000;
    round.answeringStartedAt = now;
  }

  audioReady(at: SongCommandAt, roundNumber: number) {
    const { room, seat: player } = at;
    // 页面切后台/重连时可能补发旧回合的 ready；状态过渡期间应幂等忽略，
    // 不把一个正常的陈旧通知显示成「当前没有进行中的回合」。
    if (room.phase !== "playing" || !room.currentRound || room.runtime?.automaticRoundLoading) {
      return { ignored: true };
    }
    const round = room.currentRound;
    if (round.number !== roundNumber) return { ignored: true };
    const state = ensureRoundPlayerState(this.ctx, room, player) ?? round.players[player.id];
    if (
      !state ||
      (player.id === round.submitterPlayerId &&
        !canTestSubmitterGuess(this.ctx, room, player.id)) ||
      player.membership !== "active"
    ) {
      return { ignored: true };
    }
    if (!round.audioReady[player.id] && !this.isUnitFinished(round, state)) {
      // 首个就绪的玩家定义本回合的倒计时起点；此时才锚定硬截止。
      this.armRoundDeadlines(room);
      round.audioReady[player.id] = true;
      // 必须用「当前时刻」起算，不能复用本回合统一的 audioReadyDeadlineAt：
      // 自动选曲会占用数秒到数十秒，用旧锚点会得到一个可能已过期的截止时刻，
      // 巡检随即把它当成答题超时，玩家还没数到 0 就被判超时。
      // 队伍共用一份限时：队友先就绪时计时已经开始，不再重开。
      if (state.deadlineAt === undefined) this.restartGuessDeadline(room, state);
    }
    this.ctx.touch(room);
    // 全队的截止时刻可能刚起算，队友的私有状态一并刷新。
    for (const memberId of state.memberIds) {
      const member = room.players[memberId];
      if (member) publishPrivateState(this.ctx, room, member);
    }
    return { deadlineAt: state.deadlineAt };
  }

  async audioFailed(at: SongCommandAt, roundNumber: number) {
    const { connection, room, seat: player } = at;
    const round = room.currentRound;
    if (room.phase !== "playing" || !round || round.number !== roundNumber)
      return { ignored: true };
    if (
      player.membership !== "active" ||
      (player.id === round.submitterPlayerId && !canTestSubmitterGuess(this.ctx, room, player.id))
    ) {
      return { ignored: true };
    }
    // 刷新播放地址同样命中那个共享的上游实例，必须一起计入配额。
    if (!this.ctx.musicLimiter.allow(connection.id, this.ctx.now())) {
      throw new AppError("RATE_LIMITED", "音乐请求过于频繁，请稍后再试");
    }
    const provider = this.options.musicProvider;
    const refresh = provider.refreshSongAudio?.bind(provider);
    if (!refresh) throw new AppError("MUSIC_API_UNAVAILABLE", "当前音乐 API 不支持刷新播放地址");
    const audioUrl = await refreshRoundAudio(this.ctx, room, round, refresh);
    if (room.phase !== "playing" || room.currentRound !== round) return { ignored: true };
    round.song = { ...round.song, audioUrl };
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    return { refreshed: true };
  }

  /**
   * 提交时补结算已经过去的猜测窗口。
   *
   * 巡检每 10 秒才落一次超时，旧窗口到期到巡检落账之间存在空窗：这期间提交的猜测
   * 属于下一段窗口（玩家搜歌时还没超时、点提交时才过点），不能拿旧截止时刻直接拒绝。
   * 这里按巡检同一口径先记一次超时并重开倒计时，让本次提交作为新窗口的第一次作答继续；
   * 次数刚好用尽时由调用方重新校验后拒绝。
   *
   * 回合硬截止已过时与巡检一致：强制结算整回合，不再接受猜测。
   */
  private settleExpiredGuessWindow(room: SonGuessrRoomRecord, state: SonGuessrRoundPlayerState) {
    const round = room.currentRound;
    if (!round) return;
    const now = this.ctx.now();
    if (round.hardDeadlineAt !== undefined && now >= round.hardDeadlineAt) {
      this.settlePlayingRound(room, now);
      return;
    }
    if (state.deadlineAt === undefined || state.deadlineAt > now) return;
    this.recordTimeout(room, state);
    if (this.isRoundComplete(room)) this.finishRound(room);
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
  }

  /** 关键修复：在让出事件循环前先占位自增并加锁，防止并发穿透配额上限。 */
  private beginGuessAttempt(state: SonGuessrRoundPlayerState, player: SonGuessrPlayerRecord) {
    state.inFlight = true;
    state.guessesUsed += 1;
    player.totalGuesses += 1;
  }

  /** 上游查询失败只回滚本回合的占位：回合已切换时计数归入上一局，不再改动。 */
  private rollbackGuessAttempt(
    room: SonGuessrRoomRecord,
    round: SonGuessrRoundRecord,
    player: SonGuessrPlayerRecord,
    state: SonGuessrRoundPlayerState
  ) {
    if (room.phase === "playing" && room.currentRound === round) {
      state.guessesUsed = Math.max(0, state.guessesUsed - 1);
      player.totalGuesses = Math.max(0, player.totalGuesses - 1);
    }
    state.inFlight = false;
  }

  /** 异步返回后复验房间与回合状态，失效时先释放占位再报错。 */
  private requireGuessStillCurrent(
    room: SonGuessrRoomRecord,
    round: SonGuessrRoundRecord,
    player: SonGuessrPlayerRecord,
    state: SonGuessrRoundPlayerState
  ) {
    if (room.phase !== "playing" || room.currentRound !== round || player.membership !== "active") {
      state.inFlight = false;
      throw new AppError("ROUND_EXPIRED", "该回合已结束");
    }
    state.inFlight = false;
  }

  /**
   * 可作答的作答单元：出题人（测试房里出题人自己也能猜）、出题人的观战队友与人机都不算。
   * 计分的分母（正确率、血战排名、难度分）统一取自这里，不能再各自用 `activePlayers` 凑。
   *
   * 单元一经登记就留在分母里：已猜中的人随后离房或被清理，名次（分子）不会回退，
   * 分母若按结算时的在房成员重算就会小于名次，血战速度系数变负。口径与 CEE 的
   * 「血战分母冻结为开局实际猜题人数」一致；回合中途加入的玩家登记新单元时同样计入。
   */
  private answerableUnits(
    room: SonGuessrRoomRecord,
    round: SonGuessrRoundRecord
  ): SonGuessrRoundPlayerState[] {
    const submitterState = round.players[round.submitterPlayerId];
    const submitterAnswers = canTestSubmitterGuess(this.ctx, room, round.submitterPlayerId);
    return [...new Set(Object.values(round.players))].filter(
      (unit) => !unit.bot && (submitterAnswers || unit !== submitterState)
    );
  }

  /** 用时占比：从「首名玩家能答题」起算，除以单次作答时限，夹到 0–1。 */
  private answerElapsedRatio(round: SonGuessrRoundRecord, at: number): number {
    const startedAt = round.answeringStartedAt ?? round.startedAt;
    const limitMs = round.settings.guessDurationSeconds * 1_000;
    if (limitMs <= 0) return 1;
    return Math.min(1, Math.max(0, (at - startedAt) / limitMs));
  }

  /** 猜中计分，猜错则续期下一次猜测的倒计时。 */
  private settleGuessResult(
    room: SonGuessrRoomRecord,
    round: SonGuessrRoundRecord,
    player: SonGuessrPlayerRecord,
    state: SonGuessrRoundPlayerState,
    correct: boolean
  ) {
    if (!correct) {
      this.restartGuessDeadline(room, state);
      return;
    }
    state.correct = true;
    state.deadlineAt = undefined;
    player.correctGuesses += 1;
    const factors = computeSongAnswererFactors({
      bloodMode: round.settings.bloodMode,
      // 每队只有一位猜中者进 correctPlayerIds，名次即本单元的抢答顺序。
      rank: round.correctPlayerIds.length + 1,
      answerableCount: this.answerableUnits(room, round).length,
      elapsedRatio: this.answerElapsedRatio(round, this.ctx.now()),
      guessesUsed: state.guessesUsed,
      maxGuessesPerRound: round.settings.maxGuessesPerRound,
    });
    player.score += factors.score;
    round.answererBreakdown.push({ playerId: player.id, ...factors });
    round.correctPlayerIds.push(player.id);
  }

  /**
   * 本轮结算：出题人得分与计分拆解。
   *
   * 难度分要先知道整轮的猜中率、平均尝试与平均用时，所以只能在这里算，
   * 不能像答题者那样随每次猜中即时入账。`answererBreakdown` 里已是逐人系数，
   * 这里只补平均用时与难度分，不在两处各算一遍。
   */
  private roundScoring(
    room: SonGuessrRoomRecord,
    round: SonGuessrRoundRecord
  ): { submitterScore: number; breakdown?: SonGuessrScoreBreakdown } {
    const units = this.answerableUnits(room, round);
    const answerableCount = units.length;
    const correctCount = round.correctPlayerIds.length;
    const difficulty = computeSongDifficulty({
      answerableCount,
      correctCount,
      totalAttempts: units.reduce((sum, unit) => sum + unit.guessesUsed, 0),
      correctElapsedRatios: round.answererBreakdown.map((factor) => {
        const attempt = round.attempts.find(
          (item) => item.playerId === factor.playerId && item.result === "correct"
        );
        return this.answerElapsedRatio(round, attempt?.createdAt ?? this.ctx.now());
      }),
      maxGuessesPerRound: round.settings.maxGuessesPerRound,
    });
    const averageAnswererScore = correctCount
      ? round.answererBreakdown.reduce((sum, factor) => sum + factor.score, 0) / correctCount
      : 0;
    return {
      submitterScore: computeSongSubmitterScore({
        answerableCount,
        correctCount,
        averageAnswererScore,
        difficulty,
      }),
      breakdown: { difficulty, answerableCount, players: [...round.answererBreakdown] },
    };
  }

  async guess(at: SongCommandAt, songId: string) {
    const { room, seat: player } = at;
    const round = this.requireActiveRound(room);
    // 猜番回合的答案是番剧，不是歌：用猜歌命令认出出题歌曲就会绕过猜番。按回合本身判定题型。
    if (round.settings.questionType !== "song" || round.anime) {
      throw new AppError("INVALID_QUESTION_TYPE", "当前房间是听歌猜番模式");
    }
    if (player.membership !== "active") throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能猜歌");
    const state = ensureRoundPlayerState(this.ctx, room, player) ?? round.players[player.id];
    if (
      player.id === round.submitterPlayerId &&
      !canTestSubmitterGuess(this.ctx, room, player.id)
    ) {
      throw new AppError("SUBMITTER_CANNOT_GUESS", "出题人不能参与猜歌");
    }
    if (round.observerIds.includes(player.id))
      throw new AppError("TEAM_OBSERVER", "队友出题，你本局观战");
    if (!state) throw new AppError("SPECTATOR_FORBIDDEN", "你本局不参与猜歌");
    if (!round.audioReady[player.id]) throw new AppError("AUDIO_NOT_READY", "音频尚未准备完成");
    this.ensureUnitOpen(round, state, player.id);
    this.settleExpiredGuessWindow(room, state);
    if (room.phase !== "playing" || room.currentRound !== round) {
      throw new AppError("ROUND_EXPIRED", "该回合已结束");
    }
    // 补记的超时可能正好用掉最后一次机会，必须按结算后的状态重新校验。
    this.ensureUnitOpen(round, state, player.id);
    this.beginGuessAttempt(state, player);

    let guessedSong: SongDetails;
    try {
      guessedSong = await withSongAccount(this.ctx, room, songId, (cookie) =>
        this.options.musicProvider.getSongMetadata(songId, cookie)
      );
    } catch (error) {
      this.rollbackGuessAttempt(room, round, player, state);
      throw error;
    }

    // 异步返回后复验房间与回合状态
    this.requireGuessStillCurrent(room, round, player, state);
    const correct = this.isCorrectSong(guessedSong, round);
    const attempt: SongGuessAttempt = {
      id: this.ctx.ids.next("song_guess"),
      playerId: player.id,
      playerName: player.name,
      guessNumber: state.guessesUsed,
      createdAt: this.ctx.now(),
      result: correct ? "correct" : "wrong",
      guessedSong: publicSong(guessedSong),
      feedback: this.buildFeedback(guessedSong, round.song),
    };
    round.attempts.push(attempt);

    this.settleGuessResult(room, round, player, state, correct);

    if (this.isRoundComplete(room)) {
      this.finishRound(room);
    }
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    return {
      attempt,
      remainingGuesses: Math.max(0, round.settings.maxGuessesPerRound - state.guessesUsed),
    };
  }

  async guessAnime(at: SongCommandAt, subjectId: string) {
    const { room, seat: player } = at;
    const round = this.requireActiveRound(room);
    if (room.settings.questionType !== "anime" || !round.anime) {
      throw new AppError("INVALID_QUESTION_TYPE", "当前房间不是听歌猜番模式");
    }
    if (round.observerIds.includes(player.id))
      throw new AppError("TEAM_OBSERVER", "队友出题，你本局观战");
    const state = ensureRoundPlayerState(this.ctx, room, player) ?? round.players[player.id];
    if (!state || player.membership !== "active")
      throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能猜番");
    if (
      player.id === round.submitterPlayerId &&
      !canTestSubmitterGuess(this.ctx, room, player.id)
    ) {
      throw new AppError("SUBMITTER_CANNOT_GUESS", "出题人不能参与猜番");
    }
    if (!round.audioReady[player.id]) throw new AppError("AUDIO_NOT_READY", "音频尚未准备完成");
    this.ensureUnitOpen(round, state, player.id);
    this.settleExpiredGuessWindow(room, state);
    if (room.phase !== "playing" || room.currentRound !== round) {
      throw new AppError("ROUND_EXPIRED", "该回合已结束");
    }
    // 补记的超时可能正好用掉最后一次机会，必须按结算后的状态重新校验。
    this.ensureUnitOpen(round, state, player.id);

    const provider = this.options.bangumiProvider;
    if (!provider) throw new AppError("BANGUMI_API_UNAVAILABLE", "当前未配置 Bangumi 接口");
    this.beginGuessAttempt(state, player);
    let guessedAnime: BangumiSubjectDetails;
    try {
      guessedAnime = await provider.getSubject(subjectId);
    } catch (error) {
      this.rollbackGuessAttempt(room, round, player, state);
      throw error;
    }
    this.requireGuessStillCurrent(room, round, player, state);
    const correct = guessedAnime.id === round.anime.id;
    const attempt: SongGuessAttempt = {
      id: this.ctx.ids.next("song_guess"),
      playerId: player.id,
      playerName: player.name,
      guessNumber: state.guessesUsed,
      createdAt: this.ctx.now(),
      result: correct ? "correct" : "wrong",
      guessedAnime: publicAnime(guessedAnime),
    };
    round.attempts.push(attempt);
    this.settleGuessResult(room, round, player, state, correct);
    if (this.isRoundComplete(room)) this.finishRound(room);
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    return {
      attempt,
      remainingGuesses: Math.max(0, round.settings.maxGuessesPerRound - state.guessesUsed),
    };
  }

  giveUp(at: SongCommandAt) {
    const { room, seat: player } = at;
    const round = this.requireActiveRound(room);
    const state = ensureRoundPlayerState(this.ctx, room, player) ?? round.players[player.id];
    if (!state || player.membership !== "active") {
      throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能执行猜歌操作");
    }
    if (
      player.id === round.submitterPlayerId &&
      !canTestSubmitterGuess(this.ctx, room, player.id)
    ) {
      throw new AppError("SUBMITTER_CANNOT_GIVE_UP", "出题人无需放弃");
    }
    if (state.inFlight)
      throw new AppError(
        "GUESS_IN_PROGRESS",
        state.memberIds.length > 1 ? "队友正在提交猜测，请稍候" : "正在校验上一次猜测，请稍候"
      );
    if (state.correct)
      throw new AppError(
        "ALREADY_CORRECT",
        state.memberIds.length > 1 ? "本队已经猜中了" : "你已经猜对了"
      );
    if (state.gaveUp || state.guessesUsed >= round.settings.maxGuessesPerRound) {
      throw new AppError(
        "ROUND_ACTION_FINISHED",
        state.memberIds.length > 1 ? "本队已完成本回合" : "你已完成本回合操作"
      );
    }

    state.gaveUp = true;
    state.deadlineAt = undefined;
    round.attempts.push({
      id: this.ctx.ids.next("song_guess"),
      playerId: player.id,
      playerName: player.name,
      guessNumber: state.guessesUsed + 1,
      createdAt: this.ctx.now(),
      result: "gaveUp",
    });
    if (this.isRoundComplete(room)) this.finishRound(room);
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    return { gaveUp: true };
  }

  skipRound(at: SongCommandAt) {
    const { room } = at;
    this.requireActiveRound(room);
    // 跳过不参与结算：出题人拿不到任何奖励，避免「选出题人 → 立刻跳过」的零成本刷分。
    this.finishRound(room, true);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
    return { skipped: true };
  }

  async nextRound(at: SongCommandAt) {
    const { connection, room, seat: player } = at;
    if (room.solo || room.settings.questionMode === "automatic")
      return this.beginAutomaticNextRound(connection, room, player);
    return this.beginManualNextRound(room);
  }

  /**
   * 出题人失效（断线、离房、被踢或选题超时）：退回选出题人阶段，并把原因写进房间公告。
   * 只有当前待出题人能解除这个阶段，别人的断线不该把选题中的出题人踢下来。
   *
   * 这个阶段只有出题人能推进房间，界面又会自动收起选歌面板，不说明原因的切换在玩家眼里
   * 就是「页面莫名回到选人」，房主也不知道该不该重选同一个人。
   */
  private releasePendingSubmitter(room: SonGuessrRoomRecord, playerId: string, reason: string) {
    if (room.phase !== "submittingSong" || room.pendingSubmitterPlayerId !== playerId) return;
    room.pendingSubmitterPlayerId = undefined;
    room.pendingSubmitterDeadlineAt = undefined;
    room.pendingSubmitterAssignedAt = undefined;
    room.submitterPrompt = reason;
    room.phase = "choosingSubmitter";
    appendSystemMessage(this.ctx, room, reason);
  }

  /** 人数不足以开局：退回等待阶段，两名玩家的准备状态清零。 */
  private fallBackToWaiting(room: SonGuessrRoomRecord) {
    room.pendingSubmitterPlayerId = undefined;
    room.pendingSubmitterDeadlineAt = undefined;
    room.pendingSubmitterAssignedAt = undefined;
    room.submitterPrompt = undefined;
    room.phase = "waiting";
    clearRoundMarks(room);
    this.resetReadyState(room);
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
  }

  /** 单人房永远满足开局人数，其余房间要两名在线正式玩家。 */
  private hasNextRoundQuorum(room: SonGuessrRoomRecord) {
    if (room.solo) return true;
    return activePlayers(room).filter((candidate) => candidate.online).length >= 2;
  }

  /** 自动出题下一回合：抽题期间房主可能换人或回合被别处推进，失效即丢弃结果。 */
  private async beginAutomaticNextRound(
    connection: ConnectionRecord,
    room: SonGuessrRoomRecord,
    player: SonGuessrPlayerRecord
  ) {
    if (room.runtime?.automaticRoundLoading) throw new AppError("ROUND_BUSY", "正在准备下一回合");
    const previousRound = room.currentRound;
    const previousSummary = room.roundSummary;
    const operation = Symbol("automaticRound");
    roomRuntime(room).automaticRoundOperation = operation;
    roomRuntime(room).automaticRoundLoading = true;
    const isCurrent = () =>
      this.ctx.rooms.get(room.id) === room &&
      room.runtime?.automaticRoundOperation === operation &&
      room.phase === "roundResult" &&
      room.currentRound === previousRound &&
      room.hostPlayerId === player.id &&
      player.online &&
      connection.roomId === room.id &&
      connection.playerId === player.id;
    const verify = () => {
      if (!isCurrent()) throw new AppError("ROUND_EXPIRED", "出题操作已失效");
    };
    try {
      this.applyQueuedMemberships(room);
      if (!this.hasNextRoundQuorum(room)) {
        room.currentRound = undefined;
        room.roundSummary = undefined;
        this.fallBackToWaiting(room);
        return { nextRound: room.roundNumber + 1, waiting: true };
      }
      await startAutomaticRound(this.ctx, room, verify);
    } catch (error) {
      // 自动题库临时失败时保留答案页，房主可以重试或回到等待阶段，
      // 不能留下既没有 currentRound 也没有 roundSummary 的悬空状态。
      if (isCurrent()) {
        room.currentRound = previousRound;
        room.roundSummary = previousSummary;
        room.phase = "roundResult";
      }
      throw error;
    } finally {
      if (room.runtime?.automaticRoundOperation === operation) {
        roomRuntime(room).automaticRoundOperation = undefined;
        roomRuntime(room).automaticRoundLoading = false;
      }
    }
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
    return { nextRound: room.roundNumber + 1 };
  }

  /** 手动出题下一回合：轮换开启则自动指定出题人，否则回到选出题人阶段。 */
  private beginManualNextRound(room: SonGuessrRoomRecord) {
    // 全程同步没有 await：不需要任何开局锁，并发的请求不可能插进来。
    const previousSubmitterId = room.currentRound?.submitterPlayerId;
    room.currentRound = undefined;
    room.roundSummary = undefined;
    this.applyQueuedMemberships(room);
    if (!this.hasNextRoundQuorum(room)) {
      this.fallBackToWaiting(room);
      return { nextRound: room.roundNumber + 1, waiting: true };
    }
    const nextSubmitter = room.settings.autoRotateSubmitter
      ? this.nextRotatingSubmitter(room, previousSubmitterId)
      : undefined;
    // 「再来一轮」已经把界面切到下一轮：上一轮的结局不跟着进新回合。
    clearRoundMarks(room);
    // 没轮到出题人时保留原 pendingSubmitterPlayerId，只换阶段。
    if (nextSubmitter) {
      room.pendingSubmitterPlayerId = nextSubmitter.id;
      this.assignSubmitterDeadline(room);
      room.submitterPrompt = undefined;
      room.phase = "submittingSong";
    } else {
      room.phase = "choosingSubmitter";
    }
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
    return { nextRound: room.roundNumber + 1 };
  }

  finishGame(at: SongCommandAt) {
    const { room } = at;
    roomRuntime(room).automaticRoundOperation = undefined;
    roomRuntime(room).automaticRoundLoading = false;
    room.phase = "waiting";
    room.pendingSubmitterPlayerId = undefined;
    room.pendingSubmitterDeadlineAt = undefined;
    room.pendingSubmitterAssignedAt = undefined;
    room.submitterPrompt = undefined;
    room.currentRound = undefined;
    room.roundSummary = undefined;
    room.finalScores = undefined;
    clearRoundMarks(room);
    this.applyQueuedMemberships(room);
    this.resetReadyState(room);
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
    return { waiting: true, roundNumber: room.roundNumber };
  }

  /**
   * 记一次超时。队伍与 CEE 同口径：按当时在线的队员人数扣次数（不超过剩余次数），每人记一条；
   * 无人在线时（含个人掉线）仍扣一次，记在第一位队员名下，回合不会因为掉线卡住。
   */
  private recordTimeout(room: SonGuessrRoomRecord, state: SonGuessrRoundPlayerState) {
    const round = room.currentRound;
    if (!round || this.isUnitFinished(round, state)) return;
    const members = state.memberIds.filter((id) => room.players[id]);
    const online = members.filter((id) => room.players[id]!.online);
    const actors = (online.length ? online : members.slice(0, 1)).slice(
      0,
      round.settings.maxGuessesPerRound - state.guessesUsed
    );
    for (const playerId of actors) {
      const player = room.players[playerId]!;
      state.guessesUsed += 1;
      player.totalGuesses += 1;
      round.attempts.push({
        id: this.ctx.ids.next("song_guess"),
        playerId,
        playerName: player.name,
        guessNumber: state.guessesUsed,
        createdAt: this.ctx.now(),
        result: "timeout",
      });
    }
    this.restartGuessDeadline(room, state);
  }

  /** 作答单元已结束：猜中、放弃或次数用尽。 */
  private isUnitFinished(round: SonGuessrRoundRecord, state: SonGuessrRoundPlayerState) {
    return state.correct || state.gaveUp || state.guessesUsed >= round.settings.maxGuessesPerRound;
  }

  /** 猜歌、猜番共用的单元检查；队伍里的提示写「本队」，免得队友以为是自己点过。 */
  private ensureUnitOpen(
    round: SonGuessrRoundRecord,
    state: SonGuessrRoundPlayerState,
    playerId: string
  ) {
    const teamed = state.memberIds.length > 1;
    if (state.correct) {
      throw new AppError(
        "ALREADY_CORRECT",
        round.correctPlayerIds.includes(playerId) ? "你已经猜对了" : "队友已经猜中了"
      );
    }
    if (state.gaveUp)
      throw new AppError("ALREADY_GAVE_UP", teamed ? "本队已经放弃本回合" : "你已经放弃本回合");
    if (state.inFlight)
      throw new AppError(
        "GUESS_IN_PROGRESS",
        teamed ? "队友正在提交猜测，请稍候" : "正在校验上一次猜测，请稍候"
      );
    if (state.guessesUsed >= round.settings.maxGuessesPerRound) {
      throw new AppError(
        "NO_MORE_GUESSES",
        teamed ? "本队本回合猜测次数已用完" : "本回合猜测次数已用完"
      );
    }
  }

  /** 与 `submitterId` 同队的其他参与玩家；出题人个人游玩或没有出题人（自动出题）时为空。 */
  /**
   * 重开一次猜测倒计时。倒计时的锚点必须永远取「当前时刻」，且不得超过回合硬截止：
   * 用旧锚点（如本回合统一的 audioReadyDeadlineAt）续期，会得到一个可能已经过期的时刻，
   * 巡检随即把它当成一次「答题超时」——玩家的倒计时还没归零就被判超时，
   * 或者归零后要等下一轮 10 秒巡检才真正结算。
   */
  private restartGuessDeadline(room: SonGuessrRoomRecord, state: SonGuessrRoundPlayerState) {
    const round = room.currentRound;
    if (
      !round ||
      !round.settings.showGuessTimer ||
      state.correct ||
      state.gaveUp ||
      state.guessesUsed >= round.settings.maxGuessesPerRound
    ) {
      state.deadlineAt = undefined;
      return;
    }
    const deadlineAt = this.ctx.now() + round.settings.guessDurationSeconds * 1_000;
    // 单次猜测的倒计时绝不能越过回合硬截止，否则玩家的可见倒计时会长于真实剩余时间：
    // 界面显示还剩数十秒，房间却已经强制结算。
    state.deadlineAt =
      round.hardDeadlineAt === undefined ? deadlineAt : Math.min(deadlineAt, round.hardDeadlineAt);
  }

  /**
   * 给每个「本应作答」的玩家写入本轮结局标记。
   *
   * 出题人、其队友（本局观战）与旁观者不作答，因此不产生标记。
   * 结果取 `SonGuessrRoundMark` 枚举，不沿用猜猜呗的 emoji 标记串：那套是为兼容原版房
   */
  private appendRoundMarks(room: SonGuessrRoomRecord, round: SonGuessrRoundRecord): void {
    const maxGuesses = round.settings.maxGuessesPerRound;
    for (const player of Object.values(room.players)) {
      if (player.membership !== "active") continue;
      if (player.id === round.submitterPlayerId || round.observerIds.includes(player.id)) continue;
      const state = round.players[player.id];
      if (!state) continue;
      const mark: SonGuessrRoundMark = state.correct
        ? "correct"
        : state.gaveUp
          ? "gaveUp"
          : state.guessesUsed >= maxGuesses
            ? "outOfGuesses"
            : "timeout";
      player.roundMarks.push(mark);
    }
  }

  /**
   * @param skipped 房主直接跳过本回合。跳过不是「无人猜中」，
   *   而是「这一轮没有真正发生过」，因此不计出题人奖励 ——
   *   否则房主反复「选出题人 → 立刻跳过」就能零成本刷分。
   */
  private finishRound(room: SonGuessrRoomRecord, skipped = false) {
    const round = room.currentRound;
    if (!round || room.phase !== "playing") return;
    const submitter = room.players[round.submitterPlayerId];
    const scoring = this.roundScoring(room, round);
    if (submitter && !skipped) submitter.score += scoring.submitterScore;

    for (const state of Object.values(round.players)) state.deadlineAt = undefined;
    this.appendRoundMarks(room, round);
    room.roundSummary = {
      roundNumber: round.number,
      song: {
        ...publicSong(round.song),
        chorus: round.song.chorus,
        releaseYear: round.song.releaseYear,
        popularity: round.song.popularity,
        language: round.song.language,
        encyclopedia: round.song.encyclopedia,
      },
      ...(round.anime ? { anime: publicAnime(round.anime) } : {}),
      ...(round.animeTrack ? { animeTrack: round.animeTrack } : {}),
      submitterPlayerId: round.submitterPlayerId,
      correctPlayerIds: [...round.correctPlayerIds],
      attempts: [...round.attempts],
      scores: buildScores(this.ctx, room, round.startScores),
      ...(scoring.breakdown ? { breakdown: scoring.breakdown } : {}),
    };
    room.phase = "roundResult";
    this.recordRound(room, round, room.roundSummary, skipped);
    this.ctx.touch(room);
    this.ctx.log("song.game.round_finished", room.id, round.submitterPlayerId, {
      roundNumber: round.number,
      correctCount: round.correctPlayerIds.length,
    });
  }

  /** 结算快照转成对局记录：摘要放答案与出题人，时间线为逐次猜测。 */
  private recordRound(
    room: SonGuessrRoomRecord,
    round: SonGuessrRoundRecord,
    summary: SonGuessrRoundSummary,
    skipped: boolean
  ) {
    const nameOf = (playerId: string) => room.players[playerId]?.name ?? playerId;
    (this.options.gameRecorder ?? NOOP_GAME_RECORDER).record({
      game: "song",
      roomId: room.id,
      roomCreatedAt: room.createdAt,
      roundNumber: round.number,
      startedAt: round.startedAt,
      endedAt: this.ctx.now(),
      players: summary.scores.map((score) => ({
        playerId: score.playerId,
        userId: room.players[score.playerId]?.account?.userId ?? null,
        name: score.playerName,
        score: score.delta,
      })),
      summary: {
        questionType: round.settings.questionType,
        song: { id: round.song.id, title: round.song.title, artist: round.song.artist },
        ...(round.anime
          ? { anime: { id: round.anime.id, name: round.anime.name, nameCn: round.anime.nameCn } }
          : {}),
        submitter: nameOf(round.submitterPlayerId),
        correct: round.correctPlayerIds.map(nameOf),
        skipped,
        solo: room.solo,
      },
      timeline: round.attempts.map((attempt) => ({
        at: attempt.createdAt,
        type: "guess",
        name: attempt.playerName,
        result: attempt.result,
        ...(attempt.guessedSong
          ? { song: `${attempt.guessedSong.title} - ${attempt.guessedSong.artist}` }
          : {}),
        ...(attempt.guessedAnime
          ? { anime: attempt.guessedAnime.nameCn || attempt.guessedAnime.name }
          : {}),
      })),
    });
  }

  private buildFeedback(guess: SongDetails, answer: SongDetails): SongGuessFeedback {
    const answerTags = new Set(answer.encyclopedia.tags.map((tag) => tag.toLowerCase()));
    return {
      releaseYear: guess.releaseYear,
      releaseYearDirection: direction(guess.releaseYear, answer.releaseYear),
      popularity: guess.popularity,
      popularityDirection: direction(guess.popularity, answer.popularity),
      languageMatch:
        guess.language && answer.language
          ? normalizeSongText(guess.language) === normalizeSongText(answer.language)
          : undefined,
      sharedTags: guess.encyclopedia.tags.filter((tag) => answerTags.has(tag.toLowerCase())),
    };
  }

  private isCorrectSong(guess: SongDetails, round: SonGuessrRoundRecord) {
    return isSameAnswerSong(guess, round.song, round.alternateSongIds ?? []);
  }

  private applyQueuedMemberships(room: SonGuessrRoomRecord) {
    for (const player of Object.values(room.players)) {
      const membership = player.nextRoundMembership;
      if (!membership || player.membership === "kicked") continue;
      if (membership === "spectator" && !room.allowSpectators) continue;
      if (membership === "active" && !player.online) continue;
      player.nextRoundMembership = undefined;
      player.membership = membership;
      if (membership === "spectator") player.team = null;
      player.isReady = membership === "active" && (player.id === room.hostPlayerId || player.isBot);
    }
  }

  private resetReadyState(room: SonGuessrRoomRecord) {
    for (const candidate of Object.values(room.players)) {
      candidate.isReady =
        candidate.membership === "active" &&
        (candidate.id === room.hostPlayerId || candidate.isBot);
    }
  }

  private nextRotatingSubmitter(room: SonGuessrRoomRecord, previousSubmitterId?: string) {
    // 轮流也只轮到留得下猜歌玩家的人：整队出题会把队友一起带去观战。
    const eligible = new Set(submitterCandidates(this.ctx, room));
    const candidates = Object.values(room.players)
      .filter((player) => player.membership === "active" && eligible.has(player))
      .sort((left, right) => left.joinedAt - right.joinedAt);
    if (candidates.length === 0) return undefined;
    const previousIndex = candidates.findIndex((player) => player.id === previousSubmitterId);
    return candidates[(previousIndex + 1 + candidates.length) % candidates.length];
  }

  private isRoundComplete(room: SonGuessrRoomRecord) {
    const round = room.currentRound;
    if (!round) return false;
    // 关掉血战时，第一个猜中就把本局结束：其余人不再继续作答，也没有名次可争。
    if (!round.settings.bloodMode && round.correctPlayerIds.length > 0) return true;
    const guessers = activePlayers(room).filter(
      (player) =>
        (player.id !== round.submitterPlayerId ||
          canTestSubmitterGuess(this.ctx, room, player.id)) &&
        !round.observerIds.includes(player.id)
    );
    return guessers.every((player) => {
      const state = round.players[player.id];
      return !state || this.isUnitFinished(round, state);
    });
  }

  private closeRoom(room: SonGuessrRoomRecord, reason: string) {
    // 房间销毁 = 这一局结束：收尾对局记录、通知并解绑全部连接，随后清玩法旁表、删房、刷新大厅。
    dissolveRoom(this.roomKernel, room, { roomId: room.id, reason });
    room.musicPool = [];
    // 房间没了：叫醒仍在等号的请求，让它们下一轮检查直接返回无租约。
    wakeMusicPoolWaiters(this.ctx, room.id);
    this.ctx.rooms.delete(room.id);
    this.ctx.publishLobby();
  }

  /** 把连接绑到座位；内核可能在绑定时改选房主，易主后的猜歌收尾在这里统一做。 */
  private attachConnection(
    room: SonGuessrRoomRecord,
    player: SonGuessrPlayerRecord,
    connection: ConnectionRecord
  ) {
    const previousHostId = room.hostPlayerId;
    bindSeat(this.roomKernel, room, player, connection);
    this.settleHostChange(room, previousHostId);
  }

  private createPlayer(
    nameValue: string,
    host: boolean,
    isBot = false,
    seatId?: string
  ): SonGuessrPlayerRecord {
    const name = this.requireName(nameValue);
    const now = this.ctx.now();
    return {
      id: seatId ?? this.ctx.ids.next("song_player"),
      sessionToken: `${this.ctx.ids.next("song_session")}_${crypto.randomUUID()}`,
      name,
      membership: "active",
      online: true,
      isReady: host,
      score: 0,
      team: null,
      correctGuesses: 0,
      totalGuesses: 0,
      roundMarks: [],
      isBot,
      joinedAt: now,
      lastSeenAt: now,
    };
  }

  private requireActiveRound(room: SonGuessrRoomRecord) {
    if (room.phase !== "playing" || !room.currentRound) {
      throw new AppError("NO_ACTIVE_ROUND", "当前没有进行中的回合");
    }
    return room.currentRound;
  }

  private ensureConnectionFree(connection: ConnectionRecord) {
    if (!connection.roomId && !connection.playerId) return;
    if (connection.roomId && connection.playerId && this.ctx.rooms.has(connection.roomId)) {
      this.detachFromRoom(connection);
      return;
    }
    // 房间已经不存在（或只有一半字段有值）时，requireRoomPlayer 会抛 ROOM_NOT_FOUND
    // 并把正常的 create / join / reconnect 一起打断；这种残余状态退回原来的置空即可。
    this.ctx.connections.detach(connection);
  }

  private ensureAgentsAllowed(room: SonGuessrRoomRecord, connection: ConnectionRecord) {
    if (connection.isAgent === true && room.settings.allowAgents !== true) {
      throw new AppError("AGENTS_NOT_ALLOWED", "房主已禁止 Agent 进入");
    }
  }

  /** 这张标签页要交给 Agent：它坐着的房间必须开着 MCP，否则其他玩家的知情就被绕过了。 */
  assertTabAgentsAllowed(tabKey: string): void {
    assertTabAgentsAllowed(this.roomKernel, tabKey);
  }

  /** 接管开始或结束：同房玩家要立刻看到座位上的 MCP 徽标变化。 */
  publishTabRooms(tabKey: string): void {
    for (const room of roomsOfTab(this.roomKernel, tabKey)) this.ctx.publishRoom(room);
  }

  private requireName(value: string) {
    const normalized = normalizeName(value).slice(0, 20);
    if (!normalized) throw new AppError("INVALID_NAME", "用户名不能为空");
    assertTextAllowed(normalized);
    return normalized;
  }

  /**
   * 房主易主后的猜歌收尾：新房主恒为已准备；开局加载在途时作废那次开局的操作，
   * 它回来复核会发现自己已不是当前操作。登录锁按「人 + 平台」记账，与房主身份无关，不碰。
   */
  private settleHostChange(room: SonGuessrRoomRecord, previousHostId: string) {
    if (room.hostPlayerId === previousHostId) return;
    const host = room.players[room.hostPlayerId];
    if (!host) return;
    roomRuntime(room).automaticRoundOperation = undefined;
    roomRuntime(room).automaticRoundLoading = false;
    host.isReady = true;
  }

  /** 房主被移除（离开、被踢、被清理）后按内核规则改选；没有在线真人时房主待选。 */
  private reassignRemovedHost(room: SonGuessrRoomRecord) {
    const previousHostId = room.hostPlayerId;
    reassignHost(room, Object.values(room.players));
    this.settleHostChange(room, previousHostId);
  }

  /** 巡检每跳调用：房主空缺或离线宽限已过时改选，选不到就保持现状、下一跳再试。 */
  private resolveHost(room: SonGuessrRoomRecord, currentTime: number) {
    const previousHostId = room.hostPlayerId;
    const { changed } = resolveHostGrace(room, Object.values(room.players), currentTime);
    if (!changed) return;
    this.settleHostChange(room, previousHostId);
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
  }
}
