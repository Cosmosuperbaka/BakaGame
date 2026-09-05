import {
  BOT_NAME_SUFFIXES,
  CHAT_LIMIT,
  HOST_RECONNECT_TIMEOUT_MS,
  PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS,
  ROOM_EMPTY_GRACE_PERIOD_MS,
  ROOM_IDLE_TIMEOUT_MS,
} from "../config/Constants";
import { AppError } from "../domain/Errors";
import { ensureRoomId, normalizeName, normalizeWord, type RandomSource } from "../domain/Rules";
import { ROOM_ID_TEST_MODE, type ConnectionRecord, type RoomVisibility } from "../domain/Model";
import { describeError, type EventLogger } from "../infrastructure/EventLogger";
import type {
  MusicLoginSession,
  MusicProvider,
} from "../infrastructure/NeteaseMusicProvider";
import { MAX_SONGUESSR_COOKIE_LENGTH, SONGUESSR_MAX_PLAYERS } from "../shared/Index";
import type {
  ChatMessage,
  SongDetails,
  SongGuessAttempt,
  SongGuessDirection,
  SongGuessFeedback,
  SonGuessrClientMessage,
  SonGuessrPhase,
  SonGuessrPlayerView,
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
  SonGuessrRoomSummary,
  SonGuessrRoundSummary,
  SonGuessrScore,
  SonGuessrSettings,
  SongAutoFilters,
  SongSearchResult,
  SongLyricClip,
} from "../shared/Index";
import { createEvent } from "../transport/Packets";
import { ConnectionRegistry } from "./ConnectionRegistry";

const DEFAULT_SETTINGS: SonGuessrSettings = {
  questionType: "song",
  questionMode: "manual",
  autoRotateSubmitter: false,
  autoFilters: { artists: [], minPopularity: 0 },
  lyricsLineCount: 5,
  showLyrics: true,
  bloodMode: false,
  maxGuessesPerRound: 3,
  guessDurationSeconds: 60,
  showGuessTimer: true,
};

/** 未配置歌单或歌手时使用网易云热歌榜作为默认题库。 */
const DEFAULT_AUTO_PLAYLIST_ID = "3778678";

const SCORING = {
  correct: 1,
  submitterPerCorrect: 3,
  submitterNobodyCorrect: 5,
} as const;

interface SongGuessrPlayerRecord {
  id: string;
  sessionToken: string;
  name: string;
  membership: "active" | "spectator" | "kicked";
  nextRoundMembership?: "active" | "spectator";
  online: boolean;
  isReady: boolean;
  score: number;
  correctGuesses: number;
  totalGuesses: number;
  isBot: boolean;
  joinedAt: number;
  lastSeenAt: number;
  connectionId?: string;
}

interface SongGuessrRoundPlayerState {
  audioReady: boolean;
  guessesUsed: number;
  correct: boolean;
  gaveUp: boolean;
  deadlineAt?: number;
  inFlight?: boolean;
}

interface SongGuessrRoundRecord {
  number: number;
  submitterPlayerId: string;
  song: SongDetails;
  lyricClip: SongLyricClip;
  attempts: SongGuessAttempt[];
  correctPlayerIds: string[];
  startScores: Record<string, number>;
  players: Record<string, SongGuessrRoundPlayerState>;
  settings: SonGuessrSettings;
  audioReadyDeadlineAt?: number;
  hardDeadlineAt?: number;
}

interface SongGuessrRoomRecord {
  id: string;
  name: string;
  visibility: RoomVisibility;
  password?: string;
  allowSpectators: boolean;
  hostPlayerId: string;
  settings: SonGuessrSettings;
  phase: SonGuessrPhase;
  roundNumber: number;
  pendingSubmitterPlayerId?: string;
  currentRound?: SongGuessrRoundRecord;
  roundSummary?: SonGuessrRoundSummary;
  finalScores?: SonGuessrScore[];
  musicSession?: {
    ownerPlayerId: string;
    cookie: string;
    account: MusicLoginSession["account"];
  };
  players: Record<string, SongGuessrPlayerRecord>;
  chat: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  emptySinceAt?: number;
  automaticRoundLoading?: boolean;
  manualRoundStarting?: boolean;
  hostReconnectDeadlineAt?: number;
}

export interface SonGuessrServiceOptions {
  musicProvider: MusicProvider;
  now?: () => number;
  random?: RandomSource;
  eventLogger?: EventLogger;
}

const clampInt = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, Math.round(value)));

const cloneSettings = (settings: SonGuessrSettings): SonGuessrSettings => ({
  ...settings,
  autoFilters: {
    ...settings.autoFilters,
    playlist: settings.autoFilters.playlist ? { ...settings.autoFilters.playlist } : undefined,
    artists: settings.autoFilters.artists.map((artist) => ({ ...artist })),
  },
});

const normalizeSongText = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_'"“”‘’·.，,。!！?？()（）[\]【】]/g, "");

const VERSION_MARKER_PATTERN = /(?:伴奏|纯音乐|电视尺寸|动画剪辑|\b(?:inst(?:rumental)?\.?|off\s*vocal|karaoke|tv\s*size|anime\s*edit|radio\s*edit|ver(?:sion)?\.?|version|mix|edit|remaster(?:ed)?|live|acoustic|demo|cover|remix|feat(?:uring)?\.?)\b)/iu;
const BRACKETED_VERSION_PATTERN = /\s*[（(【[]\s*([^）)】\]]*)\s*[）)】\]]/gu;
const DECORATED_VERSION_SUFFIX_PATTERN = /\s*[-~～–—]+\s*(.*?)\s*(?:[-~～–—]+\s*)?$/u;
const BARE_VERSION_SUFFIX_PATTERN = /\s+(?:inst(?:rumental)?\.?|off\s*vocal|karaoke|伴奏|纯音乐|电视尺寸|动画剪辑|tv\s*size|anime\s*edit|radio\s*edit|remix|(?:[^\s]+\s+)?ver(?:sion)?\.?)\s*$/iu;
const FEAT_SUFFIX_PATTERN = /\s*(?:[（(【[]\s*)?feat(?:uring)?\.?\s*[^）)】\]]+[）)】\]]?\s*$/iu;

const stripSongVersionInfo = (value: string) => {
  let result = value.replace(
    BRACKETED_VERSION_PATTERN,
    (match, metadata: string) => VERSION_MARKER_PATTERN.test(metadata) ? "" : match,
  );

  while (true) {
    const next = result
      .replace(
        DECORATED_VERSION_SUFFIX_PATTERN,
        (match, metadata: string) => VERSION_MARKER_PATTERN.test(metadata) ? "" : match,
      )
      .replace(BARE_VERSION_SUFFIX_PATTERN, "")
      .replace(FEAT_SUFFIX_PATTERN, "");
    if (next === result) return result;
    result = next;
  }
};

const normalizeSongTitle = (value: string) =>
  normalizeSongText(stripSongVersionInfo(value));

const normalizedArtists = (value: string) =>
  new Set(
    value
      .split(/\s*(?:,|，|、|&|＆|\/|／|;|；|\bx\b|\bfeat(?:uring)?\.?\b|\bwith\b)\s*/iu)
      .map(normalizeSongText)
      .filter(Boolean),
  );

const FALLBACK_CLIP_SECONDS_PER_LINE = 6;
const MAX_LYRIC_LINE_DURATION_MS = 12_000;
const AUTO_POPULARITY_LOOKUP_LIMIT = 24;

const direction = (guess?: number, answer?: number): SongGuessDirection => {
  if (guess === undefined || answer === undefined) return "unknown";
  if (guess === answer) return "equal";
  return guess < answer ? "higher" : "lower";
};

export const createSongLyricClip = (
  lyrics: SongDetails["lyrics"],
  lineCount: number,
  random: RandomSource,
  durationMs?: number,
): SongLyricClip => {
  const safeCount = clampInt(lineCount, 1, 10);
  const windows = lyrics.length >= safeCount
    ? Array.from({ length: lyrics.length - safeCount + 1 }, (_, startIndex) =>
      lyrics.slice(startIndex, startIndex + safeCount))
        .filter((lines) => lines.every((line) =>
          line.endTime > line.time && line.endTime - line.time <= MAX_LYRIC_LINE_DURATION_MS))
    : [];

  if (windows.length > 0) {
    const padded = windows.length >= 5 ? windows.slice(2, -2) : windows;
    const candidates = padded.length > 0 ? padded : windows;
    const lines = candidates[random.nextInt(candidates.length)];
    return {
      startTime: lines[0].time,
      endTime: Math.max(lines[0].time, lines.at(-1)!.endTime - 250),
      lines,
    };
  }

  const clipDuration = safeCount * FALLBACK_CLIP_SECONDS_PER_LINE * 1_000;
  const songDuration = Math.max(1, durationMs ?? clipDuration);
  const actualClipDuration = Math.min(clipDuration, songDuration);
  const latestStart = Math.max(0, songDuration - actualClipDuration);
  const startTime = random.nextInt(latestStart + 1);

  return {
    startTime,
    endTime: startTime + actualClipDuration,
    lines: [],
  };
};

export class SonGuessrService {
  private readonly rooms = new Map<string, SongGuessrRoomRecord>();
  private readonly connections = new ConnectionRegistry();
  private readonly now: () => number;
  private readonly random: RandomSource;
  private idCounter = 0;

  constructor(private readonly options: SonGuessrServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? {
      nextInt: (maxExclusive) => Math.floor(Math.random() * Math.max(1, maxExclusive)),
    };
  }

  registerConnection(connection: ConnectionRecord): void {
    this.connections.registerConnection(connection);
  }

  getHealthSnapshot() {
    return {
      roomCount: this.rooms.size,
      connectionCount: this.connections.stats.totalConnections,
      onlinePlayerCount: [...this.rooms.values()].reduce(
        (sum, room) => sum + this.onlineCount(room),
        0,
      ),
    };
  }

  notifyShutdown(): void {
    this.connections.broadcastToAll(
      createEvent("server.shutdown", {
        message: "服务器即将关闭，请稍后重新连接",
      }),
    );
  }

  async unregisterConnection(connectionId: string): Promise<void> {
    const connection = this.connections.unregisterConnection(connectionId);
    if (!connection?.roomId || !connection.playerId) return;
    const room = this.rooms.get(connection.roomId);
    const player = room?.players[connection.playerId];
    if (!room || !player) return;

    player.online = false;
    player.connectionId = undefined;
    player.lastSeenAt = this.now();
    connection.roomId = undefined;
    connection.playerId = undefined;

    if (this.onlineCount(room) === 0 && !this.isTestRoom(room)) {
      room.emptySinceAt ??= this.now();
    }

    // 0分数的旁观者掉线立即移除
    if (
      player.membership === "spectator" &&
      player.score === 0 &&
      !player.isBot &&
      room.hostPlayerId !== player.id
    ) {
      delete room.players[player.id];
    }

    // 断线不是显式离开：保留房主身份和房间音乐会话，给移动端后台重连留出时间。
    if (room.hostPlayerId === player.id && !this.isTestRoom(room)) {
      room.hostReconnectDeadlineAt = this.now() + HOST_RECONNECT_TIMEOUT_MS;
    }
    if (room.phase === "submittingSong" && room.pendingSubmitterPlayerId === player.id) {
      room.pendingSubmitterPlayerId = undefined;
      room.phase = "choosingSubmitter";
    }

    // 普通断线可能只是刷新或切到后台，不能因此把仍在进行的回合提前结算。
    // 显式离开和踢出会移除正式席位，并在各自路径重新检查回合完成状态。
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    this.log("song.player.disconnected", room.id, player.id);
  }

  async execute(connectionId: string, message: SonGuessrClientMessage): Promise<unknown> {
    const connection = this.connections.getConnection(connectionId);

    switch (message.type) {
      case "song.lobby.subscribeRooms":
        connection.lobbySubscribed = true;
        this.publishLobby();
        return { subscribed: true };
      case "song.room.create":
        return this.createRoom(connection, message.payload);
      case "song.room.join":
        return this.joinRoom(connection, message.roomId, message.payload);
      case "song.room.reconnect":
        return this.reconnectRoom(connection, message.payload.roomId, message.payload.sessionToken);
      case "song.room.leave":
        return this.leaveRoom(connection);
      case "song.room.requestSync":
        return this.requestSync(connection);
      case "song.player.setReady":
        return this.setReady(connection, message.payload.ready);
      case "song.player.setSpectator":
        return this.setSpectator(connection, message.payload.spectator);
      case "song.room.updateSettings":
        return this.updateSettings(connection, message.payload);
      case "song.room.kick":
        return this.kick(connection, message.payload.playerId);
      case "song.room.transferHost":
        return this.transferHost(connection, message.payload.playerId);
      case "song.chat.send":
        return this.sendChat(connection, message.payload.text);
      case "song.auth.qr.create":
        return this.createMusicQrLogin(connection);
      case "song.auth.qr.check":
        return this.checkMusicQrLogin(connection, message.payload.key);
      case "song.auth.useCookie":
        return this.useMusicCookie(connection, message.payload.cookie);
      case "song.auth.clear":
        return this.clearMusicAccount(connection);
      case "song.music.search":
        return this.searchMusic(connection, message.payload.keyword);
      case "song.music.playlist.resolve":
        return this.resolvePlaylist(connection, message.payload.value);
      case "song.music.artist.search":
        return this.searchArtists(connection, message.payload.keyword);
      case "song.game.start":
        return this.startGame(connection);
      case "song.game.chooseSubmitter":
        return this.chooseSubmitter(connection, message.payload.playerId);
      case "song.game.submitSong":
        return this.submitSong(connection, message.payload.songId);
      case "song.game.audioReady":
        return this.audioReady(connection, message.payload.roundNumber);
      case "song.game.guess":
        return this.guess(connection, message.payload.songId);
      case "song.game.giveUp":
        return this.giveUp(connection);
      case "song.game.skipRound":
        return this.skipRound(connection);
      case "song.game.nextRound":
        return this.nextRound(connection);
      case "song.game.finish":
        return this.finishGame(connection);
      case "song.test.addBot":
        return this.addBots(connection, message.payload.count);
      case "song.test.removeBot":
        return this.removeBots(connection, message.payload.count);
    }
  }

  async runHousekeeping(): Promise<void> {
    const currentTime = this.now();
    for (const room of [...this.rooms.values()]) {
      if (this.isTestRoom(room)) continue;
      if (this.onlineCount(room) === 0 || currentTime - room.lastActivityAt >= ROOM_IDLE_TIMEOUT_MS) {
        if (this.onlineCount(room) === 0) {
          room.emptySinceAt ??= currentTime;
          if (currentTime - room.emptySinceAt < ROOM_EMPTY_GRACE_PERIOD_MS) {
            this.publishRoomCalibration(room);
            continue;
          }
        }
        this.closeRoom(room, this.onlineCount(room) === 0 ? "empty" : "idle_timeout");
        continue;
      }
      room.emptySinceAt = undefined;

      // 清理掉线超过3分钟的玩家
      for (const player of Object.values(room.players)) {
        if (
          !player.online &&
          !player.isBot &&
          currentTime - player.lastSeenAt >= PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS
        ) {
          delete room.players[player.id];
          if (room.hostPlayerId === player.id) {
            this.reassignHost(room);
          }
          this.touch(room);
          if (this.onlineCount(room) === 0 && !this.isTestRoom(room)) {
            this.closeRoom(room, "empty");
          } else {
            this.publishRoom(room);
            this.publishLobby();
          }
        }
      }

      if (
        room.hostReconnectDeadlineAt !== undefined &&
        currentTime >= room.hostReconnectDeadlineAt
      ) {
        this.transferHostAfterDisconnect(room);
      }

      if (room.phase === "playing" && room.currentRound) {
        let changed = false;
        const round = room.currentRound;
        const isRoundHardExpired =
          round.hardDeadlineAt !== undefined && currentTime >= round.hardDeadlineAt;

        for (const [playerId, state] of Object.entries(round.players)) {
          if (
            playerId === round.submitterPlayerId &&
            !this.canTestSubmitterGuess(room, playerId)
          ) {
            continue;
          }
          if (
            state.correct ||
            state.gaveUp ||
            state.guessesUsed >= round.settings.maxGuessesPerRound
          ) {
            continue;
          }

          const isAudioReadyTimeout =
            !state.audioReady &&
            round.audioReadyDeadlineAt !== undefined &&
            currentTime >= round.audioReadyDeadlineAt;
          const isGuessTimeout =
            state.deadlineAt !== undefined && state.deadlineAt <= currentTime;

          if (isAudioReadyTimeout && !state.audioReady) {
            state.audioReady = true;
          }

          if (isGuessTimeout || isAudioReadyTimeout || isRoundHardExpired) {
            this.recordTimeout(room, playerId);
            changed = true;
          }
        }

        if (changed || isRoundHardExpired) {
          if (this.isRoundComplete(room) || isRoundHardExpired) this.finishRound(room);
          this.publishRoom(room);
        }
      }

      this.publishRoomCalibration(room);
    }
  }

  getRoomSummaries(): SonGuessrRoomSummary[] {
    return [...this.rooms.values()]
      .filter((room) => !this.isTestRoom(room))
      .map((room) => this.buildRoomSummary(room))
      .sort((left, right) => left.roomId.localeCompare(right.roomId));
  }

  private createRoom(
    connection: ConnectionRecord,
    payload: Extract<SonGuessrClientMessage, { type: "song.room.create" }>["payload"],
  ) {
    this.ensureConnectionFree(connection);
    const roomId = ensureRoomId(payload.roomId);
    if (this.rooms.has(roomId)) throw new AppError("ROOM_EXISTS", "房间号已被使用");

    const player = this.createPlayer(payload.userName, true);
    const now = this.now();
    const room: SongGuessrRoomRecord = {
      id: roomId,
      name: normalizeWord(payload.name),
      visibility: payload.visibility,
      password: payload.visibility === "private" ? this.requirePassword(payload.password) : undefined,
      allowSpectators: payload.allowSpectators,
      hostPlayerId: player.id,
      settings: cloneSettings(DEFAULT_SETTINGS),
      phase: "waiting",
      roundNumber: 0,
      players: { [player.id]: player },
      chat: [],
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    };

    this.rooms.set(roomId, room);
    this.attachConnection(room, player, connection);
    this.appendSystemMessage(room, `${player.name} 创建了房间`);
    this.publishRoom(room);
    this.publishLobby();
    this.log("song.room.created", room.id, player.id);
    return {
      roomId,
      playerId: player.id,
      sessionToken: player.sessionToken,
      snapshot: this.buildRoomSnapshot(room),
      privateState: this.buildPrivateState(room, player),
    };
  }

  private joinRoom(
    connection: ConnectionRecord,
    roomIdValue: string | undefined,
    payload: Extract<SonGuessrClientMessage, { type: "song.room.join" }>["payload"],
  ) {
    this.ensureConnectionFree(connection);
    const room = this.getRoom(ensureRoomId(roomIdValue ?? ""));
    this.ensurePassword(room, payload.password);
    if (this.onlineCount(room) >= SONGUESSR_MAX_PLAYERS) {
      throw new AppError("ROOM_FULL", `房间最多容纳 ${SONGUESSR_MAX_PLAYERS} 人`);
    }
    const name = this.requireName(payload.userName);
    if (Object.values(room.players).some((player) => player.name === name && player.membership !== "kicked")) {
      throw new AppError("NAME_CONFLICT", "该用户名已在房间中");
    }

    const membership = room.phase === "waiting" ? "active" : "spectator";
    if (membership === "spectator" && !room.allowSpectators) {
      throw new AppError("SPECTATORS_DISABLED", "当前房间不允许旁观");
    }

    const player = this.createPlayer(name, false);
    player.membership = membership;
    room.players[player.id] = player;
    const currentHost = room.players[room.hostPlayerId];
    const hostGraceExpired = room.hostReconnectDeadlineAt === undefined ||
      this.now() >= room.hostReconnectDeadlineAt;
    if (
      !currentHost ||
      currentHost.isBot ||
      currentHost.membership === "kicked" ||
      (!currentHost.online && (this.isTestRoom(room) || hostGraceExpired))
    ) {
      room.hostPlayerId = player.id;
      room.hostReconnectDeadlineAt = undefined;
      if (room.musicSession) room.musicSession.ownerPlayerId = player.id;
      player.isReady = true;
    }
    this.attachConnection(room, player, connection);
    if (room.hostPlayerId === player.id) room.hostReconnectDeadlineAt = undefined;
    this.touch(room);
    this.appendSystemMessage(room, `${player.name} 加入了房间`);
    this.publishRoom(room);
    this.publishLobby();
    this.log("song.room.joined", room.id, player.id);
    return {
      roomId: room.id,
      playerId: player.id,
      sessionToken: player.sessionToken,
      snapshot: this.buildRoomSnapshot(room),
      privateState: this.buildPrivateState(room, player),
    };
  }

  private async reconnectRoom(connection: ConnectionRecord, roomIdValue: string, token: string) {
    this.ensureConnectionFree(connection);
    const room = this.getRoom(ensureRoomId(roomIdValue));
    const player = Object.values(room.players).find(
      (candidate) => candidate.sessionToken === token && candidate.membership !== "kicked",
    );
    if (!player) throw new AppError("SESSION_INVALID", "会话令牌无效");

    this.attachConnection(room, player, connection);
    room.emptySinceAt = undefined;
    if (room.hostPlayerId === player.id) room.hostReconnectDeadlineAt = undefined;

    // 网易云播放地址可能带有效期。刷新页面后重新取一次当前回合地址，
    // 只替换 URL，不改动已经固定的答案、歌词片段和回合状态。
    const activeRound = room.phase === "playing" ? room.currentRound : undefined;
    if (activeRound) {
      try {
        const refreshedSong = await this.options.musicProvider.getSong(
          activeRound.song.id,
          room.musicSession?.cookie,
        );
        if (room.phase === "playing" && room.currentRound === activeRound) {
          activeRound.song.audioUrl = refreshedSong.audioUrl;
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
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return {
      roomId: room.id,
      playerId: player.id,
      sessionToken: player.sessionToken,
      snapshot: this.buildRoomSnapshot(room),
      privateState: this.buildPrivateState(room, player),
    };
  }

  private leaveRoom(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    // 显式离开代表账号主动退出，只有此时销毁其房间级音乐会话；网络断线由宽限期处理。
    this.clearMusicSession(room, player.id);
    delete room.players[player.id];
    connection.roomId = undefined;
    connection.playerId = undefined;

    if (Object.keys(room.players).length === 0 && !this.isTestRoom(room)) {
      this.closeRoom(room, "empty");
      return { left: true, roomClosed: true };
    }

    if (room.hostPlayerId === player.id) {
      room.hostPlayerId = "";
      room.hostReconnectDeadlineAt = undefined;
      this.reassignHost(room);
    }
    if (room.phase === "submittingSong" && room.pendingSubmitterPlayerId === player.id) {
      room.pendingSubmitterPlayerId = undefined;
      room.phase = "choosingSubmitter";
    }
    if (room.phase === "playing" && this.isRoundComplete(room)) this.finishRound(room);

    this.touch(room);
    this.appendSystemMessage(room, `${player.name} 离开了房间`);
    this.publishRoom(room);
    this.publishLobby();
    return { left: true, roomClosed: false };
  }

  private requestSync(connection: ConnectionRecord) {
    const { room } = this.requireRoomPlayer(connection);
    connection.resetStateSync?.();
    this.publishRoom(room, connection);
    return { synced: true };
  }

  private setReady(connection: ConnectionRecord, ready: boolean) {
    const { room, player } = this.requireRoomPlayer(connection);
    if (room.phase !== "waiting") throw new AppError("INVALID_PHASE", "只能在等待阶段准备");
    if (player.membership !== "active") throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能准备");
    player.isReady = player.id === room.hostPlayerId ? true : ready;
    this.touch(room);
    this.publishRoom(room);
    return { ready: player.isReady };
  }

  private setSpectator(connection: ConnectionRecord, spectator: boolean) {
    const { room, player } = this.requireRoomPlayer(connection);
    if (room.phase !== "waiting") {
      const targetMembership = spectator ? "spectator" : "active";
      if (targetMembership === "spectator" && !room.allowSpectators) {
        throw new AppError("SPECTATORS_DISABLED", "当前房间不允许旁观");
      }
      // 再次点击同个预约选项时撤销预约
      if (player.nextRoundMembership === targetMembership) {
        player.nextRoundMembership = undefined;
        this.touch(room);
        this.publishRoom(room);
        return { spectator: player.membership === "spectator", queued: false };
      }
      player.nextRoundMembership = targetMembership;
      this.touch(room);
      this.publishRoom(room);
      return { spectator, queued: true };
    }
    const nextMembership = spectator ? "spectator" : "active";
    player.nextRoundMembership = undefined;
    if (player.membership === nextMembership) return { spectator, queued: false };
    if (spectator) {
      if (!room.allowSpectators) throw new AppError("SPECTATORS_DISABLED", "当前房间不允许旁观");
      player.membership = "spectator";
      player.isReady = false;
    } else {
      player.membership = "active";
      player.isReady = player.id === room.hostPlayerId;
    }
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return { spectator, queued: false };
  }

  private updateSettings(
    connection: ConnectionRecord,
    payload: Extract<SonGuessrClientMessage, { type: "song.room.updateSettings" }>["payload"],
  ) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (room.phase !== "waiting") {
      throw new AppError("INVALID_PHASE", "只能在等待阶段修改房间设置");
    }
    if (payload.name !== undefined) room.name = normalizeWord(payload.name) || room.name;
    if (payload.visibility !== undefined) room.visibility = payload.visibility;
    if (payload.allowSpectators !== undefined) room.allowSpectators = payload.allowSpectators;
    if (payload.visibility === "public") room.password = undefined;
    if (room.visibility === "private" && payload.password !== undefined) {
      room.password = payload.password.trim() ? payload.password.trim() : room.password;
    }
    if (room.visibility === "private" && !room.password) {
      throw new AppError("PASSWORD_REQUIRED", "私密房间需要密码");
    }

    if (payload.questionType !== undefined) {
      if (payload.questionType === "anime") {
        throw new AppError("FEATURE_NOT_AVAILABLE", "听歌识番即将推出");
      }
      room.settings.questionType = payload.questionType;
    }
    if (payload.questionMode !== undefined) {
      room.settings.questionMode = payload.questionMode;
    }
    if (payload.autoRotateSubmitter !== undefined) {
      room.settings.autoRotateSubmitter = payload.autoRotateSubmitter;
    }
    if (payload.autoFilters !== undefined) {
      room.settings.autoFilters = this.normalizeAutoFilters(payload.autoFilters);
    }

    if (payload.lyricsLineCount !== undefined) {
      room.settings.lyricsLineCount = clampInt(payload.lyricsLineCount, 1, 10);
    }
    if (payload.showLyrics !== undefined) {
      room.settings.showLyrics = payload.showLyrics;
    }
    if (payload.maxGuessesPerRound !== undefined) {
      room.settings.maxGuessesPerRound = clampInt(payload.maxGuessesPerRound, 1, 10);
    }
    if (payload.guessDurationSeconds !== undefined) {
      room.settings.guessDurationSeconds = clampInt(payload.guessDurationSeconds, 10, 180);
    }
    if (payload.showGuessTimer !== undefined) {
      room.settings.showGuessTimer = payload.showGuessTimer;
    }
    if (payload.bloodMode !== undefined) {
      room.settings.bloodMode = payload.bloodMode;
    }

    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return { settings: room.settings };
  }

  private async searchMusic(connection: ConnectionRecord, keyword: string) {
    const { room } = this.requireRoomPlayer(connection);
    return {
      results: await this.options.musicProvider.search(
        keyword,
        undefined,
        room.musicSession?.cookie,
      ),
    };
  }

  private async resolvePlaylist(connection: ConnectionRecord, value: string) {
    const { room } = this.requireRoomPlayer(connection);
    const playlistId = this.parsePlaylistId(value);
    const resolve = this.options.musicProvider.getPlaylistSongs;
    if (!resolve) throw new AppError("MUSIC_API_UNAVAILABLE", "当前音乐 API 不支持读取歌单");
    const result = await resolve.call(this.options.musicProvider, playlistId, room.musicSession?.cookie);
    return { playlist: result.info };
  }

  private async searchArtists(connection: ConnectionRecord, keyword: string) {
    const { room } = this.requireRoomPlayer(connection);
    const search = this.options.musicProvider.searchArtists;
    if (!search) throw new AppError("MUSIC_API_UNAVAILABLE", "当前音乐 API 不支持搜索歌手");
    return {
      results: await search.call(this.options.musicProvider, keyword, 20, room.musicSession?.cookie),
    };
  }

  private parsePlaylistId(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new AppError("INVALID_PLAYLIST", "请输入网易云歌单链接或数字 ID");
    if (/^\d+$/.test(trimmed)) return trimmed;

    try {
      const url = new URL(trimmed);
      // 1. 常规 Query 参数: ?id=123
      const queryId = url.searchParams.get("id");
      if (queryId && /^\d+$/.test(queryId)) return queryId;

      // 2. SPA Hash 路由参数: #/playlist?id=123
      if (url.hash.includes("?")) {
        const hashQuery = url.hash.slice(url.hash.indexOf("?") + 1);
        const hashParams = new URLSearchParams(hashQuery);
        const hashId = hashParams.get("id");
        if (hashId && /^\d+$/.test(hashId)) return hashId;
      }

      // 3. 路径格式: /playlist/123
      const pathMatch = url.pathname.match(/\/playlist\/(\d+)/i);
      if (pathMatch?.[1]) return pathMatch[1];
    } catch {
      // 针对缺少协议的前缀 (如 music.163.com/playlist?id=123) 补全后解析
      if (trimmed.includes("/")) {
        try {
          const fallbackUrl = new URL(`https://${trimmed.replace(/^\/+/, "")}`);
          const queryId = fallbackUrl.searchParams.get("id");
          if (queryId && /^\d+$/.test(queryId)) return queryId;
          const pathMatch = fallbackUrl.pathname.match(/\/playlist\/(\d+)/i);
          if (pathMatch?.[1]) return pathMatch[1];
        } catch {
          // 忽略
        }
      }
    }

    throw new AppError("INVALID_PLAYLIST", "请输入网易云歌单链接或数字 ID");
  }

  private normalizeAutoFilters(filters: SongAutoFilters): SongAutoFilters {
    const playlist = filters.playlist
      ? {
          id: this.parsePlaylistId(filters.playlist.id),
          name: filters.playlist.name?.trim().slice(0, 120),
          songCount: filters.playlist.songCount,
        }
      : undefined;
    const artists = filters.artists
      .slice(0, 20)
      .map((artist) => ({ id: artist.id.trim().slice(0, 64), name: normalizeWord(artist.name).slice(0, 80) }))
      .filter((artist) => artist.id && artist.name);
    const minPopularity = [0, 1_000, 10_000, 100_000].includes(filters.minPopularity)
      ? filters.minPopularity
      : 0;
    return { playlist, artists, minPopularity };
  }

  private kick(connection: ConnectionRecord, targetPlayerId: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (targetPlayerId === player.id) throw new AppError("INVALID_TARGET", "房主不能踢出自己");
    const target = room.players[targetPlayerId];
    if (!target || target.membership === "kicked") throw new AppError("PLAYER_NOT_FOUND", "玩家不存在");

    this.clearMusicSession(room, target.id);
    target.membership = "kicked";
    target.online = false;
    const targetConnection = this.connections.findConnectionByPlayer(room.id, target.id);
    if (targetConnection) {
      (targetConnection.sendPacket ?? targetConnection.send)(
        createEvent("song.room.kicked", { roomId: room.id }),
      );
      targetConnection.roomId = undefined;
      targetConnection.playerId = undefined;
      targetConnection.close(4003, "kicked");
    }

    if (room.pendingSubmitterPlayerId === target.id) {
      room.pendingSubmitterPlayerId = undefined;
      room.phase = "choosingSubmitter";
    }
    if (room.phase === "playing" && this.isRoundComplete(room)) this.finishRound(room);
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return { kicked: true };
  }

  private transferHost(connection: ConnectionRecord, targetPlayerId: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    const target = room.players[targetPlayerId];
    if (!target || !target.online || target.membership !== "active") {
      throw new AppError("INVALID_TARGET", "只能转让给在线正式玩家");
    }
    room.hostPlayerId = target.id;
    room.hostReconnectDeadlineAt = undefined;
    if (room.musicSession) room.musicSession.ownerPlayerId = target.id;
    target.isReady = true;
    this.touch(room);
    this.publishRoom(room);
    return { hostPlayerId: target.id };
  }

  private sendChat(connection: ConnectionRecord, rawText: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    const text = normalizeWord(rawText).slice(0, 200);
    if (!text) throw new AppError("INVALID_MESSAGE", "消息不能为空");
    const message: ChatMessage = {
      id: this.createId("song_chat"),
      playerId: player.id,
      playerName: player.name,
      text,
      createdAt: this.now(),
      system: false,
    };
    room.chat = [...room.chat, message].slice(-CHAT_LIMIT);
    this.touch(room);
    this.publishRoom(room);
    return { sent: true };
  }

  private async createMusicQrLogin(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    const createQrLogin = this.options.musicProvider.createQrLogin;
    if (!createQrLogin) throw new AppError("MUSIC_AUTH_UNAVAILABLE", "音乐登录功能不可用");
    return createQrLogin.call(this.options.musicProvider);
  }

  private async checkMusicQrLogin(connection: ConnectionRecord, keyValue: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    const key = keyValue.trim();
    if (!key || key.length > 256) throw new AppError("INVALID_LOGIN", "二维码登录密钥无效");
    const checkQrLogin = this.options.musicProvider.checkQrLogin;
    if (!checkQrLogin) throw new AppError("MUSIC_AUTH_UNAVAILABLE", "音乐登录功能不可用");
    const result = await checkQrLogin.call(this.options.musicProvider, key);
    if (result.status !== "authorized" || !result.session) {
      return { status: result.status, message: result.message };
    }
    const session = this.installMusicSession(room, player.id, result.session);
    this.touch(room);
    this.publishRoom(room);
    return {
      status: result.status,
      message: result.message,
      cookie: session.cookie,
      account: session.account,
    };
  }

  private async useMusicCookie(connection: ConnectionRecord, cookieValue: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    const cookie = this.requireMusicCookie(cookieValue);
    const getLoginStatus = this.options.musicProvider.getLoginStatus;
    if (!getLoginStatus) throw new AppError("MUSIC_AUTH_UNAVAILABLE", "音乐登录功能不可用");
    const result = await getLoginStatus.call(this.options.musicProvider, cookie);
    const session = this.installMusicSession(room, player.id, result);
    this.touch(room);
    this.publishRoom(room);
    return { account: session.account };
  }

  private clearMusicAccount(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    this.clearMusicSession(room);
    this.touch(room);
    this.publishRoom(room);
    return { cleared: true };
  }

  private installMusicSession(
    room: SongGuessrRoomRecord,
    ownerPlayerId: string,
    session: MusicLoginSession,
  ): MusicLoginSession {
    this.ensureHost(room, ownerPlayerId);
    const cookie = this.requireMusicCookie(session.cookie);
    const account = {
      userId: session.account.userId?.slice(0, 64),
      nickname: session.account.nickname.slice(0, 80) || "网易云用户",
      avatarUrl: session.account.avatarUrl?.slice(0, 2_048),
      vipStatus: session.account.vipStatus,
      vipType: session.account.vipType,
      vipExpireTime: session.account.vipExpireTime,
    };
    // 房间内只暂存调用音乐接口所需的 Cookie 和会员判定所需的最小账号状态，不做持久化保存。
    room.musicSession = { ownerPlayerId, cookie, account };
    return { cookie, account };
  }

  private requireMusicCookie(value: string): string {
    const cookie = value.trim();
    if (!cookie || cookie.length > MAX_SONGUESSR_COOKIE_LENGTH) {
      throw new AppError("MUSIC_SESSION_INVALID", "网易云登录状态无效");
    }
    return cookie;
  }

  private clearMusicSession(room: SongGuessrRoomRecord, ownerPlayerId?: string): boolean {
    if (!room.musicSession) return false;
    if (ownerPlayerId && room.musicSession.ownerPlayerId !== ownerPlayerId) return false;
    room.musicSession = undefined;
    return true;
  }

  private addBots(connection: ConnectionRecord, countValue?: number) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (!this.isTestRoom(room)) throw new AppError("TEST_ROOM_ONLY", "该指令仅用于测试房间");
    const count = clampInt(countValue ?? 1, 1, SONGUESSR_MAX_PLAYERS);
    const available = Math.max(0, SONGUESSR_MAX_PLAYERS - this.onlineCount(room));
    const added: string[] = [];
    for (let index = 0; index < Math.min(count, available); index += 1) {
      const botIndex = Object.values(room.players).filter((candidate) => candidate.isBot).length;
      const suffix = BOT_NAME_SUFFIXES[botIndex] ?? String(botIndex + 1);
      const bot = this.createPlayer(`测试人机 ${suffix}`, false, true);
      bot.isReady = true;
      room.players[bot.id] = bot;
      added.push(bot.id);
    }
    this.touch(room);
    this.publishRoom(room);
    return { addedPlayerIds: added };
  }

  private removeBots(connection: ConnectionRecord, countValue?: number) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (!this.isTestRoom(room)) throw new AppError("TEST_ROOM_ONLY", "该指令仅用于测试房间");
    const count = clampInt(countValue ?? 1, 1, SONGUESSR_MAX_PLAYERS);
    const bots = Object.values(room.players)
      .filter((candidate) => candidate.isBot)
      .sort((left, right) => right.joinedAt - left.joinedAt)
      .slice(0, count);
    for (const bot of bots) delete room.players[bot.id];
    if (room.phase === "playing" && this.isRoundComplete(room)) this.finishRound(room);
    this.touch(room);
    this.publishRoom(room);
    return { removedPlayerIds: bots.map((bot) => bot.id) };
  }

  private async startGame(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    const automatic = room.settings.questionMode === "automatic";
    if (
      room.phase !== "waiting" ||
      (automatic && room.automaticRoundLoading) ||
      (!automatic && room.manualRoundStarting)
    ) {
      throw new AppError("INVALID_PHASE", "当前不能开始新游戏");
    }

    // 自动与手动开局均先占锁，避免重复点击并发创建两轮。
    if (automatic) room.automaticRoundLoading = true;
    else room.manualRoundStarting = true;
    try {
      if (!room.musicSession) {
        throw new AppError("MUSIC_LOGIN_REQUIRED", "开始游戏前请先扫码登录网易云账号");
      }
      const getLoginStatus = this.options.musicProvider.getLoginStatus;
      if (!getLoginStatus) {
        throw new AppError("MUSIC_AUTH_UNAVAILABLE", "网易云登录状态校验不可用");
      }
      try {
        const session = await getLoginStatus.call(this.options.musicProvider, room.musicSession.cookie);
        room.musicSession.account = session.account;
      } catch (error) {
        if (error instanceof AppError) {
          if (error.code === "MUSIC_SESSION_INVALID") {
            this.clearMusicSession(room);
            this.publishRoom(room);
          }
          throw error;
        }
        throw new AppError("MUSIC_API_FAILED", "网易云登录状态校验失败，请稍后重试");
      }

      const activePlayers = this.activePlayers(room);
      if (activePlayers.length < 2) throw new AppError("NOT_ENOUGH_PLAYERS", "至少需要两名正式玩家");
      if (activePlayers.some((candidate) => !candidate.isReady)) {
        throw new AppError("PLAYERS_NOT_READY", "仍有玩家未准备");
      }

      room.pendingSubmitterPlayerId = undefined;
      room.currentRound = undefined;
      room.roundSummary = undefined;
      if (automatic) {
        await this.startAutomaticRound(room);
      } else {
        room.phase = "choosingSubmitter";
      }
      room.finalScores = undefined;
      this.touch(room);
      this.publishRoom(room);
      this.publishLobby();
      this.log("song.game.started", room.id, player.id);
      return { started: true };
    } finally {
      if (automatic) room.automaticRoundLoading = false;
      else room.manualRoundStarting = false;
    }
  }

  private chooseSubmitter(connection: ConnectionRecord, targetPlayerId: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (room.phase !== "choosingSubmitter") throw new AppError("INVALID_PHASE", "当前不能选择出题人");
    const target = room.players[targetPlayerId];
    if (!target || !target.online || target.membership === "kicked" || target.isBot) {
      throw new AppError("INVALID_TARGET", "出题人必须是在线真人玩家");
    }

    room.pendingSubmitterPlayerId = target.id;
    room.phase = "submittingSong";
    room.roundSummary = undefined;
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return { submitterPlayerId: target.id };
  }

  private async submitSong(connection: ConnectionRecord, songId: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    if (room.phase !== "submittingSong" || room.pendingSubmitterPlayerId !== player.id) {
      throw new AppError("NOT_SUBMITTER", "只有当前出题人可以提交歌曲");
    }

    const submitterId = player.id;
    const song = await this.options.musicProvider.getSong(songId, room.musicSession?.cookie);
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
    if (room.musicSession?.account.vipStatus === "nonVip" && song.requiresVip) {
      throw new AppError("MUSIC_VIP_REQUIRED", "当前网易云账号不是会员，无法选择会员专享歌曲");
    }
    const roundNumber = this.installRound(room, song, player.id);
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();

    if (this.isRoundComplete(room)) {
      this.finishRound(room);
      this.publishRoom(room);
    }
    return { roundNumber };
  }

  private installRound(room: SongGuessrRoomRecord, song: SongDetails, submitterPlayerId: string): number {
    this.applyQueuedMemberships(room);
    if (this.activePlayers(room).filter((candidate) => candidate.online).length < 2) {
      throw new AppError("NOT_ENOUGH_PLAYERS", "下一轮至少需要两名在线正式玩家");
    }
    const lyricClip = createSongLyricClip(
      song.lyrics,
      room.settings.lyricsLineCount,
      this.random,
      song.durationMs,
    );
    const roundNumber = room.roundNumber + 1;
    const roundSettings = cloneSettings(room.settings);
    const participantStates = Object.fromEntries(
      this.activePlayers(room).filter((candidate) => candidate.online).map((candidate) => [
        candidate.id,
        {
          audioReady: candidate.isBot,
          guessesUsed: candidate.isBot ? roundSettings.maxGuessesPerRound : 0,
          correct: false,
          gaveUp: candidate.isBot,
        } satisfies SongGuessrRoundPlayerState,
      ]),
    );
    room.roundNumber = roundNumber;
    room.currentRound = {
      number: roundNumber,
      submitterPlayerId,
      song,
      lyricClip,
      attempts: [],
      correctPlayerIds: [],
      startScores: Object.fromEntries(Object.values(room.players).map((candidate) => [candidate.id, candidate.score])),
      players: participantStates,
      settings: roundSettings,
      audioReadyDeadlineAt: this.now() + 15_000,
      hardDeadlineAt: this.now() + (roundSettings.guessDurationSeconds + 20) * 1_000,
    };
    room.pendingSubmitterPlayerId = undefined;
    room.roundSummary = undefined;
    room.phase = "playing";
    this.appendSystemMessage(room, `第 ${roundNumber} 轮开始`);
    return roundNumber;
  }

  private async startAutomaticRound(room: SongGuessrRoomRecord): Promise<void> {
    const candidates = await this.resolveAutomaticCandidates(room);
    if (candidates.length === 0) {
      throw new AppError("AUTO_NO_MATCH", "没有符合当前筛选条件的歌曲");
    }
    const pool = [...candidates];
    while (pool.length > 0) {
      const selected = pool.splice(this.random.nextInt(pool.length), 1)[0];
      if (room.musicSession?.account.vipStatus === "nonVip" && selected.requiresVip) continue;
      const song = await this.options.musicProvider.getSong(selected.id, room.musicSession?.cookie);
      if (room.musicSession?.account.vipStatus === "nonVip" && song.requiresVip) continue;
      this.installRound(room, song, "");
      return;
    }
    throw new AppError("MUSIC_VIP_REQUIRED", "筛选结果全部为会员歌曲，当前账号无法开始");
  }

  private async resolveAutomaticCandidates(room: SongGuessrRoomRecord): Promise<SongSearchResult[]> {
    const filters = room.settings.autoFilters;
    const cookie = room.musicSession?.cookie;
    const sets: SongSearchResult[][] = [];
    if (filters.playlist && this.options.musicProvider.getPlaylistSongs) {
      sets.push((await this.options.musicProvider.getPlaylistSongs(filters.playlist.id, cookie)).songs);
    }
    if (filters.artists.length > 0 && this.options.musicProvider.getArtistSongs) {
      const artistSongs = await Promise.all(filters.artists.map((artist) =>
        this.options.musicProvider.getArtistSongs!(artist.id, cookie)));
      sets.push(artistSongs.flat());
    }
    if (sets.length === 0) {
      if (!this.options.musicProvider.getPlaylistSongs) {
        throw new AppError("MUSIC_API_UNAVAILABLE", "当前音乐 API 不支持自动题库");
      }
      sets.push((await this.options.musicProvider.getPlaylistSongs(
        DEFAULT_AUTO_PLAYLIST_ID,
        cookie,
      )).songs);
    }
    const first = new Map(sets[0].map((song) => [song.id, song]));
    for (const set of sets.slice(1)) {
      const ids = new Set(set.map((song) => song.id));
      for (const id of first.keys()) if (!ids.has(id)) first.delete(id);
    }
    const candidates = [...first.values()];
    if (filters.minPopularity === 0) return candidates;
    const knownMatches = candidates.filter(
      (song) => song.popularity !== undefined && song.popularity >= filters.minPopularity,
    );
    if (knownMatches.length > 0) return knownMatches;

    const getPopularity = this.options.musicProvider.getSongPopularity;
    if (!getPopularity) {
      return [];
    }

    // 大歌单不能逐首回源查询热度。随机抽取有限候选，缓存命中仍可复用，
    // 冷缓存下单轮最多发起固定数量的上游请求，避免限流恢复后继续堆积。
    const lookupPool = [...candidates];
    const sampled: SongSearchResult[] = [];
    while (lookupPool.length > 0 && sampled.length < AUTO_POPULARITY_LOOKUP_LIMIT) {
      sampled.push(lookupPool.splice(this.random.nextInt(lookupPool.length), 1)[0]);
    }

    const enriched: SongSearchResult[] = [];
    for (let index = 0; index < sampled.length; index += 4) {
      const batch = sampled.slice(index, index + 4);
      const values = await Promise.all(batch.map(async (song) => ({
        ...song,
        popularity: await getPopularity.call(this.options.musicProvider, song.id, cookie) ?? song.popularity,
      })));
      enriched.push(...values);
    }
    return enriched.filter((song) => (song.popularity ?? 0) >= filters.minPopularity);
  }

  private audioReady(connection: ConnectionRecord, roundNumber: number) {
    const { room, player } = this.requireRoomPlayer(connection);
    // 页面切后台/重连时可能补发旧回合的 ready；状态过渡期间应幂等忽略，
    // 不把一个正常的陈旧通知显示成「当前没有进行中的回合」。
    if (room.phase !== "playing" || !room.currentRound || room.automaticRoundLoading) {
      return { ignored: true };
    }
    const round = room.currentRound;
    if (round.number !== roundNumber) return { ignored: true };
    const state = round.players[player.id];
    if (
      !state ||
      (player.id === round.submitterPlayerId && !this.canTestSubmitterGuess(room, player.id)) ||
      player.membership !== "active"
    ) {
      return { ignored: true };
    }
    if (
      !state.audioReady &&
      !state.correct &&
      !state.gaveUp &&
      state.guessesUsed < round.settings.maxGuessesPerRound
    ) {
      state.audioReady = true;
      state.deadlineAt = round.settings.showGuessTimer
        ? this.now() + round.settings.guessDurationSeconds * 1_000
        : undefined;
    }
    this.touch(room);
    this.publishPrivateState(room, player);
    return { deadlineAt: state.deadlineAt };
  }

  private async guess(connection: ConnectionRecord, songId: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireActiveRound(room);
    const state = round.players[player.id];
    if (!state || player.membership !== "active") throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能猜歌");
    if (player.id === round.submitterPlayerId && !this.canTestSubmitterGuess(room, player.id)) {
      throw new AppError("SUBMITTER_CANNOT_GUESS", "出题人不能参与猜歌");
    }
    if (!state.audioReady) throw new AppError("AUDIO_NOT_READY", "音频尚未准备完成");
    if (state.correct) throw new AppError("ALREADY_CORRECT", "你已经猜对了");
    if (state.gaveUp) throw new AppError("ALREADY_GAVE_UP", "你已经放弃本回合");
    if (state.inFlight) throw new AppError("GUESS_IN_PROGRESS", "正在校验上一次猜测，请稍候");
    if (state.guessesUsed >= round.settings.maxGuessesPerRound) throw new AppError("NO_MORE_GUESSES", "本回合猜测次数已用完");

    if (state.deadlineAt !== undefined && state.deadlineAt <= this.now()) {
      this.recordTimeout(room, player.id);
      if (this.isRoundComplete(room)) this.finishRound(room);
      this.publishRoom(room);
      throw new AppError("GUESS_TIMEOUT", "本次猜测已经超时");
    }

    // 关键修复：在让出事件循环前先占位自增并加锁，防止并发穿透配额上限
    state.inFlight = true;
    state.guessesUsed += 1;
    player.totalGuesses += 1;

    let guessedSong: SongDetails;
    try {
      guessedSong = await this.options.musicProvider.getSongMetadata(
        songId,
        room.musicSession?.cookie,
      );
    } catch (error) {
      if (room.phase === "playing" && room.currentRound === round) {
        state.guessesUsed = Math.max(0, state.guessesUsed - 1);
        player.totalGuesses = Math.max(0, player.totalGuesses - 1);
      }
      state.inFlight = false;
      throw error;
    }

    // 异步返回后复验房间与回合状态
    if (room.phase !== "playing" || room.currentRound !== round || player.membership !== "active") {
      state.inFlight = false;
      throw new AppError("ROUND_EXPIRED", "该回合已结束");
    }
    state.inFlight = false;
    const correct = this.isCorrectSong(guessedSong, round.song);
    const attempt: SongGuessAttempt = {
      id: this.createId("song_guess"),
      playerId: player.id,
      playerName: player.name,
      guessNumber: state.guessesUsed,
      createdAt: this.now(),
      result: correct ? "correct" : "wrong",
      guessedSong: this.publicSong(guessedSong),
      feedback: this.buildFeedback(guessedSong, round.song),
    };
    round.attempts.push(attempt);

    if (correct) {
      state.correct = true;
      state.deadlineAt = undefined;
      player.correctGuesses += 1;
      const formalPlayerCount = this.activePlayers(room).length;
      player.score += round.settings.bloodMode
        ? formalPlayerCount - round.correctPlayerIds.length
        : SCORING.correct;
      round.correctPlayerIds.push(player.id);
    } else if (state.guessesUsed < round.settings.maxGuessesPerRound) {
      state.deadlineAt = round.settings.showGuessTimer
        ? this.now() + round.settings.guessDurationSeconds * 1_000
        : undefined;
    } else {
      state.deadlineAt = undefined;
    }

    if (this.isRoundComplete(room)) {
      this.finishRound(room);
    }
    this.touch(room);
    this.publishRoom(room);
    return {
      attempt,
      remainingGuesses: Math.max(0, round.settings.maxGuessesPerRound - state.guessesUsed),
    };
  }

  private giveUp(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireActiveRound(room);
    const state = round.players[player.id];
    if (!state || player.membership !== "active") {
      throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能执行猜歌操作");
    }
    if (player.id === round.submitterPlayerId && !this.canTestSubmitterGuess(room, player.id)) {
      throw new AppError("SUBMITTER_CANNOT_GIVE_UP", "出题人无需放弃");
    }
    if (state.correct) throw new AppError("ALREADY_CORRECT", "你已经猜对了");
    if (state.gaveUp || state.guessesUsed >= round.settings.maxGuessesPerRound) {
      throw new AppError("ROUND_ACTION_FINISHED", "你已完成本回合操作");
    }

    state.gaveUp = true;
    state.deadlineAt = undefined;
    round.attempts.push({
      id: this.createId("song_guess"),
      playerId: player.id,
      playerName: player.name,
      guessNumber: state.guessesUsed + 1,
      createdAt: this.now(),
      result: "gaveUp",
    });
    if (this.isRoundComplete(room)) this.finishRound(room);
    this.touch(room);
    this.publishRoom(room);
    return { gaveUp: true };
  }

  private skipRound(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    this.requireActiveRound(room);
    this.finishRound(room);
    this.publishRoom(room);
    this.publishLobby();
    return { skipped: true };
  }

  private async nextRound(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (room.phase !== "roundResult") throw new AppError("INVALID_PHASE", "当前不在回合结算阶段");
    const previousRound = room.currentRound;
    const previousSummary = room.roundSummary;
    if (room.settings.questionMode === "automatic") {
      if (room.automaticRoundLoading) throw new AppError("ROUND_BUSY", "正在准备下一回合");
      room.automaticRoundLoading = true;
      try {
        this.applyQueuedMemberships(room);
        if (this.activePlayers(room).filter((candidate) => candidate.online).length < 2) {
          room.currentRound = undefined;
          room.roundSummary = undefined;
          room.pendingSubmitterPlayerId = undefined;
          room.phase = "waiting";
          this.resetReadyState(room);
          this.touch(room);
          this.publishRoom(room);
          this.publishLobby();
          return { nextRound: room.roundNumber + 1, waiting: true };
        }
        await this.startAutomaticRound(room);
      } catch (error) {
        // 自动题库临时失败时保留答案页，房主可以重试或回到等待阶段，
        // 不能留下既没有 currentRound 也没有 roundSummary 的悬空状态。
        room.currentRound = previousRound;
        room.roundSummary = previousSummary;
        room.phase = "roundResult";
        throw error;
      } finally {
        room.automaticRoundLoading = false;
      }
    } else {
      if (room.manualRoundStarting) throw new AppError("ROUND_BUSY", "正在准备下一回合");
      room.manualRoundStarting = true;
      try {
        const previousSubmitterId = previousRound?.submitterPlayerId;
        room.currentRound = undefined;
        room.roundSummary = undefined;
        this.applyQueuedMemberships(room);
        if (this.activePlayers(room).filter((candidate) => candidate.online).length < 2) {
          room.pendingSubmitterPlayerId = undefined;
          room.phase = "waiting";
          this.resetReadyState(room);
          this.touch(room);
          this.publishRoom(room);
          this.publishLobby();
          return { nextRound: room.roundNumber + 1, waiting: true };
        }
        if (room.settings.autoRotateSubmitter) {
          const nextSubmitter = this.nextRotatingSubmitter(room, previousSubmitterId);
          if (nextSubmitter) {
            room.pendingSubmitterPlayerId = nextSubmitter.id;
            room.phase = "submittingSong";
          } else {
            room.phase = "choosingSubmitter";
          }
        } else {
          room.phase = "choosingSubmitter";
        }
      } finally {
        room.manualRoundStarting = false;
      }
    }
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return { nextRound: room.roundNumber + 1 };
  }

  private finishGame(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (room.phase !== "roundResult") throw new AppError("INVALID_PHASE", "只能在回合结算后返回等待阶段");
    room.phase = "waiting";
    room.pendingSubmitterPlayerId = undefined;
    room.currentRound = undefined;
    room.roundSummary = undefined;
    room.finalScores = undefined;
    this.applyQueuedMemberships(room);
    this.resetReadyState(room);
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return { waiting: true, roundNumber: room.roundNumber };
  }

  private recordTimeout(room: SongGuessrRoomRecord, playerId: string) {
    const round = room.currentRound;
    const state = round?.players[playerId];
    const player = room.players[playerId];
    if (!round || !state || !player || state.correct || state.gaveUp) return;
    if (state.guessesUsed >= round.settings.maxGuessesPerRound) return;

    state.guessesUsed += 1;
    player.totalGuesses += 1;
    round.attempts.push({
      id: this.createId("song_guess"),
      playerId,
      playerName: player.name,
      guessNumber: state.guessesUsed,
      createdAt: this.now(),
      result: "timeout",
    });
    state.deadlineAt = state.guessesUsed < round.settings.maxGuessesPerRound && round.settings.showGuessTimer
      ? this.now() + round.settings.guessDurationSeconds * 1_000
      : undefined;
  }

  private finishRound(room: SongGuessrRoomRecord) {
    const round = room.currentRound;
    if (!round || room.phase !== "playing") return;
    const submitter = room.players[round.submitterPlayerId];
    if (submitter) {
      submitter.score += round.correctPlayerIds.length > 0
        ? round.correctPlayerIds.length * SCORING.submitterPerCorrect
        : SCORING.submitterNobodyCorrect;
    }

    for (const state of Object.values(round.players)) state.deadlineAt = undefined;
    room.roundSummary = {
      roundNumber: round.number,
      song: {
        ...this.publicSong(round.song),
        releaseYear: round.song.releaseYear,
        popularity: round.song.popularity,
        language: round.song.language,
        encyclopedia: round.song.encyclopedia,
      },
      submitterPlayerId: round.submitterPlayerId,
      correctPlayerIds: [...round.correctPlayerIds],
      attempts: [...round.attempts],
      scores: this.buildScores(room, round.startScores),
    };
    room.phase = "roundResult";
    this.touch(room);
    this.log("song.game.round_finished", room.id, round.submitterPlayerId, {
      roundNumber: round.number,
      correctCount: round.correctPlayerIds.length,
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

  private isCorrectSong(guess: SongDetails, answer: SongDetails) {
    if (guess.id === answer.id) return true;
    if (normalizeSongTitle(guess.title) !== normalizeSongTitle(answer.title)) return false;
    const answerArtists = normalizedArtists(answer.artist);
    return [...normalizedArtists(guess.artist)].some((artist) => answerArtists.has(artist));
  }

  private applyQueuedMemberships(room: SongGuessrRoomRecord) {
    for (const player of Object.values(room.players)) {
      const membership = player.nextRoundMembership;
      if (!membership || player.membership === "kicked") continue;
      if (membership === "spectator" && !room.allowSpectators) continue;
      if (membership === "active" && !player.online) continue;
      player.nextRoundMembership = undefined;
      player.membership = membership;
      player.isReady = membership === "active" && (player.id === room.hostPlayerId || player.isBot);
    }
  }

  private resetReadyState(room: SongGuessrRoomRecord) {
    for (const candidate of Object.values(room.players)) {
      candidate.isReady = candidate.membership === "active" &&
        (candidate.id === room.hostPlayerId || candidate.isBot);
    }
  }

  private nextRotatingSubmitter(room: SongGuessrRoomRecord, previousSubmitterId?: string) {
    const candidates = Object.values(room.players)
      .filter((player) => player.online && player.membership === "active" && !player.isBot)
      .sort((left, right) => left.joinedAt - right.joinedAt);
    if (candidates.length === 0) return undefined;
    const previousIndex = candidates.findIndex((player) => player.id === previousSubmitterId);
    return candidates[(previousIndex + 1 + candidates.length) % candidates.length];
  }

  private canTestSubmitterGuess(room: SongGuessrRoomRecord, playerId: string) {
    return Boolean(
      this.isTestRoom(room) &&
      room.currentRound?.submitterPlayerId === playerId &&
      room.players[playerId]?.membership === "active",
    );
  }

  private isRoundComplete(room: SongGuessrRoomRecord) {
    const round = room.currentRound;
    if (!round) return false;
    const guessers = this.activePlayers(room).filter(
      (player) =>
        player.id !== round.submitterPlayerId || this.canTestSubmitterGuess(room, player.id),
    );
    return guessers.every((player) => {
      const state = round.players[player.id];
      return !state || state.correct || state.gaveUp || state.guessesUsed >= round.settings.maxGuessesPerRound;
    });
  }

  private buildRoomSummary(room: SongGuessrRoomRecord): SonGuessrRoomSummary {
    return {
      roomId: room.id,
      name: room.name,
      visibility: room.visibility,
      allowSpectators: room.allowSpectators,
      hasPassword: Boolean(room.password),
      playerCount: this.activePlayers(room).length,
      onlineCount: this.onlineCount(room),
      maxPlayers: SONGUESSR_MAX_PLAYERS,
      phase: room.phase,
    };
  }

  private buildRoomSnapshot(room: SongGuessrRoomRecord): SonGuessrRoomSnapshot {
    const round = room.currentRound;
    return {
      roomId: room.id,
      name: room.name,
      visibility: room.visibility,
      allowSpectators: room.allowSpectators,
      hasPassword: Boolean(room.password),
      maxPlayers: SONGUESSR_MAX_PLAYERS,
      hostPlayerId: room.hostPlayerId,
      testMode: this.isTestRoom(room),
      musicAccountReady: Boolean(room.musicSession),
      settings: room.settings,
      phase: room.phase,
      roundNumber: room.roundNumber,
      pendingSubmitterPlayerId: room.pendingSubmitterPlayerId,
      currentRound:
        room.phase === "playing" && round
          ? {
              roundNumber: round.number,
              submitterPlayerId: round.submitterPlayerId,
              audioUrl: round.song.audioUrl,
              lyricClip: room.settings.showLyrics
                ? round.lyricClip
                : { ...round.lyricClip, lines: [] },
            }
          : undefined,
      players: Object.values(room.players)
        .filter((player) => player.membership !== "kicked")
        .sort((left, right) => left.joinedAt - right.joinedAt)
        .map((player) => this.buildPlayerView(room, player)),
      chat: room.chat,
      ...(room.roundSummary ? { roundSummary: room.roundSummary } : {}),
      ...(room.finalScores ? { finalScores: room.finalScores } : {}),
    };
  }

  private buildPlayerView(
    room: SongGuessrRoomRecord,
    player: SongGuessrPlayerRecord,
  ): SonGuessrPlayerView {
    const round = room.currentRound;
    const state = round?.players[player.id];
    let roundStatus: SonGuessrPlayerView["roundStatus"] = "waiting";
    if (round?.submitterPlayerId === player.id) roundStatus = "submitter";
    else if (player.membership === "spectator") roundStatus = "spectator";
    else if (state?.correct) roundStatus = "correct";
    else if (
      state &&
      (state.gaveUp || state.guessesUsed >= (round?.settings.maxGuessesPerRound ?? room.settings.maxGuessesPerRound))
    ) roundStatus = "finished";
    else if (room.phase === "playing" && state) roundStatus = "guessing";

    return {
      id: player.id,
      name: player.name,
      score: player.score,
      membership: player.membership,
      nextRoundMembership: player.nextRoundMembership,
      online: player.online,
      isReady: player.isReady,
      isBot: player.isBot,
      isHost: room.hostPlayerId === player.id,
      correctGuesses: player.correctGuesses,
      totalGuesses: player.totalGuesses,
      roundStatus,
      guessesUsed: state?.guessesUsed ?? 0,
    };
  }

  private buildPrivateState(
    room: SongGuessrRoomRecord,
    player: SongGuessrPlayerRecord,
  ): SonGuessrPrivateState {
    const round = room.currentRound;
    const state = round?.players[player.id];
    const isSubmitter = round?.submitterPlayerId === player.id || room.pendingSubmitterPlayerId === player.id;
    const canParticipateAsGuesser = !isSubmitter || this.canTestSubmitterGuess(room, player.id);
    const canObserveAllAttempts = isSubmitter || player.membership === "spectator";
    return {
      playerId: player.id,
      sessionToken: player.sessionToken,
      isSubmitter,
      canSubmitSong: room.phase === "submittingSong" && room.pendingSubmitterPlayerId === player.id,
      canGuess:
        room.phase === "playing" &&
        player.membership === "active" &&
        canParticipateAsGuesser &&
        Boolean(state?.audioReady) &&
        !state?.correct &&
        !state?.gaveUp &&
        (state?.guessesUsed ?? 0) < (round?.settings.maxGuessesPerRound ?? room.settings.maxGuessesPerRound),
      canGiveUp:
        room.phase === "playing" &&
        player.membership === "active" &&
        canParticipateAsGuesser &&
        Boolean(state) &&
        !state?.correct &&
        !state?.gaveUp &&
        (state?.guessesUsed ?? 0) < (round?.settings.maxGuessesPerRound ?? room.settings.maxGuessesPerRound),
      remainingGuesses: Math.max(
        0,
        (round?.settings.maxGuessesPerRound ?? room.settings.maxGuessesPerRound) - (state?.guessesUsed ?? 0),
      ),
      guessDeadlineAt: state?.deadlineAt,
      // 出题人与旁观者在游戏中均可看到本题答案
      submittedSong:
        (isSubmitter || player.membership === "spectator") && round
          ? this.publicSong(round.song)
          : undefined,
      visibleAttempts: round
        ? round.attempts.filter(
            (attempt) => canObserveAllAttempts || attempt.playerId === player.id,
          )
        : [],
    };
  }

  private buildScores(
    room: SongGuessrRoomRecord,
    startScores: Record<string, number>,
  ): SonGuessrScore[] {
    return this.activePlayers(room)
      .map((player) => ({
        playerId: player.id,
        playerName: player.name,
        score: player.score,
        delta: player.score - (startScores[player.id] ?? player.score),
        correctGuesses: player.correctGuesses,
        totalGuesses: player.totalGuesses,
      }))
      .sort((left, right) => right.score - left.score || left.playerName.localeCompare(right.playerName));
  }

  private publishRoom(room: SongGuessrRoomRecord, targetConnection?: ConnectionRecord) {
    const snapshot = this.buildRoomSnapshot(room);
    const connections = targetConnection
      ? [targetConnection]
      : this.connections.getRoomConnections(room.id);
    for (const connection of connections) {
      connection.send(createEvent("song.room.snapshot", snapshot));
      if (connection.playerId) {
        const player = room.players[connection.playerId];
        if (player) connection.send(createEvent("song.game.privateState", this.buildPrivateState(room, player)));
      }
    }
  }

  private publishPrivateState(room: SongGuessrRoomRecord, player: SongGuessrPlayerRecord) {
    const connection = this.connections.findConnectionByPlayer(room.id, player.id);
    connection?.send(createEvent("song.game.privateState", this.buildPrivateState(room, player)));
  }

  private publishRoomCalibration(room: SongGuessrRoomRecord) {
    const snapshot = this.buildRoomSnapshot(room);
    for (const connection of this.connections.getRoomConnections(room.id)) {
      connection.sendStateSyncCalibration?.(createEvent("song.room.snapshot", snapshot));
      if (!connection.playerId) continue;
      const player = room.players[connection.playerId];
      if (player) {
        connection.sendStateSyncCalibration?.(
          createEvent("song.game.privateState", this.buildPrivateState(room, player)),
        );
      }
    }
  }

  private publishLobby() {
    this.connections.broadcastToLobby(createEvent("song.lobby.rooms", this.getRoomSummaries()));
  }

  private closeRoom(room: SongGuessrRoomRecord, reason: string) {
    this.connections.broadcastToRoom(room.id, createEvent("song.room.closed", { roomId: room.id, reason }));
    for (const connection of this.connections.getRoomConnections(room.id)) {
      connection.roomId = undefined;
      connection.playerId = undefined;
    }
    room.musicSession = undefined;
    this.rooms.delete(room.id);
    this.publishLobby();
  }

  private attachConnection(
    room: SongGuessrRoomRecord,
    player: SongGuessrPlayerRecord,
    connection: ConnectionRecord,
  ) {
    const previous = this.connections.findConnectionByPlayer(room.id, player.id);
    if (previous && previous.id !== connection.id) {
      (previous.sendPacket ?? previous.send)(createEvent("session.replaced", { roomId: room.id }));
      previous.roomId = undefined;
      previous.playerId = undefined;
      previous.close(4001, "session_replaced");
    }
    player.online = true;
    player.connectionId = connection.id;
    player.lastSeenAt = this.now();
    connection.resetStateSync?.();
    connection.roomId = room.id;
    connection.playerId = player.id;
  }

  private appendSystemMessage(room: SongGuessrRoomRecord, text: string) {
    room.chat = [
      ...room.chat,
      {
        id: this.createId("song_chat"),
        playerId: "system",
        playerName: "系统",
        text,
        createdAt: this.now(),
        system: true,
      },
    ].slice(-CHAT_LIMIT);
  }

  private createPlayer(nameValue: string, host: boolean, isBot = false): SongGuessrPlayerRecord {
    const name = this.requireName(nameValue);
    const now = this.now();
    return {
      id: this.createId("song_player"),
      sessionToken: `${this.createId("song_session")}_${crypto.randomUUID()}`,
      name,
      membership: "active",
      online: true,
      isReady: host,
      score: 0,
      correctGuesses: 0,
      totalGuesses: 0,
      isBot,
      joinedAt: now,
      lastSeenAt: now,
    };
  }

  private activePlayers(room: SongGuessrRoomRecord) {
    return Object.values(room.players).filter((player) => player.membership === "active");
  }

  private onlineCount(room: SongGuessrRoomRecord) {
    return Object.values(room.players).filter(
      (player) => player.online && player.membership !== "kicked",
    ).length;
  }

  private publicSong(song: SongDetails): SongSearchResult {
    return {
      id: song.id,
      title: song.title,
      artist: song.artist,
      album: song.album,
      pictureUrl: song.pictureUrl,
      durationMs: song.durationMs,
      requiresVip: song.requiresVip,
    };
  }

  private requireRoomPlayer(connection: ConnectionRecord) {
    if (!connection.roomId || !connection.playerId) {
      throw new AppError("PLAYER_NOT_IN_ROOM", "当前连接尚未加入房间");
    }
    const room = this.getRoom(connection.roomId);
    const player = room.players[connection.playerId];
    if (!player || player.membership === "kicked") throw new AppError("PLAYER_NOT_FOUND", "玩家不存在");
    return { room, player };
  }

  private requireActiveRound(room: SongGuessrRoomRecord) {
    if (room.phase !== "playing" || !room.currentRound) {
      throw new AppError("NO_ACTIVE_ROUND", "当前没有进行中的回合");
    }
    return room.currentRound;
  }

  private getRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) throw new AppError("ROOM_NOT_FOUND", "房间不存在");
    return room;
  }

  private ensureConnectionFree(connection: ConnectionRecord) {
    if (connection.roomId || connection.playerId) {
      connection.roomId = undefined;
      connection.playerId = undefined;
    }
  }

  private ensureHost(room: SongGuessrRoomRecord, playerId: string) {
    if (room.hostPlayerId !== playerId) throw new AppError("FORBIDDEN", "只有房主可以执行该操作");
  }

  private ensurePassword(room: SongGuessrRoomRecord, password?: string) {
    if (room.visibility === "private" && room.password !== password?.trim()) {
      throw new AppError("PASSWORD_INCORRECT", "房间密码错误");
    }
  }

  private requirePassword(password?: string) {
    const normalized = password?.trim();
    if (!normalized) throw new AppError("PASSWORD_REQUIRED", "私密房间需要密码");
    return normalized;
  }

  private requireName(value: string) {
    const normalized = normalizeName(value).slice(0, 20);
    if (!normalized) throw new AppError("INVALID_NAME", "用户名不能为空");
    return normalized;
  }

  private reassignHost(room: SongGuessrRoomRecord) {
    const next = Object.values(room.players)
      .filter((player) => player.online && player.membership === "active" && !player.isBot)
      .sort((left, right) => left.joinedAt - right.joinedAt)[0]
      ?? Object.values(room.players)
        .filter((player) => player.online && player.membership !== "kicked" && !player.isBot)
        .sort((left, right) => left.joinedAt - right.joinedAt)[0];
    if (next) {
      room.hostPlayerId = next.id;
      next.isReady = true;
      if (room.musicSession) room.musicSession.ownerPlayerId = next.id;
    } else {
      room.hostPlayerId = "";
    }
  }

  private transferHostAfterDisconnect(room: SongGuessrRoomRecord) {
    const previousHost = room.players[room.hostPlayerId];
    if (!previousHost || previousHost.online || previousHost.membership === "kicked") {
      room.hostReconnectDeadlineAt = undefined;
      return;
    }
    room.hostReconnectDeadlineAt = undefined;
    this.reassignHost(room);
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
  }

  private isTestRoom(room: SongGuessrRoomRecord) {
    return room.id.toLowerCase() === ROOM_ID_TEST_MODE.toLowerCase();
  }

  private touch(room: SongGuessrRoomRecord) {
    room.updatedAt = this.now();
    room.lastActivityAt = this.now();
  }

  private createId(prefix: string) {
    this.idCounter += 1;
    return `${prefix}_${this.idCounter.toString(36)}`;
  }

  private log(type: string, roomId?: string, playerId?: string, payload?: unknown) {
    void this.options.eventLogger?.write({
      type,
      roomId,
      playerId,
      payload,
      createdAt: this.now(),
    });
  }
}

export const SongGuessrService = SonGuessrService;
export type SongGuessrService = SonGuessrService;

