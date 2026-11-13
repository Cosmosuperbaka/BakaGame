import { NOOP_GAME_RECORDER } from "../../domain/GameRecord";
import { computeSongDifficulty, computeSongSubmitterScore } from "../../domain/SongRules";
import type {
  SonGuessrRoundMark,
  SonGuessrRoundSummary,
  SonGuessrScoreBreakdown,
  SongDetails,
  SongGuessFeedback,
} from "../../shared/Index";
import type { SonGuessrContext } from "./Context";
import {
  direction,
  type SonGuessrRoomRecord,
  type SonGuessrRoundPlayerState,
  type SonGuessrRoundRecord,
} from "./Records";
import { canTestSubmitterGuess } from "./RoomAccess";
import { isSameAnswerSong, normalizeSongText } from "./SongTitleMatching";

/**
 * 回合计分与结算记录：作答单元口径、用时占比、出题人得分与难度分、逐轮结局标记、
 * 对局记录与猜测反馈。只做计算与记录，不改回合流转；回合引擎在它之上。
 */

/**
 * 可作答的作答单元：出题人（测试房里出题人自己也能猜）、出题人的观战队友与人机都不算。
 * 计分的分母（正确率、血战排名、难度分）统一取自这里，不能再各自用 `activePlayers` 凑。
 *
 * 单元一经登记就留在分母里：已猜中的人随后离房或被清理，名次（分子）不会回退，
 * 分母若按结算时的在房成员重算就会小于名次，血战速度系数变负。口径与 CEE 的
 * 「血战分母冻结为开局实际猜题人数」一致；回合中途加入的玩家登记新单元时同样计入。
 */
export function answerableUnits(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  round: SonGuessrRoundRecord
): SonGuessrRoundPlayerState[] {
  const submitterState = round.players[round.submitterPlayerId];
  const submitterAnswers = canTestSubmitterGuess(ctx, room, round.submitterPlayerId);
  return [...new Set(Object.values(round.players))].filter(
    (unit) => !unit.bot && (submitterAnswers || unit !== submitterState)
  );
}

/** 用时占比：从「首名玩家能答题」起算，除以单次作答时限，夹到 0–1。 */
export function answerElapsedRatio(round: SonGuessrRoundRecord, at: number): number {
  const startedAt = round.answeringStartedAt ?? round.startedAt;
  const limitMs = round.settings.guessDurationSeconds * 1_000;
  if (limitMs <= 0) return 1;
  return Math.min(1, Math.max(0, (at - startedAt) / limitMs));
}

/**
 * 本轮结算：出题人得分与计分拆解。
 *
 * 难度分要先知道整轮的猜中率、平均尝试与平均用时，所以只能在这里算，
 * 不能像答题者那样随每次猜中即时入账。`answererBreakdown` 里已是逐人系数，
 * 这里只补平均用时与难度分，不在两处各算一遍。
 */
export function roundScoring(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  round: SonGuessrRoundRecord
): { submitterScore: number; breakdown?: SonGuessrScoreBreakdown } {
  const units = answerableUnits(ctx, room, round);
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
      return answerElapsedRatio(round, attempt?.createdAt ?? ctx.now());
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

/**
 * 给每个「本应作答」的玩家写入本轮结局标记。
 *
 * 出题人、其队友（本局观战）与旁观者不作答，因此不产生标记。
 * 结果取 `SonGuessrRoundMark` 枚举，不沿用猜猜呗的 emoji 标记串：那套是为兼容原版房
 */
export function appendRoundMarks(room: SonGuessrRoomRecord, round: SonGuessrRoundRecord): void {
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

/** 结算快照转成对局记录：摘要放答案与出题人，时间线为逐次猜测。 */
export function recordRound(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  round: SonGuessrRoundRecord,
  summary: SonGuessrRoundSummary,
  skipped: boolean
) {
  const nameOf = (playerId: string) => room.players[playerId]?.name ?? playerId;
  (ctx.options.gameRecorder ?? NOOP_GAME_RECORDER).record({
    game: "song",
    roomId: room.id,
    roomCreatedAt: room.createdAt,
    roundNumber: round.number,
    startedAt: round.startedAt,
    endedAt: ctx.now(),
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

export function buildFeedback(guess: SongDetails, answer: SongDetails): SongGuessFeedback {
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

export function isCorrectSong(guess: SongDetails, round: SonGuessrRoundRecord) {
  return isSameAnswerSong(guess, round.song, round.alternateSongIds ?? []);
}
