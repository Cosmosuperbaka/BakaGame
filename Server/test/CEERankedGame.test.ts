import { describe, expect, it } from "bun:test";
import type { CEECharacterView } from "../src/shared/CEE";
import {
  CEE_RANKED_COUNTDOWN_MS,
  CEE_RANKED_GAME_MS,
  CEE_RANKED_OVERTIME_ATTEMPTS,
  CEE_RANKED_OVERTIME_MS,
  CEE_RANKED_TIERS,
  createCEERankedSettings,
} from "../src/shared/CEERanked";
import {
  applyCEERankedGuess,
  ceeRankedGameSeatFinished,
  ceeRankedOvertimeHint,
  createCEERankedGame,
  maskCEEFeedback,
  surrenderCEERankedGame,
  tickCEERankedGame,
  type CEERankedGame,
} from "../src/domain/CEERankedGame";
import { buildCEEFeedback } from "../src/domain/CEERules";
import { AppError } from "../src/domain/Errors";

const settings = createCEERankedSettings(CEE_RANKED_TIERS[0]);

const view = (overrides: Partial<CEECharacterView> = {}): CEECharacterView => ({
  id: 1,
  name: "角色1",
  nameCn: "角色1",
  gender: "female",
  popularity: 100,
  summary: "",
  appearances: [
    { id: 11, name: "作品甲", nameCn: "作品甲", year: 2020, rating: 8, ratingCount: 100 },
  ],
  highestRating: 8,
  earliestAppearance: 2020,
  latestAppearance: 2020,
  subjectTags: ["校园"],
  characterTags: ["黑发"],
  voiceActors: ["声优甲"],
  metaTags: [],
  comparisonAppearances: [{ id: 11, name: "作品甲", nameCn: "作品甲" }],
  extraTags: [],
  ...overrides,
});

const newGame = (now = 0): CEERankedGame =>
  createCEERankedGame({
    number: 1,
    settings,
    answer: view({ id: 777001, name: "答案角色", nameCn: "答案角色" }),
    names: ["甲", "乙"],
    overtimeHint: "加时提示",
    now,
  });

/** 断言抛出指定 code 与消息的 AppError。 */
const expectAppError = (action: () => unknown, code: string, message: string): void => {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AppError);
  expect((thrown as AppError).code).toBe(code);
  expect((thrown as AppError).message).toBe(message);
};

describe("排位单局：创建与阶段推进", () => {
  it("创建后进入读秒，字段按规则初始化", () => {
    const game = newGame(1_000);
    expect(game.number).toBe(1);
    expect(game.phase).toBe("countdown");
    expect(game.startsAt).toBe(1_000 + CEE_RANKED_COUNTDOWN_MS);
    expect(game.deadlineAt).toBe(1_000 + CEE_RANKED_COUNTDOWN_MS + CEE_RANKED_GAME_MS);
    for (const seat of game.seats) {
      expect(seat.attempts).toBe(0);
      expect(seat.allowance).toBe(settings.maxAttempts);
      expect(seat.guesses).toEqual([]);
      expect(seat.surrendered).toBe(false);
    }
    expect(game.overtime).toBe(false);
    expect(game.hints).toEqual([]);
    expect(game.winner).toBeNull();
    expect(game.endReason).toBeNull();
    expect(game.endedAt).toBeNull();
  });

  it("读秒未满不推进，读秒到点切到 playing", () => {
    const game = newGame(0);
    expect(tickCEERankedGame(game, game.startsAt - 1)).toBe(false);
    expect(game.phase).toBe("countdown");
    expect(tickCEERankedGame(game, game.startsAt)).toBe(true);
    expect(game.phase).toBe("playing");
  });

  it("常规时段到点进加时：未认输席位追加次数、公开提示、重设截止", () => {
    const game = newGame(0);
    tickCEERankedGame(game, game.startsAt);
    const overtimeAt = game.startsAt + CEE_RANKED_GAME_MS;
    expect(tickCEERankedGame(game, overtimeAt)).toBe(true);
    expect(game.phase).toBe("overtime");
    expect(game.overtime).toBe(true);
    for (const seat of game.seats)
      expect(seat.allowance).toBe(settings.maxAttempts + CEE_RANKED_OVERTIME_ATTEMPTS);
    expect(game.deadlineAt).toBe(overtimeAt + CEE_RANKED_OVERTIME_MS);
    expect(game.hints).toEqual(["加时提示"]);
  });

  it("两席都用尽时即使未到截止也立刻进加时", () => {
    const game = newGame(0);
    tickCEERankedGame(game, game.startsAt);
    game.seats[0].attempts = game.seats[0].allowance;
    game.seats[1].attempts = game.seats[1].allowance;
    expect(tickCEERankedGame(game, game.startsAt + 1_000)).toBe(true);
    expect(game.phase).toBe("overtime");
  });

  it("加时到点判平局并结算", () => {
    const game = newGame(0);
    tickCEERankedGame(game, game.startsAt);
    tickCEERankedGame(game, game.startsAt + CEE_RANKED_GAME_MS);
    const drawAt = game.startsAt + CEE_RANKED_GAME_MS + CEE_RANKED_OVERTIME_MS;
    expect(tickCEERankedGame(game, drawAt)).toBe(true);
    expect(game.phase).toBe("settled");
    expect(game.winner).toBeNull();
    expect(game.endReason).toBe("draw");
    expect(game.endedAt).toBe(drawAt);
    expect(game.deadlineAt).toBeNull();
  });

  it("一次 tick 允许连续跨越多个阶段", () => {
    const game = newGame(0);
    // 直接跳到常规截止之后：countdown→playing→overtime 一次完成，加时截止从本次 now 起算。
    const now = game.startsAt + CEE_RANKED_GAME_MS;
    expect(tickCEERankedGame(game, now)).toBe(true);
    expect(game.phase).toBe("overtime");
    expect(game.deadlineAt).toBe(now + CEE_RANKED_OVERTIME_MS);
    expect(tickCEERankedGame(game, now - 1)).toBe(false);
  });

  it("结算后 tick 不再变化", () => {
    const game = newGame(0);
    surrenderCEERankedGame(game, 0, 1_000);
    expect(tickCEERankedGame(game, 10 ** 12)).toBe(false);
    expect(game.phase).toBe("settled");
  });

  it("席位结束判定：认输或用尽次数", () => {
    const seat = gameSeat();
    expect(ceeRankedGameSeatFinished(seat)).toBe(false);
    seat.attempts = seat.allowance;
    expect(ceeRankedGameSeatFinished(seat)).toBe(true);
    const other = gameSeat();
    other.surrendered = true;
    expect(ceeRankedGameSeatFinished(other)).toBe(true);
  });
});

const gameSeat = () => {
  const game = newGame(0);
  return structuredClone(game.seats[0]);
};

describe("排位单局：加时提示", () => {
  it("有简介时取简介生成的句子", () => {
    const hint = ceeRankedOvertimeHint(view({ summary: "少女在都市长大。她成为侦探。" }), () => 0);
    expect(hint).toBe("……少女在都市长大……");
  });
  it("简介为空时退到最早登场年份", () => {
    expect(ceeRankedOvertimeHint(view({ summary: "", earliestAppearance: 1998 }), () => 0)).toBe(
      "答案最早登场于 1998 年"
    );
  });
  it("年份也未知时退到登场作品数", () => {
    const answer = view({
      summary: "",
      earliestAppearance: -1,
      appearances: [
        { id: 11, name: "作品甲", nameCn: "作品甲", year: 2020, rating: 8, ratingCount: 100 },
        { id: 12, name: "作品乙", nameCn: "作品乙", year: 2021, rating: 7, ratingCount: 50 },
      ],
    });
    expect(ceeRankedOvertimeHint(answer, () => 0)).toBe("答案登场过 2 部作品");
  });
});

describe("排位单局：猜测", () => {
  const playable = (): CEERankedGame => {
    const game = newGame(0);
    tickCEERankedGame(game, game.startsAt);
    return game;
  };

  it("读秒阶段猜测被拒", () => {
    const game = newGame(0);
    expectAppError(
      () => applyCEERankedGuess(game, 0, view({ id: 2 }), 0),
      "INVALID_PHASE",
      "当前不能猜测"
    );
  });

  it("猜中即结算：胜者、原因与猜测记录口径", () => {
    const game = playable();
    const now = game.startsAt + 10_000;
    const guess = applyCEERankedGuess(game, 0, game.answer, now);
    expect(guess.correct).toBe(true);
    expect(guess.partial).toBe(false);
    expect(guess.playerId).toBe("seat-0");
    expect(guess.playerName).toBe("甲");
    expect(guess.syncRound).toBe(0);
    expect(guess.createdAt).toBe(now);
    expect(guess.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(guess.character).sort()).toEqual(["id", "imageUrl", "name", "nameCn"]);
    expect(guess.feedback).toEqual(buildCEEFeedback(game.answer, game.answer, settings));
    expect(game.winner).toBe(0);
    expect(game.endReason).toBe("solved");
    expect(game.phase).toBe("settled");
    expect(game.endedAt).toBe(now);
    expect(game.deadlineAt).toBeNull();
    expect(game.seats[0].attempts).toBe(1);
    expect(game.seats[0].guesses).toEqual([guess]);
  });

  it("未猜中按共同作品记 partial 与 no", () => {
    const game = playable();
    const shared = applyCEERankedGuess(game, 0, view({ id: 2 }), game.startsAt + 1_000);
    expect(shared.correct).toBe(false);
    expect(shared.partial).toBe(true);
    const noShared = applyCEERankedGuess(
      game,
      1,
      view({
        id: 3,
        appearances: [
          { id: 12, name: "作品乙", nameCn: "作品乙", year: 2021, rating: 7, ratingCount: 5 },
        ],
        comparisonAppearances: [{ id: 12, name: "作品乙", nameCn: "作品乙" }],
      }),
      game.startsAt + 2_000
    );
    expect(noShared.partial).toBe(false);
  });

  it("重复猜同一角色被拒且不扣次数", () => {
    const game = playable();
    applyCEERankedGuess(game, 0, view({ id: 2 }), game.startsAt + 1_000);
    expectAppError(
      () => applyCEERankedGuess(game, 0, view({ id: 2 }), game.startsAt + 2_000),
      "RANKED_DUPLICATE_GUESS",
      "已经猜过这个角色"
    );
    expect(game.seats[0].attempts).toBe(1);
    expect(game.seats[0].guesses.length).toBe(1);
  });

  it("次数用尽的席位再猜被拒", () => {
    const game = playable();
    game.seats[0].attempts = game.seats[0].allowance;
    expectAppError(
      () => applyCEERankedGuess(game, 0, view({ id: 2 }), game.startsAt + 1_000),
      "RANKED_ATTEMPTS_EXHAUSTED",
      "猜测次数已用完"
    );
  });

  it("最后一次错误猜测用尽两席时立刻推进到加时", () => {
    const game = playable();
    game.seats[0].attempts = game.seats[0].allowance - 1;
    game.seats[1].attempts = game.seats[1].allowance - 1;
    applyCEERankedGuess(game, 0, view({ id: 2 }), game.startsAt + 1_000);
    expect(game.phase).toBe("playing");
    applyCEERankedGuess(game, 1, view({ id: 3 }), game.startsAt + 2_000);
    expect(game.phase).toBe("overtime");
    expect(game.overtime).toBe(true);
  });
});

describe("排位单局：认输", () => {
  it("playing 阶段认输判对方胜", () => {
    const game = newGame(0);
    tickCEERankedGame(game, game.startsAt);
    surrenderCEERankedGame(game, 1, game.startsAt + 5_000);
    expect(game.seats[1].surrendered).toBe(true);
    expect(game.winner).toBe(0);
    expect(game.endReason).toBe("surrender");
    expect(game.phase).toBe("settled");
    expect(game.endedAt).toBe(game.startsAt + 5_000);
    expect(game.deadlineAt).toBeNull();
  });

  it("读秒阶段也可以认输", () => {
    const game = newGame(0);
    surrenderCEERankedGame(game, 0, 1_000);
    expect(game.winner).toBe(1);
    expect(game.phase).toBe("settled");
  });

  it("结算后再认输被拒", () => {
    const game = newGame(0);
    surrenderCEERankedGame(game, 0, 1_000);
    expectAppError(() => surrenderCEERankedGame(game, 1, 2_000), "INVALID_PHASE", "本局已经结束");
  });
});

describe("排位单局：反馈脱敏", () => {
  it("掩码结果字段集合与取值精确", () => {
    const answer = view({ id: 777001 });
    const guess = view({
      id: 2,
      gender: "male",
      popularity: 400,
      highestRating: 5,
      earliestAppearance: 2030,
      latestAppearance: 2030,
      subjectTags: ["机战"],
      characterTags: [],
      voiceActors: ["声优乙"],
      appearances: [
        { id: 11, name: "作品甲", nameCn: "作品甲", year: 2020, rating: 8, ratingCount: 100 },
      ],
      comparisonAppearances: [{ id: 11, name: "作品甲", nameCn: "作品甲" }],
    });
    const masked = maskCEEFeedback(buildCEEFeedback(guess, answer, settings));
    expect(Object.keys(masked).sort()).toEqual([
      "appearancesCount",
      "earliestAppearance",
      "gender",
      "latestAppearance",
      "popularity",
      "rating",
      "sharedAppearance",
      "tagMatched",
      "tagTotal",
    ]);
    expect(masked.gender).toBe("no");
    expect(masked.popularity).toBe("++");
    expect(masked.rating).toBe("--");
    expect(masked.appearancesCount).toBe("=");
    expect(masked.earliestAppearance).toBe("++");
    expect(masked.latestAppearance).toBe("++");
    expect(masked.sharedAppearance).toBe(true);
    expect(masked.tagMatched).toBe(0);
    expect(masked.tagTotal).toBe(2);
  });

  it("标签命中数按展示标签统计", () => {
    const masked = maskCEEFeedback(
      buildCEEFeedback(view({ id: 2 }), view({ id: 777001 }), settings)
    );
    expect(masked.tagMatched).toBe(3);
    expect(masked.tagTotal).toBe(3);
  });
});
