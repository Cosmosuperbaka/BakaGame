// ==================== 排位单局状态机（纯领域） ====================
// 不读时钟、不读全局随机：时间经 now 参数、随机经 random 参数传入。
import type { CEECharacterView, CEEFeedback, CEEGuess, CEESettings } from "../shared/CEE";
import {
  CEE_RANKED_COUNTDOWN_MS,
  CEE_RANKED_GAME_MS,
  CEE_RANKED_OVERTIME_ATTEMPTS,
  CEE_RANKED_OVERTIME_MS,
  type CEERankedGameEndReason,
  type CEERankedGamePhase,
  type CEERankedMaskedFeedback,
} from "../shared/CEERanked";
import { AppError } from "./Errors";
import { buildCEEFeedback, createCEEHints } from "./CEERules";

export type CEERankedSeatIndex = 0 | 1;
export interface CEERankedGameSeat {
  name: string;
  attempts: number;
  allowance: number;
  guesses: CEEGuess[];
  surrendered: boolean;
}
export interface CEERankedGame {
  number: number;
  settings: CEESettings;
  answer: CEECharacterView;
  phase: CEERankedGamePhase;
  startsAt: number;
  /** 读秒阶段即为常规时段截止（startsAt + 常规时长）；已结束为 null。 */
  deadlineAt: number | null;
  seats: [CEERankedGameSeat, CEERankedGameSeat];
  hints: string[];
  /** 建局时给定、进入加时才公开。 */
  overtimeHint: string;
  overtime: boolean;
  winner: CEERankedSeatIndex | null;
  endReason: CEERankedGameEndReason | null;
  endedAt: number | null;
}

const otherSeat = (seat: CEERankedSeatIndex): CEERankedSeatIndex => (seat === 0 ? 1 : 0);

function createGameSeat(name: string, allowance: number): CEERankedGameSeat {
  return { name, attempts: 0, allowance, guesses: [], surrendered: false };
}

export function createCEERankedGame(input: {
  number: number;
  settings: CEESettings;
  answer: CEECharacterView;
  names: [string, string];
  overtimeHint: string;
  now: number;
}): CEERankedGame {
  const startsAt = input.now + CEE_RANKED_COUNTDOWN_MS;
  return {
    number: input.number,
    settings: input.settings,
    answer: input.answer,
    phase: "countdown",
    startsAt,
    deadlineAt: startsAt + CEE_RANKED_GAME_MS,
    seats: [
      createGameSeat(input.names[0], input.settings.maxAttempts),
      createGameSeat(input.names[1], input.settings.maxAttempts),
    ],
    hints: [],
    overtimeHint: input.overtimeHint,
    overtime: false,
    winner: null,
    endReason: null,
    endedAt: null,
  };
}

export function ceeRankedGameSeatFinished(seat: CEERankedGameSeat): boolean {
  return seat.surrendered || seat.attempts >= seat.allowance;
}

function bothSeatsFinished(game: CEERankedGame): boolean {
  return ceeRankedGameSeatFinished(game.seats[0]) && ceeRankedGameSeatFinished(game.seats[1]);
}

function reachedDeadline(game: CEERankedGame, now: number): boolean {
  return game.deadlineAt !== null && now >= game.deadlineAt;
}

/** 推进时间驱动的阶段变化；有变化返回 true。一次调用允许连续推进多个阶段。 */
export function tickCEERankedGame(game: CEERankedGame, now: number): boolean {
  if (game.phase === "settled") return false;
  let changed = false;
  if (game.phase === "countdown" && now >= game.startsAt) {
    game.phase = "playing";
    changed = true;
  }
  if (game.phase === "playing" && (reachedDeadline(game, now) || bothSeatsFinished(game))) {
    game.phase = "overtime";
    game.overtime = true;
    // 认输席位不再获得加时次数：其所属对局在认输时已即时结算，这里只是防御性收口。
    for (const seat of game.seats)
      if (!seat.surrendered) seat.allowance += CEE_RANKED_OVERTIME_ATTEMPTS;
    game.deadlineAt = now + CEE_RANKED_OVERTIME_MS;
    game.hints.push(game.overtimeHint);
    changed = true;
  }
  if (game.phase === "overtime" && (reachedDeadline(game, now) || bothSeatsFinished(game))) {
    game.phase = "settled";
    game.winner = null;
    game.endReason = "draw";
    game.endedAt = now;
    game.deadlineAt = null;
    changed = true;
  }
  return changed;
}

export function applyCEERankedGuess(
  game: CEERankedGame,
  seat: CEERankedSeatIndex,
  character: CEECharacterView,
  now: number
): CEEGuess {
  tickCEERankedGame(game, now);
  if (game.phase !== "playing" && game.phase !== "overtime")
    throw new AppError("INVALID_PHASE", "当前不能猜测");
  const target = game.seats[seat];
  if (ceeRankedGameSeatFinished(target))
    throw new AppError("RANKED_ATTEMPTS_EXHAUSTED", "猜测次数已用完");
  if (target.guesses.some((guess) => guess.character.id === character.id))
    throw new AppError("RANKED_DUPLICATE_GUESS", "已经猜过这个角色");
  const correct = character.id === game.answer.id;
  const feedback = buildCEEFeedback(character, game.answer, game.settings);
  const guess: CEEGuess = {
    id: crypto.randomUUID(),
    playerId: `seat-${seat}`,
    playerName: target.name,
    character: {
      id: character.id,
      name: character.name,
      nameCn: character.nameCn,
      imageUrl: character.imageUrl,
    },
    correct,
    partial: !correct && feedback.sharedAppearances.length > 0,
    syncRound: 0,
    createdAt: now,
    feedback,
  };
  target.attempts += 1;
  target.guesses.push(guess);
  if (correct) {
    game.winner = seat;
    game.endReason = "solved";
    game.phase = "settled";
    game.endedAt = now;
    game.deadlineAt = null;
    return guess;
  }
  // 用尽最后一次的错误猜测要立刻推进阶段，不能等下一次 tick。
  tickCEERankedGame(game, now);
  return guess;
}

export function surrenderCEERankedGame(
  game: CEERankedGame,
  seat: CEERankedSeatIndex,
  now: number
): void {
  if (game.phase === "settled") throw new AppError("INVALID_PHASE", "本局已经结束");
  game.seats[seat].surrendered = true;
  game.winner = otherSeat(seat);
  game.endReason = "surrender";
  game.phase = "settled";
  game.endedAt = now;
  game.deadlineAt = null;
}

/** 加时提示：先取简介生成的一句，没有就退到最早登场年份，再没有就退到登场作品数。 */
export function ceeRankedOvertimeHint(answer: CEECharacterView, random: () => number): string {
  const [hint] = createCEEHints(answer.summary, 1, random);
  if (hint) return hint;
  if (answer.earliestAppearance > 0) return `答案最早登场于 ${answer.earliestAppearance} 年`;
  return `答案登场过 ${answer.appearances.length} 部作品`;
}

export function maskCEEFeedback(feedback: CEEFeedback): CEERankedMaskedFeedback {
  return {
    gender: feedback.gender.comparison,
    popularity: feedback.popularity.comparison,
    rating: feedback.rating.comparison,
    appearancesCount: feedback.appearancesCount.comparison,
    earliestAppearance: feedback.earliestAppearance.comparison,
    latestAppearance: feedback.latestAppearance.comparison,
    sharedAppearance: feedback.sharedAppearances.length > 0,
    tagMatched: feedback.tags.filter((tag) => tag.matched).length,
    tagTotal: feedback.tags.length,
  };
}
