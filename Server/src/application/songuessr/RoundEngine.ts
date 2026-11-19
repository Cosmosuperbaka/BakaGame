import { computeSongAnswererFactors } from "../../domain/SongRules";
import { AppError } from "../../domain/Errors";
import type { BangumiSubjectDetails, SongDetails, SongGuessAttempt } from "../../shared/Index";
import { publishPrivateState, type SonGuessrContext } from "./Context";
import { withSongAccount } from "./MusicPool";
import { refreshRoundAudio } from "./MusicSongLoading";
import {
  AUDIO_READY_GRACE_MS,
  ROUND_HARD_TIMEOUT_MARGIN_S,
  type SonGuessrPlayerRecord,
  type SonGuessrRoomRecord,
  type SonGuessrRoundPlayerState,
  type SonGuessrRoundRecord,
} from "./Records";
import { buildScores, publicAnime, publicSong } from "./RoomViews";
import { activePlayers, canTestSubmitterGuess, type SongCommandAt } from "./RoomAccess";
import { ensureRoundPlayerState } from "./RoundParticipants";
import {
  answerableUnits,
  answerElapsedRatio,
  appendRoundMarks,
  buildFeedback,
  isCorrectSong,
  recordRound,
  roundScoring,
} from "./RoundScoring";

/**
 * 回合引擎：作答单元与截止时刻、猜测的同步占位与回滚、到期补结算、回合结算。
 * 猜歌、猜番、放弃、跳过、音频就绪与巡检的回合结算都落在这里，共用同一套作答单元规则；
 * 同队成员指向同一个作答状态对象，各函数只读写这一份，不另持拷贝。
 */

/** 一轮回合巡检的共享扫描状态：同一时刻与同一硬超时判定贯穿「补就绪」与「判超时」两步。 */
type RoundSweep = {
  room: SonGuessrRoomRecord;
  round: NonNullable<SonGuessrRoomRecord["currentRound"]>;
  currentTime: number;
  /** 硬超时只在巡检开始时判一次：`armRoundDeadlines` 会改写回合时限，事后重算会读到新值。 */
  isRoundHardExpired: boolean;
  units: Set<SonGuessrRoundPlayerState>;
};

/** 进行中的回合：先按人补音频就绪，再按作答单元判超时，最后按变化结算与广播。 */
export function settlePlayingRound(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  currentTime: number
): void {
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
  const armed = armExpiredAudioUnits(ctx, sweep);
  const timedOut = recordExpiredGuesses(ctx, sweep);
  const changed = armed || timedOut;

  if (changed || sweep.isRoundHardExpired) {
    if (isRoundComplete(ctx, room) || sweep.isRoundHardExpired) finishRound(ctx, room);
    ctx.publishRoom(room);
  }
}

/**
 * 音频就绪宽限期结束的补偿：仅强制置为就绪并启动答题计时，绝不能当作「答题超时」扣除猜测配额。
 * 收下的作答单元交给 `recordExpiredGuesses` 判超时 —— 同队共用一份限时，逐人判会让一次超时扣好几遍。
 */
function armExpiredAudioUnits(ctx: SonGuessrContext, sweep: RoundSweep): boolean {
  const { room, round, currentTime } = sweep;
  const audioReadyDeadlineAt = round.audioReadyDeadlineAt ?? round.audioPreparationDeadlineAt;
  let changed = false;
  for (const [playerId, state] of Object.entries(round.players)) {
    if (playerId === round.submitterPlayerId && !canTestSubmitterGuess(ctx, room, playerId)) {
      continue;
    }
    if (isUnitFinished(round, state)) continue;

    if (!round.audioReady[playerId] && currentTime >= audioReadyDeadlineAt) {
      armRoundDeadlines(ctx, room);
      round.audioReady[playerId] = true;
      // 宽限期本身就晚于锚点 15 秒，这里的倒计时必须重新起算，
      // 不能再用 audioReadyDeadlineAt —— 那样会立刻得到一个已过期的截止时刻，
      // 下一轮巡检就把补偿出来的答题时间又当成超时收走。队友先就绪时全队计时已在走，不重开。
      if (state.deadlineAt === undefined) restartGuessDeadline(ctx, room, state);
      changed = true;
    }
    sweep.units.add(state);
  }
  return changed;
}

/** 按作答单元判答题超时；in-flight 的猜测由回源流程自己结算，硬超时除外。 */
function recordExpiredGuesses(ctx: SonGuessrContext, sweep: RoundSweep): boolean {
  let changed = false;
  for (const state of sweep.units) {
    // 上游正在校验这次猜测（占位已扣、结果未回）：超时由 in-flight 流程自己判定。
    // 巡检在这里抢先记一次 timeout，会让一次真实猜测扣掉两次配额，
    // 并在 attempts 里留下「timeout + wrong/correct」两条互相矛盾的记录。
    // 例外保留：硬超时必须仍然强制结算，否则一次卡死的 in-flight 会拖住整个回合。
    if (state.inFlight && !sweep.isRoundHardExpired) continue;
    const isGuessTimeout = state.deadlineAt !== undefined && state.deadlineAt <= sweep.currentTime;
    if (isGuessTimeout || sweep.isRoundHardExpired) {
      recordTimeout(ctx, sweep.room, state);
      changed = true;
    }
  }
  return changed;
}

/**
 * 首名玩家真正具备答题条件时，才锚定本回合的「音频就绪宽限期」与「硬截止」。
 * 幂等：同一回合只锚定一次，后续玩家就绪不会顺延其他玩家的倒计时。
 */
function armRoundDeadlines(ctx: SonGuessrContext, room: SonGuessrRoomRecord) {
  const round = room.currentRound;
  if (!round || round.hardDeadlineAt !== undefined) return;
  const now = ctx.now();
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

export function audioReady(ctx: SonGuessrContext, at: SongCommandAt, roundNumber: number) {
  const { room, seat: player } = at;
  // 页面切后台/重连时可能补发旧回合的 ready；状态过渡期间应幂等忽略，
  // 不把一个正常的陈旧通知显示成「当前没有进行中的回合」。
  if (room.phase !== "playing" || !room.currentRound || room.runtime?.automaticRoundLoading) {
    return { ignored: true };
  }
  const round = room.currentRound;
  if (round.number !== roundNumber) return { ignored: true };
  const state = ensureRoundPlayerState(ctx, room, player) ?? round.players[player.id];
  if (
    !state ||
    (player.id === round.submitterPlayerId && !canTestSubmitterGuess(ctx, room, player.id)) ||
    player.membership !== "active"
  ) {
    return { ignored: true };
  }
  if (!round.audioReady[player.id] && !isUnitFinished(round, state)) {
    // 首个就绪的玩家定义本回合的倒计时起点；此时才锚定硬截止。
    armRoundDeadlines(ctx, room);
    round.audioReady[player.id] = true;
    // 必须用「当前时刻」起算，不能复用本回合统一的 audioReadyDeadlineAt：
    // 自动选曲会占用数秒到数十秒，用旧锚点会得到一个可能已过期的截止时刻，
    // 巡检随即把它当成答题超时，玩家还没数到 0 就被判超时。
    // 队伍共用一份限时：队友先就绪时计时已经开始，不再重开。
    if (state.deadlineAt === undefined) restartGuessDeadline(ctx, room, state);
  }
  ctx.touch(room);
  // 全队的截止时刻可能刚起算，队友的私有状态一并刷新。
  for (const memberId of state.memberIds) {
    const member = room.players[memberId];
    if (member) publishPrivateState(ctx, room, member);
  }
  return { deadlineAt: state.deadlineAt };
}

export async function audioFailed(ctx: SonGuessrContext, at: SongCommandAt, roundNumber: number) {
  const { connection, room, seat: player } = at;
  const round = room.currentRound;
  if (room.phase !== "playing" || !round || round.number !== roundNumber) return { ignored: true };
  if (
    player.membership !== "active" ||
    (player.id === round.submitterPlayerId && !canTestSubmitterGuess(ctx, room, player.id))
  ) {
    return { ignored: true };
  }
  // 刷新播放地址同样命中那个共享的上游实例，必须一起计入配额。
  if (!ctx.musicLimiter.allow(connection.id, ctx.now())) {
    throw new AppError("RATE_LIMITED", "音乐请求过于频繁，请稍后再试");
  }
  const provider = ctx.options.musicProvider;
  const refresh = provider.refreshSongAudio?.bind(provider);
  if (!refresh) throw new AppError("MUSIC_API_UNAVAILABLE", "当前音乐 API 不支持刷新播放地址");
  const audioUrl = await refreshRoundAudio(ctx, room, round, refresh);
  if (room.phase !== "playing" || room.currentRound !== round) return { ignored: true };
  round.song = { ...round.song, audioUrl };
  ctx.touch(room);
  ctx.publishRoom(room);
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
function settleExpiredGuessWindow(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  state: SonGuessrRoundPlayerState
) {
  const round = room.currentRound;
  if (!round) return;
  const now = ctx.now();
  if (round.hardDeadlineAt !== undefined && now >= round.hardDeadlineAt) {
    settlePlayingRound(ctx, room, now);
    return;
  }
  if (state.deadlineAt === undefined || state.deadlineAt > now) return;
  recordTimeout(ctx, room, state);
  if (isRoundComplete(ctx, room)) finishRound(ctx, room);
  ctx.touch(room);
  ctx.publishRoom(room);
}

/** 关键修复：在让出事件循环前先占位自增并加锁，防止并发穿透配额上限。 */
function beginGuessAttempt(state: SonGuessrRoundPlayerState, player: SonGuessrPlayerRecord) {
  state.inFlight = true;
  state.guessesUsed += 1;
  player.totalGuesses += 1;
}

/** 上游查询失败只回滚本回合的占位：回合已切换时计数归入上一局，不再改动。 */
function rollbackGuessAttempt(
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
function requireGuessStillCurrent(
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

/** 猜中计分，猜错则续期下一次猜测的倒计时。 */
function settleGuessResult(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  round: SonGuessrRoundRecord,
  player: SonGuessrPlayerRecord,
  state: SonGuessrRoundPlayerState,
  correct: boolean
) {
  if (!correct) {
    restartGuessDeadline(ctx, room, state);
    return;
  }
  state.correct = true;
  state.deadlineAt = undefined;
  player.correctGuesses += 1;
  const factors = computeSongAnswererFactors({
    bloodMode: round.settings.bloodMode,
    // 每队只有一位猜中者进 correctPlayerIds，名次即本单元的抢答顺序。
    rank: round.correctPlayerIds.length + 1,
    answerableCount: answerableUnits(ctx, room, round).length,
    elapsedRatio: answerElapsedRatio(round, ctx.now()),
    guessesUsed: state.guessesUsed,
    maxGuessesPerRound: round.settings.maxGuessesPerRound,
  });
  player.score += factors.score;
  round.answererBreakdown.push({ playerId: player.id, ...factors });
  round.correctPlayerIds.push(player.id);
}

export async function guess(ctx: SonGuessrContext, at: SongCommandAt, songId: string) {
  const { room, seat: player } = at;
  const round = requireActiveRound(room);
  // 猜番回合的答案是番剧，不是歌：用猜歌命令认出出题歌曲就会绕过猜番。按回合本身判定题型。
  if (round.settings.questionType !== "song" || round.anime) {
    throw new AppError("INVALID_QUESTION_TYPE", "当前房间是听歌猜番模式");
  }
  if (player.membership !== "active") throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能猜歌");
  const state = ensureRoundPlayerState(ctx, room, player) ?? round.players[player.id];
  if (player.id === round.submitterPlayerId && !canTestSubmitterGuess(ctx, room, player.id)) {
    throw new AppError("SUBMITTER_CANNOT_GUESS", "出题人不能参与猜歌");
  }
  if (round.observerIds.includes(player.id))
    throw new AppError("TEAM_OBSERVER", "队友出题，你本局观战");
  if (!state) throw new AppError("SPECTATOR_FORBIDDEN", "你本局不参与猜歌");
  if (!round.audioReady[player.id]) throw new AppError("AUDIO_NOT_READY", "音频尚未准备完成");
  ensureUnitOpen(round, state, player.id);
  settleExpiredGuessWindow(ctx, room, state);
  if (room.phase !== "playing" || room.currentRound !== round) {
    throw new AppError("ROUND_EXPIRED", "该回合已结束");
  }
  // 补记的超时可能正好用掉最后一次机会，必须按结算后的状态重新校验。
  ensureUnitOpen(round, state, player.id);
  beginGuessAttempt(state, player);

  let guessedSong: SongDetails;
  try {
    guessedSong = await withSongAccount(ctx, room, songId, (cookie) =>
      ctx.options.musicProvider.getSongMetadata(songId, cookie)
    );
  } catch (error) {
    rollbackGuessAttempt(room, round, player, state);
    throw error;
  }

  // 异步返回后复验房间与回合状态
  requireGuessStillCurrent(room, round, player, state);
  const correct = isCorrectSong(guessedSong, round);
  const attempt: SongGuessAttempt = {
    id: ctx.ids.next("song_guess"),
    playerId: player.id,
    playerName: player.name,
    guessNumber: state.guessesUsed,
    createdAt: ctx.now(),
    result: correct ? "correct" : "wrong",
    guessedSong: publicSong(guessedSong),
    feedback: buildFeedback(guessedSong, round.song),
  };
  round.attempts.push(attempt);

  settleGuessResult(ctx, room, round, player, state, correct);

  if (isRoundComplete(ctx, room)) {
    finishRound(ctx, room);
  }
  ctx.touch(room);
  ctx.publishRoom(room);
  return {
    attempt,
    remainingGuesses: Math.max(0, round.settings.maxGuessesPerRound - state.guessesUsed),
  };
}

export async function guessAnime(ctx: SonGuessrContext, at: SongCommandAt, subjectId: string) {
  const { room, seat: player } = at;
  const round = requireActiveRound(room);
  if (room.settings.questionType !== "anime" || !round.anime) {
    throw new AppError("INVALID_QUESTION_TYPE", "当前房间不是听歌猜番模式");
  }
  if (round.observerIds.includes(player.id))
    throw new AppError("TEAM_OBSERVER", "队友出题，你本局观战");
  const state = ensureRoundPlayerState(ctx, room, player) ?? round.players[player.id];
  if (!state || player.membership !== "active")
    throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能猜番");
  if (player.id === round.submitterPlayerId && !canTestSubmitterGuess(ctx, room, player.id)) {
    throw new AppError("SUBMITTER_CANNOT_GUESS", "出题人不能参与猜番");
  }
  if (!round.audioReady[player.id]) throw new AppError("AUDIO_NOT_READY", "音频尚未准备完成");
  ensureUnitOpen(round, state, player.id);
  settleExpiredGuessWindow(ctx, room, state);
  if (room.phase !== "playing" || room.currentRound !== round) {
    throw new AppError("ROUND_EXPIRED", "该回合已结束");
  }
  // 补记的超时可能正好用掉最后一次机会，必须按结算后的状态重新校验。
  ensureUnitOpen(round, state, player.id);

  const provider = ctx.options.bangumiProvider;
  if (!provider) throw new AppError("BANGUMI_API_UNAVAILABLE", "当前未配置 Bangumi 接口");
  beginGuessAttempt(state, player);
  let guessedAnime: BangumiSubjectDetails;
  try {
    guessedAnime = await provider.getSubject(subjectId);
  } catch (error) {
    rollbackGuessAttempt(room, round, player, state);
    throw error;
  }
  requireGuessStillCurrent(room, round, player, state);
  const correct = guessedAnime.id === round.anime.id;
  const attempt: SongGuessAttempt = {
    id: ctx.ids.next("song_guess"),
    playerId: player.id,
    playerName: player.name,
    guessNumber: state.guessesUsed,
    createdAt: ctx.now(),
    result: correct ? "correct" : "wrong",
    guessedAnime: publicAnime(guessedAnime),
  };
  round.attempts.push(attempt);
  settleGuessResult(ctx, room, round, player, state, correct);
  if (isRoundComplete(ctx, room)) finishRound(ctx, room);
  ctx.touch(room);
  ctx.publishRoom(room);
  return {
    attempt,
    remainingGuesses: Math.max(0, round.settings.maxGuessesPerRound - state.guessesUsed),
  };
}

export function giveUp(ctx: SonGuessrContext, at: SongCommandAt) {
  const { room, seat: player } = at;
  const round = requireActiveRound(room);
  const state = ensureRoundPlayerState(ctx, room, player) ?? round.players[player.id];
  if (!state || player.membership !== "active") {
    throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能执行猜歌操作");
  }
  if (player.id === round.submitterPlayerId && !canTestSubmitterGuess(ctx, room, player.id)) {
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
    id: ctx.ids.next("song_guess"),
    playerId: player.id,
    playerName: player.name,
    guessNumber: state.guessesUsed + 1,
    createdAt: ctx.now(),
    result: "gaveUp",
  });
  if (isRoundComplete(ctx, room)) finishRound(ctx, room);
  ctx.touch(room);
  ctx.publishRoom(room);
  return { gaveUp: true };
}

export function skipRound(ctx: SonGuessrContext, at: SongCommandAt) {
  const { room } = at;
  requireActiveRound(room);
  // 跳过不参与结算：出题人拿不到任何奖励，避免「选出题人 → 立刻跳过」的零成本刷分。
  finishRound(ctx, room, true);
  ctx.publishRoom(room);
  ctx.publishLobby();
  return { skipped: true };
}

/**
 * 记一次超时。队伍与 CEE 同口径：按当时在线的队员人数扣次数（不超过剩余次数），每人记一条；
 * 无人在线时（含个人掉线）仍扣一次，记在第一位队员名下，回合不会因为掉线卡住。
 */
function recordTimeout(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  state: SonGuessrRoundPlayerState
) {
  const round = room.currentRound;
  if (!round || isUnitFinished(round, state)) return;
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
      id: ctx.ids.next("song_guess"),
      playerId,
      playerName: player.name,
      guessNumber: state.guessesUsed,
      createdAt: ctx.now(),
      result: "timeout",
    });
  }
  restartGuessDeadline(ctx, room, state);
}

/** 作答单元已结束：猜中、放弃或次数用尽。 */
function isUnitFinished(round: SonGuessrRoundRecord, state: SonGuessrRoundPlayerState) {
  return state.correct || state.gaveUp || state.guessesUsed >= round.settings.maxGuessesPerRound;
}

/** 猜歌、猜番共用的单元检查；队伍里的提示写「本队」，免得队友以为是自己点过。 */
function ensureUnitOpen(
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

/**
 * 重开一次猜测倒计时。倒计时的锚点必须永远取「当前时刻」，且不得超过回合硬截止：
 * 用旧锚点（如本回合统一的 audioReadyDeadlineAt）续期，会得到一个可能已经过期的时刻，
 * 巡检随即把它当成一次「答题超时」——玩家的倒计时还没归零就被判超时，
 * 或者归零后要等下一轮 10 秒巡检才真正结算。
 */
function restartGuessDeadline(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  state: SonGuessrRoundPlayerState
) {
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
  const deadlineAt = ctx.now() + round.settings.guessDurationSeconds * 1_000;
  // 单次猜测的倒计时绝不能越过回合硬截止，否则玩家的可见倒计时会长于真实剩余时间：
  // 界面显示还剩数十秒，房间却已经强制结算。
  state.deadlineAt =
    round.hardDeadlineAt === undefined ? deadlineAt : Math.min(deadlineAt, round.hardDeadlineAt);
}

/**
 * @param skipped 房主直接跳过本回合。跳过不是「无人猜中」，
 *   而是「这一轮没有真正发生过」，因此不计出题人奖励 ——
 *   否则房主反复「选出题人 → 立刻跳过」就能零成本刷分。
 */
export function finishRound(ctx: SonGuessrContext, room: SonGuessrRoomRecord, skipped = false) {
  const round = room.currentRound;
  if (!round || room.phase !== "playing") return;
  const submitter = room.players[round.submitterPlayerId];
  const scoring = roundScoring(ctx, room, round);
  if (submitter && !skipped) submitter.score += scoring.submitterScore;

  for (const state of Object.values(round.players)) state.deadlineAt = undefined;
  appendRoundMarks(room, round);
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
    scores: buildScores(ctx, room, round.startScores),
    ...(scoring.breakdown ? { breakdown: scoring.breakdown } : {}),
  };
  room.phase = "roundResult";
  recordRound(ctx, room, round, room.roundSummary, skipped);
  ctx.touch(room);
  ctx.log("song.game.round_finished", room.id, round.submitterPlayerId, {
    roundNumber: round.number,
    correctCount: round.correctPlayerIds.length,
  });
}

export function isRoundComplete(ctx: SonGuessrContext, room: SonGuessrRoomRecord) {
  const round = room.currentRound;
  if (!round) return false;
  // 关掉血战时，第一个猜中就把本局结束：其余人不再继续作答，也没有名次可争。
  if (!round.settings.bloodMode && round.correctPlayerIds.length > 0) return true;
  const guessers = activePlayers(room).filter(
    (player) =>
      (player.id !== round.submitterPlayerId || canTestSubmitterGuess(ctx, room, player.id)) &&
      !round.observerIds.includes(player.id)
  );
  return guessers.every((player) => {
    const state = round.players[player.id];
    return !state || isUnitFinished(round, state);
  });
}

function requireActiveRound(room: SonGuessrRoomRecord) {
  if (room.phase !== "playing" || !room.currentRound) {
    throw new AppError("NO_ACTIVE_ROUND", "当前没有进行中的回合");
  }
  return room.currentRound;
}
