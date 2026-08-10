import { BOT_NAME_SUFFIXES, CHAT_LIMIT, ROOM_IDLE_TIMEOUT_MS } from "../config/constants";
import { AppError } from "../domain/errors";
import { ensureRoomId, normalizeName, normalizeWord, type RandomSource } from "../domain/rules";
import { ROOM_ID_TEST_MODE, type ConnectionRecord, type RoomVisibility } from "../domain/model";
import type { EventLogger } from "../infrastructure/event-logger";
import type {
  MusicLoginSession,
  MusicProvider,
} from "../infrastructure/netease-music-provider";
import { SONG_GUESSR_MAX_PLAYERS } from "../shared";
import type {
  ChatMessage,
  SongDetails,
  SongGuessAttempt,
  SongGuessDirection,
  SongGuessFeedback,
  SongGuessrClientMessage,
  SongGuessrPhase,
  SongGuessrPlayerView,
  SongGuessrPrivateState,
  SongGuessrRoomSnapshot,
  SongGuessrRoomSummary,
  SongGuessrRoundSummary,
  SongGuessrScore,
  SongGuessrSettings,
  SongLyricClip,
  SongSearchResult,
} from "../shared";
import { createEvent } from "../transport/protocol";
import { ConnectionRegistry } from "./connection-registry";

const DEFAULT_SETTINGS: SongGuessrSettings = {
  lyricsLineCount: 5,
  endOnFirstCorrect: false,
  maxGuessesPerRound: 3,
  guessDurationSeconds: 60,
};

const SCORING = {
  correct: 10,
  firstCorrect: 5,
  submitterPerCorrect: 3,
  submitterNobodyCorrect: 5,
} as const;

interface SongGuessrPlayerRecord {
  id: string;
  sessionToken: string;
  name: string;
  membership: "active" | "spectator" | "kicked";
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
  settings: SongGuessrSettings;
}

interface SongGuessrRoomRecord {
  id: string;
  name: string;
  visibility: RoomVisibility;
  password?: string;
  allowSpectators: boolean;
  hostPlayerId: string;
  settings: SongGuessrSettings;
  phase: SongGuessrPhase;
  roundNumber: number;
  pendingSubmitterPlayerId?: string;
  currentRound?: SongGuessrRoundRecord;
  roundSummary?: SongGuessrRoundSummary;
  finalScores?: SongGuessrScore[];
  musicSession?: {
    ownerPlayerId: string;
    cookie: string;
  };
  players: Record<string, SongGuessrPlayerRecord>;
  chat: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
}

export interface SongGuessrServiceOptions {
  musicProvider: MusicProvider;
  now?: () => number;
  random?: RandomSource;
  eventLogger?: EventLogger;
}

const clampInt = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, Math.round(value)));

const normalizeSongText = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_'"“”‘’·.，,。!！?？()（）[\]【】]/g, "");

const direction = (guess?: number, answer?: number): SongGuessDirection => {
  if (guess === undefined || answer === undefined) return "unknown";
  if (guess === answer) return "equal";
  return guess < answer ? "higher" : "lower";
};

export const createSongLyricClip = (
  lyrics: SongDetails["lyrics"],
  lineCount: number,
  random: RandomSource,
): SongLyricClip => {
  if (lyrics.length < lineCount) {
    throw new AppError("LYRICS_TOO_SHORT", "歌词行数不足，无法生成当前设置的片段");
  }

  const safeCount = clampInt(lineCount, 1, lyrics.length);
  const edgePadding = lyrics.length - safeCount >= 4 ? 2 : 0;
  const firstIndex = edgePadding;
  const lastIndex = Math.max(firstIndex, lyrics.length - safeCount - edgePadding);
  const startIndex = firstIndex + random.nextInt(lastIndex - firstIndex + 1);
  const lines = lyrics.slice(startIndex, startIndex + safeCount);
  const endTime = Math.max(lines[0].time, lines.at(-1)!.endTime - 250);

  return {
    startTime: lines[0].time,
    endTime,
    lines,
  };
};

export class SongGuessrService {
  private readonly rooms = new Map<string, SongGuessrRoomRecord>();
  private readonly connections = new ConnectionRegistry();
  private readonly now: () => number;
  private readonly random: RandomSource;
  private idCounter = 0;

  constructor(private readonly options: SongGuessrServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? {
      nextInt: (maxExclusive) => Math.floor(Math.random() * Math.max(1, maxExclusive)),
    };
  }

  registerConnection(connection: ConnectionRecord): void {
    this.connections.registerConnection(connection);
  }

  async unregisterConnection(connectionId: string): Promise<void> {
    const connection = this.connections.unregisterConnection(connectionId);
    if (!connection?.roomId || !connection.playerId) return;
    const room = this.rooms.get(connection.roomId);
    const player = room?.players[connection.playerId];
    if (!room || !player) return;

    this.clearMusicSession(room, player.id);
    player.online = false;
    player.connectionId = undefined;
    player.lastSeenAt = this.now();
    connection.roomId = undefined;
    connection.playerId = undefined;

    // 测试房需要允许房主刷新后凭原会话恢复权限；显式离开仍会正常转让房主。
    if (room.hostPlayerId === player.id && !this.isTestRoom(room)) this.reassignHost(room);
    if (room.phase === "submittingSong" && room.pendingSubmitterPlayerId === player.id) {
      room.pendingSubmitterPlayerId = undefined;
      room.phase = "choosingSubmitter";
    }

    if (room.phase === "playing" && this.isRoundComplete(room)) this.finishRound(room);
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    this.log("song.player.disconnected", room.id, player.id);
  }

  async execute(connectionId: string, message: SongGuessrClientMessage): Promise<unknown> {
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
      case "song.auth.phone.sendCaptcha":
        return this.sendMusicPhoneCaptcha(
          connection,
          message.payload.phone,
          message.payload.countryCode,
        );
      case "song.auth.phone.login":
        return this.loginMusicWithPhone(connection, message.payload);
      case "song.auth.email.login":
        return this.loginMusicWithEmail(
          connection,
          message.payload.email,
          message.payload.password,
        );
      case "song.auth.useCookie":
        return this.useMusicCookie(connection, message.payload.cookie);
      case "song.auth.clear":
        return this.clearMusicAccount(connection);
      case "song.music.search":
        return this.searchMusic(connection, message.payload.keyword);
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
        this.closeRoom(room, this.onlineCount(room) === 0 ? "empty" : "idle_timeout");
        continue;
      }

      if (room.phase !== "playing" || !room.currentRound) continue;
      let changed = false;
      for (const [playerId, state] of Object.entries(room.currentRound.players)) {
        if (state.correct || state.gaveUp || state.guessesUsed >= room.currentRound.settings.maxGuessesPerRound) continue;
        if (state.deadlineAt !== undefined && state.deadlineAt <= currentTime) {
          this.recordTimeout(room, playerId);
          changed = true;
        }
      }

      if (changed) {
        if (this.isRoundComplete(room)) this.finishRound(room);
        this.publishRoom(room);
      }
    }
  }

  getRoomSummaries(): SongGuessrRoomSummary[] {
    return [...this.rooms.values()]
      .filter((room) => !this.isTestRoom(room))
      .map((room) => this.buildRoomSummary(room))
      .sort((left, right) => left.roomId.localeCompare(right.roomId));
  }

  private createRoom(
    connection: ConnectionRecord,
    payload: Extract<SongGuessrClientMessage, { type: "song.room.create" }>["payload"],
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
      settings: { ...DEFAULT_SETTINGS },
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
    return { roomId, playerId: player.id, sessionToken: player.sessionToken };
  }

  private joinRoom(
    connection: ConnectionRecord,
    roomIdValue: string | undefined,
    payload: Extract<SongGuessrClientMessage, { type: "song.room.join" }>["payload"],
  ) {
    this.ensureConnectionFree(connection);
    const room = this.getRoom(ensureRoomId(roomIdValue ?? ""));
    this.ensurePassword(room, payload.password);
    if (this.onlineCount(room) >= SONG_GUESSR_MAX_PLAYERS) {
      throw new AppError("ROOM_FULL", `房间最多容纳 ${SONG_GUESSR_MAX_PLAYERS} 人`);
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
    if (!currentHost || currentHost.isBot || !currentHost.online) {
      room.hostPlayerId = player.id;
      player.isReady = true;
    }
    this.attachConnection(room, player, connection);
    this.touch(room);
    this.appendSystemMessage(room, `${player.name} 加入了房间`);
    this.publishRoom(room);
    this.publishLobby();
    this.log("song.room.joined", room.id, player.id);
    return { roomId: room.id, playerId: player.id, sessionToken: player.sessionToken };
  }

  private reconnectRoom(connection: ConnectionRecord, roomIdValue: string, token: string) {
    this.ensureConnectionFree(connection);
    const room = this.getRoom(ensureRoomId(roomIdValue));
    const player = Object.values(room.players).find(
      (candidate) => candidate.sessionToken === token && candidate.membership !== "kicked",
    );
    if (!player) throw new AppError("SESSION_INVALID", "会话令牌无效");

    this.attachConnection(room, player, connection);
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return { roomId: room.id, playerId: player.id, sessionToken: player.sessionToken };
  }

  private leaveRoom(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.clearMusicSession(room, player.id);
    delete room.players[player.id];
    connection.roomId = undefined;
    connection.playerId = undefined;

    if (Object.keys(room.players).length === 0 && !this.isTestRoom(room)) {
      this.closeRoom(room, "empty");
      return { left: true, roomClosed: true };
    }

    if (room.hostPlayerId === player.id) this.reassignHost(room);
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
      throw new AppError("INVALID_PHASE", "只能在等待阶段切换玩家或旁观状态");
    }
    const nextMembership = spectator ? "spectator" : "active";
    if (player.membership === nextMembership) return { spectator };
    if (spectator) {
      if (!room.allowSpectators) throw new AppError("SPECTATORS_DISABLED", "当前房间不允许旁观");
      player.membership = "spectator";
      player.isReady = false;
    } else {
      player.membership = "active";
      player.isReady = player.id === room.hostPlayerId;
    }
    this.touch(room);
    this.appendSystemMessage(
      room,
      `${player.name} ${spectator ? "加入了旁观" : "加入了游戏"}`,
    );
    this.publishRoom(room);
    this.publishLobby();
    return { spectator };
  }

  private updateSettings(
    connection: ConnectionRecord,
    payload: Extract<SongGuessrClientMessage, { type: "song.room.updateSettings" }>["payload"],
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

    if (payload.lyricsLineCount !== undefined) {
      room.settings.lyricsLineCount = clampInt(payload.lyricsLineCount, 1, 10);
    }
    if (payload.maxGuessesPerRound !== undefined) {
      room.settings.maxGuessesPerRound = clampInt(payload.maxGuessesPerRound, 1, 10);
    }
    if (payload.guessDurationSeconds !== undefined) {
      room.settings.guessDurationSeconds = clampInt(payload.guessDurationSeconds, 10, 180);
    }
    if (payload.endOnFirstCorrect !== undefined) {
      room.settings.endOnFirstCorrect = payload.endOnFirstCorrect;
    }

    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return { settings: room.settings };
  }

  private async searchMusic(connection: ConnectionRecord, keyword: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    const round = room.currentRound;
    if (
      room.phase === "playing" &&
      round &&
      (player.id !== round.submitterPlayerId || this.canTestSubmitterGuess(room, player.id))
    ) {
      const query = normalizeSongText(keyword);
      const containsLyric = query.length >= 2 && round.lyricClip.lines.some((line) => {
        const lyric = normalizeSongText(line.text);
        return lyric.length >= 2 && (lyric.includes(query) || query.includes(lyric));
      });
      if (containsLyric) {
        throw new AppError("LYRIC_SEARCH_FORBIDDEN", "不能直接搜索当前展示的歌词原词");
      }
    }
    return {
      results: await this.options.musicProvider.search(
        keyword,
        undefined,
        room.musicSession?.cookie,
      ),
    };
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
      targetConnection.send(createEvent("song.room.kicked", { roomId: room.id }));
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
    this.clearMusicSession(room);
    room.hostPlayerId = target.id;
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
    this.connections.broadcastToRoom(room.id, createEvent("song.chat.message", message));
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

  private async sendMusicPhoneCaptcha(
    connection: ConnectionRecord,
    phoneValue: string,
    countryCodeValue?: string,
  ) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    const phone = phoneValue.trim();
    const countryCode = countryCodeValue?.trim() || "86";
    if (!phone || phone.length > 32 || countryCode.length > 8) {
      throw new AppError("INVALID_LOGIN", "手机号或国家区号无效");
    }
    const sendPhoneCaptcha = this.options.musicProvider.sendPhoneCaptcha;
    if (!sendPhoneCaptcha) throw new AppError("MUSIC_AUTH_UNAVAILABLE", "手机登录功能不可用");
    await sendPhoneCaptcha.call(this.options.musicProvider, phone, countryCode);
    return { sent: true };
  }

  private async loginMusicWithPhone(
    connection: ConnectionRecord,
    payload: Extract<SongGuessrClientMessage, { type: "song.auth.phone.login" }>["payload"],
  ) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    const phone = payload.phone.trim();
    const password = payload.password;
    const captcha = payload.captcha?.trim();
    if (!phone || phone.length > 32 || (password && password.length > 256) || (captcha && captcha.length > 16)) {
      throw new AppError("INVALID_LOGIN", "手机登录信息无效");
    }
    if (Boolean(password) === Boolean(captcha)) {
      throw new AppError("INVALID_LOGIN", "密码和验证码必须且只能填写一项");
    }
    const loginWithPhone = this.options.musicProvider.loginWithPhone;
    if (!loginWithPhone) throw new AppError("MUSIC_AUTH_UNAVAILABLE", "手机登录功能不可用");
    const result = await loginWithPhone.call(this.options.musicProvider, {
      phone,
      countryCode: payload.countryCode?.trim() || "86",
      password,
      captcha,
    });
    const session = this.installMusicSession(room, player.id, result);
    this.touch(room);
    this.publishRoom(room);
    return session;
  }

  private async loginMusicWithEmail(
    connection: ConnectionRecord,
    emailValue: string,
    password: string,
  ) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    const email = emailValue.trim();
    if (!email || email.length > 254 || !password || password.length > 256) {
      throw new AppError("INVALID_LOGIN", "邮箱登录信息无效");
    }
    const loginWithEmail = this.options.musicProvider.loginWithEmail;
    if (!loginWithEmail) throw new AppError("MUSIC_AUTH_UNAVAILABLE", "邮箱登录功能不可用");
    const result = await loginWithEmail.call(this.options.musicProvider, email, password);
    const session = this.installMusicSession(room, player.id, result);
    this.touch(room);
    this.publishRoom(room);
    return session;
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
    };
    // 房间内只暂存调用音乐接口所需的 Cookie，不保留账号资料或登录凭据。
    room.musicSession = { ownerPlayerId, cookie };
    return { cookie, account };
  }

  private requireMusicCookie(value: string): string {
    const cookie = value.trim();
    if (!cookie || cookie.length > 16_384) {
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
    const count = clampInt(countValue ?? 1, 1, SONG_GUESSR_MAX_PLAYERS);
    const available = Math.max(0, SONG_GUESSR_MAX_PLAYERS - this.onlineCount(room));
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
    const count = clampInt(countValue ?? 1, 1, SONG_GUESSR_MAX_PLAYERS);
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

  private startGame(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (room.phase !== "waiting") {
      throw new AppError("INVALID_PHASE", "当前不能开始新游戏");
    }

    const activePlayers = this.activePlayers(room);
    if (activePlayers.length < 2) throw new AppError("NOT_ENOUGH_PLAYERS", "至少需要两名正式玩家");
    if (activePlayers.some((candidate) => !candidate.isReady)) {
      throw new AppError("PLAYERS_NOT_READY", "仍有玩家未准备");
    }

    room.phase = "choosingSubmitter";
    room.pendingSubmitterPlayerId = undefined;
    room.currentRound = undefined;
    room.roundSummary = undefined;
    room.finalScores = undefined;
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    this.log("song.game.started", room.id, player.id);
    return { started: true };
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

    const song = await this.options.musicProvider.getSong(songId, room.musicSession?.cookie);
    const lyricClip = createSongLyricClip(song.lyrics, room.settings.lyricsLineCount, this.random);
    const roundNumber = room.roundNumber + 1;
    const roundSettings = { ...room.settings };
    const participantStates = Object.fromEntries(
      this.activePlayers(room).map((candidate) => [
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
      submitterPlayerId: player.id,
      song,
      lyricClip,
      attempts: [],
      correctPlayerIds: [],
      startScores: Object.fromEntries(Object.values(room.players).map((candidate) => [candidate.id, candidate.score])),
      players: participantStates,
      settings: roundSettings,
    };
    room.pendingSubmitterPlayerId = undefined;
    room.phase = "playing";
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();

    if (this.isRoundComplete(room)) {
      this.finishRound(room);
      this.publishRoom(room);
    }
    return { roundNumber };
  }

  private audioReady(connection: ConnectionRecord, roundNumber: number) {
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireActiveRound(room);
    if (round.number !== roundNumber) throw new AppError("ROUND_MISMATCH", "回合编号不匹配");
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
      state.deadlineAt = this.now() + round.settings.guessDurationSeconds * 1_000;
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
    if (state.guessesUsed >= round.settings.maxGuessesPerRound) throw new AppError("NO_MORE_GUESSES", "本回合猜测次数已用完");

    if (state.deadlineAt !== undefined && state.deadlineAt <= this.now()) {
      this.recordTimeout(room, player.id);
      if (this.isRoundComplete(room)) this.finishRound(room);
      this.publishRoom(room);
      throw new AppError("GUESS_TIMEOUT", "本次猜测已经超时");
    }

    const guessedSong = await this.options.musicProvider.getSongMetadata(
      songId,
      room.musicSession?.cookie,
    );
    state.guessesUsed += 1;
    player.totalGuesses += 1;
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
      player.score += SCORING.correct;
      if (round.correctPlayerIds.length === 0) player.score += SCORING.firstCorrect;
      round.correctPlayerIds.push(player.id);
    } else if (state.guessesUsed < round.settings.maxGuessesPerRound) {
      state.deadlineAt = this.now() + round.settings.guessDurationSeconds * 1_000;
    } else {
      state.deadlineAt = undefined;
    }

    if ((correct && round.settings.endOnFirstCorrect) || this.isRoundComplete(room)) {
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

  private nextRound(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (room.phase !== "roundResult") throw new AppError("INVALID_PHASE", "当前不在回合结算阶段");
    room.phase = "choosingSubmitter";
    room.currentRound = undefined;
    room.roundSummary = undefined;
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
    for (const candidate of Object.values(room.players)) {
      if (candidate.membership !== "active") continue;
      candidate.isReady = candidate.id === room.hostPlayerId || candidate.isBot;
    }
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
    state.deadlineAt = state.guessesUsed < round.settings.maxGuessesPerRound
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
    return normalizeSongText(guess.title) === normalizeSongText(answer.title) &&
      normalizeSongText(guess.artist) === normalizeSongText(answer.artist);
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
        player.online &&
        (player.id !== round.submitterPlayerId || this.canTestSubmitterGuess(room, player.id)),
    );
    return guessers.every((player) => {
      const state = round.players[player.id];
      return !state || state.correct || state.gaveUp || state.guessesUsed >= round.settings.maxGuessesPerRound;
    });
  }

  private buildRoomSummary(room: SongGuessrRoomRecord): SongGuessrRoomSummary {
    return {
      roomId: room.id,
      name: room.name,
      visibility: room.visibility,
      allowSpectators: room.allowSpectators,
      hasPassword: Boolean(room.password),
      playerCount: this.activePlayers(room).length,
      onlineCount: this.onlineCount(room),
      maxPlayers: SONG_GUESSR_MAX_PLAYERS,
      phase: room.phase,
    };
  }

  private buildRoomSnapshot(room: SongGuessrRoomRecord): SongGuessrRoomSnapshot {
    const round = room.currentRound;
    return {
      roomId: room.id,
      name: room.name,
      visibility: room.visibility,
      allowSpectators: room.allowSpectators,
      hasPassword: Boolean(room.password),
      maxPlayers: SONG_GUESSR_MAX_PLAYERS,
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
              lyricClip: round.lyricClip,
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
  ): SongGuessrPlayerView {
    const round = room.currentRound;
    const state = round?.players[player.id];
    let roundStatus: SongGuessrPlayerView["roundStatus"] = "waiting";
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
  ): SongGuessrPrivateState {
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
      submittedSong: isSubmitter && round ? this.publicSong(round.song) : undefined,
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
  ): SongGuessrScore[] {
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

  private publishRoom(room: SongGuessrRoomRecord) {
    const snapshot = this.buildRoomSnapshot(room);
    for (const connection of this.connections.getRoomConnections(room.id)) {
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
      previous.send(createEvent("session.replaced", { roomId: room.id }));
      previous.roomId = undefined;
      previous.playerId = undefined;
      previous.close(4001, "session_replaced");
    }
    player.online = true;
    player.connectionId = connection.id;
    player.lastSeenAt = this.now();
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
    if (connection.roomId || connection.playerId) throw new AppError("ALREADY_IN_ROOM", "当前连接已在房间中");
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
    this.clearMusicSession(room);
    const next = Object.values(room.players)
      .filter((player) => player.online && player.membership === "active" && !player.isBot)
      .sort((left, right) => left.joinedAt - right.joinedAt)[0];
    if (next) {
      room.hostPlayerId = next.id;
      next.isReady = true;
    } else {
      room.hostPlayerId = "";
    }
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
