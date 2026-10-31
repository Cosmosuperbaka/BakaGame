import { describe, expect, it } from "bun:test";
import type { CEECharacterView } from "../src/shared/CEE";
import {
  CEE_RANKED_COUNTDOWN_MS,
  CEE_RANKED_GAME_MS,
  CEE_RANKED_OVERTIME_MS,
  createCEERankedSettings,
  CEE_RANKED_TIERS,
} from "../src/shared/CEERanked";
import {
  applyCEERankedSeriesGuess,
  createCEERankedSeries,
  exitCEERankedSeries,
  tickCEERankedSeries,
  type CEERankedSeries,
} from "../src/domain/CEERankedSeries";
import type { CEERankedGame, CEERankedSeatIndex } from "../src/domain/CEERankedGame";
import { ceeRankedSeriesView, type CEERankedViewMeta } from "../src/application/CEERankedViews";

const settings = createCEERankedSettings(CEE_RANKED_TIERS[1]);

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

const answers = (): [CEECharacterView, CEECharacterView, CEECharacterView] => [
  view({ id: 777001, name: "答案角色", nameCn: "答案角色" }),
  view({ id: 777002, name: "题二", nameCn: "题二" }),
  view({ id: 777003, name: "题三", nameCn: "题三" }),
];

const newSeries = (): CEERankedSeries =>
  createCEERankedSeries({
    id: "s1",
    tier: "d2",
    settings,
    answers: answers(),
    seats: [
      { userId: "u1", name: "甲", isBot: false },
      { userId: null, name: "小咔", isBot: true },
    ],
    now: 0,
    random: () => 0,
  });

const meta = (overrides: Partial<CEERankedViewMeta> = {}): CEERankedViewMeta => ({
  seats: [
    { rating: 1520, placementPlayed: null, online: true },
    { rating: 1480, placementPlayed: 3, online: true },
  ],
  rated: true,
  settlement: "pending",
  results: [null, null],
  ...overrides,
});

const assertCurrent = (series: CEERankedSeries): CEERankedGame => {
  const game = series.current;
  if (!game) throw new Error("没有进行中的局");
  return game;
};

const enterPlaying = (series: CEERankedSeries): number => {
  const game = assertCurrent(series);
  tickCEERankedSeries(series, game.startsAt);
  return game.startsAt;
};

const startNext = (series: CEERankedSeries): void => {
  const next = series.nextGameAt;
  if (next === null) throw new Error("当前不处于局间");
  tickCEERankedSeries(series, next);
};

/** 席位在 playing 阶段猜一个角色，返回猜测记录。 */
const guess = (
  series: CEERankedSeries,
  seat: CEERankedSeatIndex,
  character: CEECharacterView
): ReturnType<typeof applyCEERankedSeriesGuess> =>
  applyCEERankedSeriesGuess(series, seat, character, assertCurrent(series).startsAt + 1_000);

/** 席位猜中当前题赢下这一局，返回结束时刻。 */
const winGame = (series: CEERankedSeries, seat: CEERankedSeatIndex): number => {
  const now = enterPlaying(series);
  applyCEERankedSeriesGuess(series, seat, assertCurrent(series).answer, now);
  return now;
};

/** 双方都拖满常规与加时，本局判平，返回结束时刻。 */
const drawGame = (series: CEERankedSeries): number => {
  const game = assertCurrent(series);
  const overtimeAt = game.startsAt + CEE_RANKED_GAME_MS;
  tickCEERankedSeries(series, overtimeAt);
  const drawAt = overtimeAt + CEE_RANKED_OVERTIME_MS;
  tickCEERankedSeries(series, drawAt);
  return drawAt;
};

describe("排位视图：席位与阶段", () => {
  it("人机席位的分数与定级进度一律不外泄", () => {
    const series = newSeries();
    const seen = ceeRankedSeriesView(series, 0, meta());
    expect(seen.opponent.isBot).toBe(true);
    expect(seen.opponent.rating).toBeNull();
    expect(seen.opponent.placementPlayed).toBeNull();
    expect(seen.self.rating).toBe(1520);
    expect(seen.opponent.name).toBe("小咔");
    const asBot = ceeRankedSeriesView(series, 1, meta());
    expect(asBot.self.isBot).toBe(true);
    expect(asBot.self.rating).toBeNull();
    expect(asBot.self.placementPlayed).toBeNull();
    expect(asBot.opponent.rating).toBe(1520);
  });

  it("读秒阶段：game 字段初始化、nextGameAt 为空", () => {
    const series = newSeries();
    const seen = ceeRankedSeriesView(series, 0, meta());
    expect(seen.seriesId).toBe("s1");
    expect(seen.tier).toEqual({ id: "d2", name: "进阶" });
    expect(seen.phase).toBe("countdown");
    expect(seen.rated).toBe(true);
    expect(seen.nextGameAt).toBeNull();
    expect(seen.result).toBeNull();
    expect(seen.games).toEqual([]);
    const game = seen.game;
    if (!game) throw new Error("读秒阶段应有进行中的局");
    expect(game.number).toBe(1);
    expect(game.phase).toBe("countdown");
    expect(game.startsAt).toBe(CEE_RANKED_COUNTDOWN_MS);
    expect(game.deadlineAt).toBe(CEE_RANKED_COUNTDOWN_MS + CEE_RANKED_GAME_MS);
    expect(game.guesses).toEqual([]);
    expect(game.opponentGuesses).toEqual([]);
    expect(game.hints).toEqual([]);
    expect(seen.self.attempts).toBe(0);
    expect(seen.self.allowance).toBe(10);
    expect(seen.self.finished).toBe(false);
    expect(seen.self.online).toBe(true);
  });

  it("局间阶段：game 为空、nextGameAt 有值、上一局完整公开", () => {
    const series = newSeries();
    enterPlaying(series);
    guess(series, 1, view({ id: 777100, name: "对手猜测角色", nameCn: "对手猜测角色" }));
    winGame(series, 0);
    const seen = ceeRankedSeriesView(series, 0, meta());
    expect(seen.phase).toBe("intermission");
    expect(seen.game).toBeNull();
    expect(seen.nextGameAt).toBe(series.nextGameAt);
    expect(seen.self.points).toBe(1);
    expect(seen.self.attempts).toBe(1);
    expect(seen.opponent.attempts).toBe(1);
    expect(seen.games.length).toBe(1);
    const summary = seen.games[0];
    if (!summary) throw new Error("局间应能看到上一局");
    expect(summary.answer.name).toBe("答案角色");
    expect(summary.winner).toBe("self");
    expect(summary.reason).toBe("solved");
    expect(summary.overtime).toBe(false);
    expect(summary.guesses.length).toBe(1);
    expect(summary.opponentGuesses.length).toBe(1);
    expect(summary.opponentGuesses[0]?.character.name).toBe("对手猜测角色");
  });

  it("进行中席位尝试数跟随当前局", () => {
    const series = newSeries();
    enterPlaying(series);
    guess(series, 1, view({ id: 777100 }));
    guess(series, 1, view({ id: 777101 }));
    const seen = ceeRankedSeriesView(series, 0, meta());
    expect(seen.opponent.attempts).toBe(2);
    expect(seen.self.attempts).toBe(0);
  });
});

describe("排位视图：进行中局只下发脱敏猜测", () => {
  it("序列化结果不含对方角色名、对方角色 id 与本局答案", () => {
    const series = newSeries();
    enterPlaying(series);
    guess(series, 0, view({ id: 777103, name: "我的猜测角色", nameCn: "我的猜测角色" }));
    guess(
      series,
      1,
      view({
        id: 777100,
        name: "对手猜测角色",
        nameCn: "对手猜测角色",
        subjectTags: ["对手标签词"],
      })
    );
    const seen = ceeRankedSeriesView(series, 0, meta());
    const json = JSON.stringify(seen);
    expect(json).not.toContain("对手猜测角色");
    expect(json).not.toContain("777100");
    expect(json).not.toContain("对手标签词");
    expect(json).not.toContain("答案角色");
    expect(json).not.toContain("777001");
    expect(json).toContain("我的猜测角色");
    const game = seen.game;
    if (!game) throw new Error("应有进行中的局");
    expect(game.guesses.length).toBe(1);
    expect(game.opponentGuesses.length).toBe(1);
  });

  it("脱敏猜测保留序号、命中与时刻，反馈只剩符号与计数", () => {
    const series = newSeries();
    enterPlaying(series);
    const opponentGuess = guess(
      series,
      1,
      view({
        id: 777100,
        gender: "male",
        popularity: 400,
        subjectTags: ["机战"],
        characterTags: [],
      })
    );
    const seen = ceeRankedSeriesView(series, 0, meta());
    const masked = seen.game?.opponentGuesses[0];
    if (!masked) throw new Error("缺少对方脱敏猜测");
    expect(masked.index).toBe(1);
    expect(masked.correct).toBe(false);
    expect(masked.createdAt).toBe(opponentGuess.createdAt);
    expect(Object.keys(masked.feedback).sort()).toEqual([
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
    expect(masked.feedback.gender).toBe("no");
    expect(masked.feedback.popularity).toBe("++");
    expect(masked.feedback.sharedAppearance).toBe(true);
    expect(masked.feedback.tagMatched).toBe(1);
    expect(masked.feedback.tagTotal).toBe(2);
    const feedbackJson = JSON.stringify(masked.feedback);
    expect(feedbackJson).not.toContain("机战");
    expect(feedbackJson).not.toContain("声优甲");
  });
});

describe("排位视图：结算结果", () => {
  it("已计分：胜负、原因与结算字段按席位视角输出", () => {
    const series = newSeries();
    winGame(series, 0);
    startNext(series);
    winGame(series, 0);
    const ratedMeta: CEERankedViewMeta = {
      ...meta(),
      settlement: "rated",
      results: [
        { ratingBefore: 1520, ratingAfter: 1543, placementPlayed: null },
        { ratingBefore: null, ratingAfter: null, placementPlayed: null },
      ],
    };
    const seen = ceeRankedSeriesView(series, 0, ratedMeta);
    expect(seen.phase).toBe("settled");
    expect(seen.nextGameAt).toBeNull();
    expect(seen.result).toEqual({
      outcome: "won",
      reason: "completed",
      settlement: "rated",
      ratingBefore: 1520,
      ratingAfter: 1543,
      placementPlayed: null,
    });
    const fromLoser = ceeRankedSeriesView(series, 1, ratedMeta);
    expect(fromLoser.result?.outcome).toBe("lost");
  });

  it("写库失败：settlement 为 failed 且分数字段全空", () => {
    const series = newSeries();
    winGame(series, 0);
    startNext(series);
    winGame(series, 0);
    const seen = ceeRankedSeriesView(series, 0, meta({ settlement: "failed" }));
    expect(seen.result).toEqual({
      outcome: "won",
      reason: "completed",
      settlement: "failed",
      ratingBefore: null,
      ratingAfter: null,
      placementPlayed: null,
    });
  });

  it("第 5 场定级赛：before 为 null、after 有值原样透传", () => {
    const series = newSeries();
    winGame(series, 0);
    startNext(series);
    winGame(series, 0);
    const seen = ceeRankedSeriesView(series, 0, {
      ...meta(),
      settlement: "rated",
      results: [
        { ratingBefore: null, ratingAfter: 1472, placementPlayed: 5 },
        { ratingBefore: null, ratingAfter: null, placementPlayed: null },
      ],
    });
    expect(seen.result?.ratingBefore).toBeNull();
    expect(seen.result?.ratingAfter).toBe(1472);
    expect(seen.result?.placementPlayed).toBe(5);
  });

  it("三局全平判 drawn、退出判 lost", () => {
    const drawSeries = newSeries();
    drawGame(drawSeries);
    startNext(drawSeries);
    drawGame(drawSeries);
    startNext(drawSeries);
    drawGame(drawSeries);
    const drawn = ceeRankedSeriesView(drawSeries, 0, meta({ settlement: "unrated" }));
    expect(drawn.result).toMatchObject({
      outcome: "drawn",
      reason: "completed",
      settlement: "unrated",
    });
    const exitSeries = newSeries();
    const now = enterPlaying(exitSeries);
    exitCEERankedSeries(exitSeries, 0, now);
    const lost = ceeRankedSeriesView(exitSeries, 0, meta());
    expect(lost.result).toMatchObject({ outcome: "lost", reason: "exit" });
    expect(lost.games.length).toBe(1);
    expect(lost.games[0]?.winner).toBe("opponent");
  });
});
