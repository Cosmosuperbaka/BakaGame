import { describe, expect, it } from "bun:test";
import type { CEECharacterView } from "../src/shared/CEE";
import {
  CEE_RANKED_COUNTDOWN_MS,
  CEE_RANKED_GAME_MS,
  CEE_RANKED_INTERMISSION_MS,
  CEE_RANKED_OFFLINE_FORFEIT_MS,
  CEE_RANKED_OVERTIME_MS,
  createCEERankedSettings,
  CEE_RANKED_TIERS,
} from "../src/shared/CEERanked";
import {
  ceeRankedSeriesPhase,
  applyCEERankedSeriesGuess,
  createCEERankedSeries,
  ceeRankedSeriesScore,
  exitCEERankedSeries,
  setCEERankedSeatOnline,
  surrenderCEERankedSeriesGame,
  tickCEERankedSeries,
  type CEERankedSeries,
} from "../src/domain/CEERankedSeries";
import type { CEERankedGame, CEERankedSeatIndex } from "../src/domain/CEERankedGame";
import { AppError } from "../src/domain/Errors";

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
  view({ id: 777001, name: "题一", nameCn: "题一" }),
  view({ id: 777002, name: "题二", nameCn: "题二" }),
  view({ id: 777003, name: "题三", nameCn: "题三" }),
];

const newSeries = (
  seatOverrides: [Partial<CEERankedSeries["seats"][0]>, Partial<CEERankedSeries["seats"][1]>] = [
    {},
    {},
  ]
): CEERankedSeries =>
  createCEERankedSeries({
    id: "s1",
    tier: "d2",
    settings,
    answers: answers(),
    seats: [
      { userId: "u1", name: "甲", isBot: false, ...seatOverrides[0] },
      { userId: null, name: "小咔", isBot: true, ...seatOverrides[1] },
    ],
    now: 0,
    random: () => 0,
  });

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

const assertCurrent = (series: CEERankedSeries): CEERankedGame => {
  const game = series.current;
  if (!game) throw new Error("没有进行中的局");
  return game;
};

/** 把当前局推进到 playing，返回进入时刻。 */
const enterPlaying = (series: CEERankedSeries): number => {
  const game = assertCurrent(series);
  tickCEERankedSeries(series, game.startsAt);
  return game.startsAt;
};

/** 当前席在 playing 阶段猜中，赢下这一局。 */
const winGame = (series: CEERankedSeries, seat: CEERankedSeatIndex): number => {
  const now = enterPlaying(series);
  applyCEERankedSeriesGuess(series, seat, assertCurrent(series).answer, now);
  return now;
};

/** 双方都拖满常规与加时，本局判平。 */
const drawGame = (series: CEERankedSeries): number => {
  const game = assertCurrent(series);
  const overtimeAt = game.startsAt + CEE_RANKED_GAME_MS;
  tickCEERankedSeries(series, overtimeAt);
  const drawAt = overtimeAt + CEE_RANKED_OVERTIME_MS;
  tickCEERankedSeries(series, drawAt);
  return drawAt;
};

/** 局间到点后开启下一局。 */
const startNext = (series: CEERankedSeries): void => {
  const next = series.nextGameAt;
  if (next === null) throw new Error("当前不处于局间");
  tickCEERankedSeries(series, next);
};

describe("排位系列赛：创建", () => {
  it("题目重复直接拒绝", () => {
    const duplicated = answers();
    duplicated[1] = duplicated[0];
    expectAppError(
      () =>
        createCEERankedSeries({
          id: "s2",
          tier: "d2",
          settings,
          answers: duplicated,
          seats: [
            { userId: "u1", name: "甲", isBot: false },
            { userId: "u2", name: "乙", isBot: false },
          ],
          now: 0,
          random: () => 0,
        }),
      "RANKED_INVALID_ANSWERS",
      "系列赛题目必须互不相同"
    );
  });

  it("创建后立即可读秒，加时提示按题生成", () => {
    const series = newSeries();
    expect(series.phase).toBe("countdown");
    expect(series.games).toEqual([]);
    expect(series.nextGameAt).toBeNull();
    expect(series.seats[0].points).toBe(0);
    expect(series.seats[0].offlineSince).toBeNull();
    const game = assertCurrent(series);
    expect(game.number).toBe(1);
    expect(game.settings).toBe(settings);
    expect(game.answer.id).toBe(777001);
    expect(game.seats[0].name).toBe("甲");
    expect(game.seats[1].name).toBe("小咔");
    expect(series.overtimeHints).toEqual([
      "答案最早登场于 2020 年",
      "答案最早登场于 2020 年",
      "答案最早登场于 2020 年",
    ]);
    expect(game.overtimeHint).toBe(series.overtimeHints[0]);
  });
});

describe("排位系列赛：胜负流程", () => {
  it("2:0 两局带走，第三局不再开", () => {
    const series = newSeries();
    winGame(series, 0);
    expect(series.phase).toBe("intermission");
    expect(series.seats[0].points).toBe(1);
    expect(series.current).toBeNull();
    expect(series.nextGameAt).toBe(CEE_RANKED_COUNTDOWN_MS + CEE_RANKED_INTERMISSION_MS);
    startNext(series);
    expect(assertCurrent(series).number).toBe(2);
    expect(assertCurrent(series).answer.id).toBe(777002);
    const wonAt = winGame(series, 0);
    expect(series.phase).toBe("settled");
    expect(series.winner).toBe(0);
    expect(series.endReason).toBe("completed");
    expect(series.endedAt).toBe(wonAt);
    expect(series.seats.map((seat) => seat.points)).toEqual([2, 0]);
    expect(series.games.length).toBe(2);
    expect(ceeRankedSeriesScore(series, 0)).toBe(1);
    expect(ceeRankedSeriesScore(series, 1)).toBe(0);
    expect(series.current).toBeNull();
    expect(series.nextGameAt).toBeNull();
  });

  it("1:1 进入第三局且用第三题", () => {
    const series = newSeries();
    winGame(series, 0);
    startNext(series);
    winGame(series, 1);
    expect(series.seats.map((seat) => seat.points)).toEqual([1, 1]);
    expect(series.phase).toBe("intermission");
    startNext(series);
    const game = assertCurrent(series);
    expect(game.number).toBe(3);
    expect(game.answer.id).toBe(777003);
    expect(game.overtimeHint).toBe(series.overtimeHints[2]);
  });

  it("胜、平、平：第三局后 2:1 获胜", () => {
    const series = newSeries();
    winGame(series, 0);
    startNext(series);
    drawGame(series);
    expect(series.seats.map((seat) => seat.points)).toEqual([1.5, 0.5]);
    expect(series.phase).toBe("intermission");
    startNext(series);
    drawGame(series);
    expect(series.phase).toBe("settled");
    expect(series.winner).toBe(0);
    expect(series.seats.map((seat) => seat.points)).toEqual([2, 1]);
  });

  it("平、平、平：1.5:1.5 平局", () => {
    const series = newSeries();
    drawGame(series);
    startNext(series);
    drawGame(series);
    startNext(series);
    drawGame(series);
    expect(series.phase).toBe("settled");
    expect(series.endReason).toBe("completed");
    expect(series.winner).toBeNull();
    expect(ceeRankedSeriesScore(series, 0)).toBe(0.5);
    expect(ceeRankedSeriesScore(series, 1)).toBe(0.5);
  });

  it("胜、负、平：1.5:1.5 平局", () => {
    const series = newSeries();
    winGame(series, 0);
    startNext(series);
    winGame(series, 1);
    startNext(series);
    drawGame(series);
    expect(series.winner).toBeNull();
    expect(series.seats.map((seat) => seat.points)).toEqual([1.5, 1.5]);
  });

  it("局间到点自动开下一局，读秒从开局时刻起算", () => {
    const series = newSeries();
    const wonAt = winGame(series, 0);
    const nextAt = wonAt + CEE_RANKED_INTERMISSION_MS;
    expect(tickCEERankedSeries(series, nextAt)).toBe(true);
    const game = assertCurrent(series);
    expect(game.number).toBe(2);
    expect(game.phase).toBe("countdown");
    expect(game.startsAt).toBe(nextAt + CEE_RANKED_COUNTDOWN_MS);
    expect(game.deadlineAt).toBe(nextAt + CEE_RANKED_COUNTDOWN_MS + CEE_RANKED_GAME_MS);
    expect(series.nextGameAt).toBeNull();
  });

  it("一次 tick 连续推进：跳到大截止之后先进入加时", () => {
    const series = newSeries();
    const overtimeAt = CEE_RANKED_COUNTDOWN_MS + CEE_RANKED_GAME_MS;
    expect(tickCEERankedSeries(series, overtimeAt)).toBe(true);
    expect(series.phase).toBe("overtime");
    expect(series.current?.overtime).toBe(true);
  });

  it("结算后 tick 不再变化", () => {
    const series = newSeries();
    winGame(series, 0);
    startNext(series);
    winGame(series, 0);
    const before = structuredClone({ ...series, games: series.games.length });
    expect(tickCEERankedSeries(series, before.createdAt + 10 ** 9)).toBe(false);
    expect(series.phase).toBe("settled");
    expect(series.winner).toBe(before.winner);
  });
});

describe("排位系列赛：操作口径", () => {
  it("局间阶段猜测被拒", () => {
    const series = newSeries();
    winGame(series, 0);
    expectAppError(
      () => applyCEERankedSeriesGuess(series, 0, view({ id: 5 }), (series.nextGameAt ?? 0) - 1),
      "INVALID_PHASE",
      "当前不能猜测"
    );
  });

  it("认输当前局判对方得分并进入局间", () => {
    const series = newSeries();
    const now = enterPlaying(series);
    surrenderCEERankedSeriesGame(series, 0, now);
    expect(series.phase).toBe("intermission");
    expect(series.games.length).toBe(1);
    expect(assertLastGame(series).winner).toBe(1);
    expect(assertLastGame(series).endReason).toBe("surrender");
    expect(series.seats[1].points).toBe(1);
  });

  it("没有进行中的局时认输被拒", () => {
    const series = newSeries();
    winGame(series, 0);
    expectAppError(
      () => surrenderCEERankedSeriesGame(series, 0, (series.nextGameAt ?? 0) - 1),
      "INVALID_PHASE",
      "当前没有进行中的局"
    );
  });

  it("退出时进行中的局记为认输、整场判对方胜", () => {
    const series = newSeries();
    const now = enterPlaying(series);
    exitCEERankedSeries(series, 0, now);
    expect(series.phase).toBe("settled");
    expect(series.winner).toBe(1);
    expect(series.endReason).toBe("exit");
    expect(series.endedAt).toBe(now);
    expect(series.current).toBeNull();
    expect(series.games.length).toBe(1);
    expect(assertLastGame(series).endReason).toBe("surrender");
    expect(assertLastGame(series).winner).toBe(1);
    expect(series.seats.map((seat) => seat.points)).toEqual([0, 1]);
  });

  it("局间退出不再追加局记录", () => {
    const series = newSeries([{}, { isBot: false, userId: "u2" }]);
    const wonAt = winGame(series, 1);
    exitCEERankedSeries(series, 0, wonAt + CEE_RANKED_INTERMISSION_MS);
    expect(series.games.length).toBe(1);
    expect(series.winner).toBe(1);
    expect(series.endReason).toBe("exit");
    expect(series.seats.map((seat) => seat.points)).toEqual([0, 1]);
  });

  it("已结算再退出被拒", () => {
    const series = newSeries();
    winGame(series, 0);
    startNext(series);
    winGame(series, 0);
    expectAppError(() => exitCEERankedSeries(series, 0, 10 ** 9), "INVALID_PHASE", "本场已经结束");
  });

  it("未结算时系列赛得分查询被拒", () => {
    const series = newSeries();
    enterPlaying(series);
    expectAppError(() => ceeRankedSeriesScore(series, 0), "INVALID_PHASE", "本场尚未结束");
  });

  it("phase 字段与派生阶段一致", () => {
    const series = newSeries();
    expect(ceeRankedSeriesPhase(series)).toBe("countdown");
    enterPlaying(series);
    expect(series.phase).toBe("playing");
    expect(ceeRankedSeriesPhase(series)).toBe(series.phase);
    const overtimeAt = assertCurrent(series).startsAt + CEE_RANKED_GAME_MS;
    tickCEERankedSeries(series, overtimeAt);
    expect(series.phase).toBe("overtime");
    tickCEERankedSeries(series, overtimeAt + CEE_RANKED_OVERTIME_MS);
    expect(series.phase).toBe("intermission");
    expect(ceeRankedSeriesPhase(series)).toBe("intermission");
  });
});

const assertLastGame = (series: CEERankedSeries): CEERankedGame => {
  const game = series.games.at(-1);
  if (!game) throw new Error("还没有结束的局");
  return game;
};

describe("排位系列赛：离线判定", () => {
  const twoHumans = (): CEERankedSeries =>
    newSeries([{}, { isBot: false, userId: "u2", name: "乙" }]);

  it("离线 89.999 秒不判负，满 90 秒判负归对方", () => {
    const series = twoHumans();
    setCEERankedSeatOnline(series, 1, false, 6_000);
    expect(series.seats[1].offlineSince).toBe(6_000);
    expect(tickCEERankedSeries(series, 6_000 + CEE_RANKED_OFFLINE_FORFEIT_MS - 1)).toBe(true);
    expect(series.endReason).toBeNull();
    expect(tickCEERankedSeries(series, 6_000 + CEE_RANKED_OFFLINE_FORFEIT_MS)).toBe(true);
    expect(series.phase).toBe("settled");
    expect(series.winner).toBe(0);
    expect(series.endReason).toBe("offline");
  });

  it("中途上线清零离线计时", () => {
    const series = twoHumans();
    setCEERankedSeatOnline(series, 1, false, 6_000);
    setCEERankedSeatOnline(series, 1, true, 50_000);
    expect(series.seats[1].offlineSince).toBeNull();
    tickCEERankedSeries(series, 6_000 + CEE_RANKED_OFFLINE_FORFEIT_MS + 1);
    expect(series.phase).not.toBe("settled");
    expect(series.endReason).toBeNull();
  });

  it("重复下线不刷新离线时刻", () => {
    const series = twoHumans();
    setCEERankedSeatOnline(series, 1, false, 6_000);
    setCEERankedSeatOnline(series, 1, false, 70_000);
    expect(series.seats[1].offlineSince).toBe(6_000);
  });

  it("人机席位下线不参与判负", () => {
    const series = newSeries();
    setCEERankedSeatOnline(series, 1, false, 6_000);
    expect(series.seats[1].offlineSince).toBeNull();
    tickCEERankedSeries(series, 6_000 + CEE_RANKED_OFFLINE_FORFEIT_MS + 1);
    expect(series.phase).toBe("playing");
    expect(series.endReason).toBeNull();
  });

  it("离线判负时进行中的局按退出方认输关闭", () => {
    const series = twoHumans();
    enterPlaying(series);
    setCEERankedSeatOnline(series, 0, false, 10_000);
    tickCEERankedSeries(series, 10_000 + CEE_RANKED_OFFLINE_FORFEIT_MS);
    expect(series.winner).toBe(1);
    expect(series.endReason).toBe("offline");
    expect(series.games.length).toBe(1);
    expect(assertLastGame(series).winner).toBe(1);
    expect(assertLastGame(series).endReason).toBe("surrender");
    expect(series.seats.map((seat) => seat.points)).toEqual([0, 1]);
  });
});
