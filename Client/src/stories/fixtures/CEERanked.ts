import type {
  CEEGuess,
  CEERankedGameSummary,
  CEERankedMaskedGuess,
  CEERankedProfile,
  CEERankedSeatView,
  CEERankedSeriesResult,
  CEERankedSeriesView,
  CEERankedState,
} from "@bakagame/shared";
import { CEE_CHARACTERS, ceeGuess, type CEECharacterKey } from "./CEE";
import { fromNow, STORY_EPOCH, STORY_PLAYERS } from "./Common";

// ==================== 排位故事假数据 ====================
// 只供 Storybook 与截图使用。对手猜测按服务端脱敏口径（只留比较符号与计数）现场压出来，
// 视图形状与 `ceeRankedSeriesView` 一致。

const [, ME] = STORY_PLAYERS;
const OPPONENT = { id: "seat-1", name: "团子" };

/** 与服务端 `maskCEEFeedback` 同口径：数值、角色与标签文字一律不留。 */
const mask = (guesses: CEEGuess[]): CEERankedMaskedGuess[] =>
  guesses.map((guess, index) => ({
    index: index + 1,
    correct: guess.correct,
    createdAt: guess.createdAt,
    feedback: {
      gender: guess.feedback.gender.comparison,
      popularity: guess.feedback.popularity.comparison,
      rating: guess.feedback.rating.comparison,
      appearancesCount: guess.feedback.appearancesCount.comparison,
      earliestAppearance: guess.feedback.earliestAppearance.comparison,
      latestAppearance: guess.feedback.latestAppearance.comparison,
      sharedAppearance: guess.feedback.sharedAppearances.length > 0,
      tagMatched: guess.feedback.tags.filter((tag) => tag.matched).length,
      tagTotal: guess.feedback.tags.length,
    },
  }));

const mine = (keys: CEECharacterKey[], answer: CEECharacterKey, start = 6) =>
  keys.map((character, index) =>
    ceeGuess({ player: ME, character, at: start + index * 14 }, answer)
  );
const theirs = (keys: CEECharacterKey[], answer: CEECharacterKey, start = 9) =>
  keys.map((character, index) =>
    ceeGuess({ player: OPPONENT, character, at: start + index * 17 }, answer)
  );

const seat = (patch: Partial<CEERankedSeatView>): CEERankedSeatView => ({
  name: ME.name,
  isBot: false,
  rating: 1532,
  placementPlayed: null,
  points: 0,
  attempts: 0,
  allowance: 10,
  finished: false,
  online: true,
  ...patch,
});

const botSeat = (patch: Partial<CEERankedSeatView> = {}): CEERankedSeatView =>
  seat({ name: OPPONENT.name, isBot: true, rating: null, ...patch });

/** 第 1 局：对手先猜中伊地知虹夏。 */
const GAME_ONE: CEERankedGameSummary = {
  number: 1,
  answer: CEE_CHARACTERS.nijika,
  winner: "opponent",
  reason: "solved",
  overtime: false,
  guesses: mine(["gojo", "hitori", "ikuyo"], "nijika"),
  opponentGuesses: theirs(["yui", "ryo", "nijika"], "nijika"),
};

/** 第 2 局：本人猜中后藤一里。 */
const GAME_TWO: CEERankedGameSummary = {
  number: 2,
  answer: CEE_CHARACTERS.hitori,
  winner: "self",
  reason: "solved",
  overtime: false,
  guesses: mine(["kikuri", "ikuyo", "hitori"], "hitori", 120),
  opponentGuesses: theirs(["mio", "gojo"], "hitori", 124),
};

/** 第 3 局：双方都没猜中，加时后平局。 */
const GAME_THREE: CEERankedGameSummary = {
  number: 3,
  answer: CEE_CHARACTERS.ryo,
  winner: null,
  reason: "draw",
  overtime: true,
  guesses: mine(["yui", "mio"], "ryo", 260),
  opponentGuesses: theirs(["gojo", "kikuri"], "ryo", 266),
};

const base = (patch: Partial<CEERankedSeriesView>): CEERankedSeriesView => ({
  seriesId: "story-series",
  tier: { id: "d2", name: "进阶" },
  phase: "playing",
  rated: true,
  self: seat({}),
  opponent: botSeat(),
  game: null,
  nextGameAt: null,
  games: [],
  result: null,
  ...patch,
});

export type RankedSeriesStage =
  | "countdown"
  | "playing"
  | "overtime"
  | "intermission"
  | "won"
  | "lost"
  | "drawn"
  | "pending"
  | "placementDone"
  | "placementProgress"
  | "unrated"
  | "failed";

const result = (patch: Partial<CEERankedSeriesResult>): CEERankedSeriesResult => ({
  outcome: "won",
  reason: "completed",
  settlement: "rated",
  ratingBefore: 1532,
  ratingAfter: 1547,
  placementPlayed: null,
  ...patch,
});

/** 各阶段的系列赛视图；时间相对故事运行时刻，读秒与时钟会真的走动。 */
export function rankedSeries(stage: RankedSeriesStage): CEERankedSeriesView {
  switch (stage) {
    case "countdown":
      return base({
        phase: "countdown",
        game: {
          number: 1,
          phase: "countdown",
          startsAt: fromNow(4_000),
          deadlineAt: fromNow(184_000),
          guesses: [],
          opponentGuesses: [],
          hints: [],
        },
      });
    case "playing": {
      const guesses = mine(["gojo", "ikuyo"], "hitori", 120);
      const opponent = theirs(["mio", "ryo", "kikuri"], "hitori", 124);
      return base({
        phase: "playing",
        self: seat({ points: 0, attempts: guesses.length }),
        opponent: botSeat({ points: 1, attempts: opponent.length }),
        games: [GAME_ONE],
        game: {
          number: 2,
          phase: "playing",
          startsAt: fromNow(-60_000),
          deadlineAt: fromNow(118_000),
          guesses,
          opponentGuesses: mask(opponent),
          hints: [],
        },
      });
    }
    case "overtime": {
      const guesses = mine(
        ["yui", "mio", "gojo", "kikuri", "ikuyo", "hitori", "nijika"],
        "ryo",
        260
      );
      const opponent = theirs(["gojo", "kikuri", "hitori", "ikuyo", "yui"], "ryo", 266);
      return base({
        phase: "overtime",
        self: seat({ points: 1, attempts: guesses.length, allowance: 12 }),
        opponent: botSeat({ points: 1, attempts: opponent.length, allowance: 12, online: true }),
        games: [GAME_ONE, GAME_TWO],
        game: {
          number: 3,
          phase: "overtime",
          startsAt: fromNow(-190_000),
          deadlineAt: fromNow(31_000),
          guesses,
          opponentGuesses: mask(opponent),
          hints: ["……乐队里负责贝斯……"],
        },
      });
    }
    case "intermission":
      return base({
        phase: "intermission",
        self: seat({ points: 0, attempts: 3 }),
        opponent: botSeat({ points: 1, attempts: 3 }),
        games: [GAME_ONE],
        nextGameAt: fromNow(8_000),
      });
    case "won":
      return base({
        phase: "settled",
        self: seat({ points: 2 }),
        opponent: botSeat({ points: 1 }),
        games: [GAME_ONE, GAME_TWO, { ...GAME_THREE, winner: "self", reason: "solved" }],
        result: result({}),
      });
    case "lost":
      return base({
        phase: "settled",
        self: seat({ points: 0 }),
        opponent: seat({ name: "凉宫同学", rating: 1588, points: 2 }),
        games: [GAME_ONE, { ...GAME_TWO, winner: "opponent" }],
        result: result({ outcome: "lost", ratingAfter: 1519 }),
      });
    case "drawn":
      return base({
        phase: "settled",
        self: seat({ points: 1.5 }),
        opponent: botSeat({ points: 1.5 }),
        games: [GAME_ONE, GAME_TWO, GAME_THREE],
        result: result({ outcome: "drawn", ratingAfter: 1533 }),
      });
    case "pending":
      return {
        ...rankedSeries("won"),
        result: result({ settlement: "pending", ratingBefore: null, ratingAfter: null }),
      };
    case "placementDone":
      return {
        ...rankedSeries("won"),
        self: seat({ points: 2, rating: null, placementPlayed: 4 }),
        result: result({ ratingBefore: null, ratingAfter: 1612, placementPlayed: 5 }),
      };
    case "placementProgress":
      return {
        ...rankedSeries("won"),
        self: seat({ points: 2, rating: null, placementPlayed: 2 }),
        result: result({ ratingBefore: null, ratingAfter: null, placementPlayed: 3 }),
      };
    case "unrated":
      return {
        ...rankedSeries("won"),
        rated: false,
        result: result({ settlement: "unrated", ratingBefore: null, ratingAfter: null }),
      };
    case "failed":
      return {
        ...rankedSeries("won"),
        result: result({ settlement: "failed", ratingBefore: null, ratingAfter: null }),
      };
  }
}

export const RANKED_IDLE_STATE: Extract<CEERankedState, { status: "idle" }> = { status: "idle" };

export const rankedQueuedState = (
  waitedMs: number
): Extract<CEERankedState, { status: "queued" }> => {
  const queuedAt = fromNow(-waitedMs);
  return {
    status: "queued",
    queuedAt,
    botAvailableAt: queuedAt + 10_000,
    botFallbackAt: queuedAt + 30_000,
    window: 150 + 50 * Math.floor(waitedMs / 5_000),
  };
};

const day = 86_400_000;

export function rankedProfile(kind: "placement" | "rated" | "empty"): CEERankedProfile {
  if (kind === "empty")
    return {
      rating: null,
      placementPlayed: 0,
      placementTotal: 5,
      seriesPlayed: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      botRatedToday: 0,
      botRatedLimit: 5,
      recent: [],
    };
  if (kind === "placement")
    return {
      ...rankedProfile("empty"),
      placementPlayed: 2,
      seriesPlayed: 2,
      wins: 1,
      losses: 1,
      recent: [
        {
          seriesId: "p2",
          endedAt: STORY_EPOCH - 600_000,
          tierId: "d1",
          opponentName: "阿稳",
          opponentIsBot: true,
          outcome: "lost",
          selfPoints: 1,
          opponentPoints: 2,
          ratingDelta: null,
          placement: true,
        },
        {
          seriesId: "p1",
          endedAt: STORY_EPOCH - 1_200_000,
          tierId: "d1",
          opponentName: "爱噶",
          opponentIsBot: true,
          outcome: "won",
          selfPoints: 2,
          opponentPoints: 0,
          ratingDelta: null,
          placement: true,
        },
      ],
    };
  return {
    rating: 1532,
    placementPlayed: 5,
    placementTotal: 5,
    seriesPlayed: 23,
    wins: 13,
    losses: 9,
    draws: 1,
    botRatedToday: 3,
    botRatedLimit: 5,
    recent: [
      {
        seriesId: "r3",
        endedAt: STORY_EPOCH - 900_000,
        tierId: "d3",
        opponentName: "凉宫同学",
        opponentIsBot: false,
        outcome: "won",
        selfPoints: 2,
        opponentPoints: 1,
        ratingDelta: 15,
        placement: false,
      },
      {
        seriesId: "r2",
        endedAt: STORY_EPOCH - day,
        tierId: "d2",
        opponentName: "夜猫",
        opponentIsBot: true,
        outcome: "drawn",
        selfPoints: 1.5,
        opponentPoints: 1.5,
        ratingDelta: 1,
        placement: false,
      },
      {
        seriesId: "r1",
        endedAt: STORY_EPOCH - 2 * day,
        tierId: "d2",
        opponentName: "名字很长很长的一位对手玩家",
        opponentIsBot: false,
        outcome: "lost",
        selfPoints: 0,
        opponentPoints: 2,
        ratingDelta: -12,
        placement: false,
      },
    ],
  };
}
