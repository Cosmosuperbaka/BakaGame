import {
  type CEERankedBotBrain,
  type CEERankedBotStrength,
  type CEERankedPersona,
  ceeRankedBotEligible,
  ceeRankedBotThinkMs,
  createCEERankedBot,
  nextCEERankedBotGuess,
  recordCEERankedBotFeedback,
} from "./CEERankedBot";
import { type CEERankedCandidate, filterCEECandidates } from "./CEERankedSolver";
import type { CEERankedOpening } from "./CEERankedOpeningBook";
import { buildCEEFeedback } from "./CEERules";
import type { CEECharacterView, CEESettings } from "../shared/CEE";

export interface CEERankedSimBot {
  persona: CEERankedPersona;
  strength: CEERankedBotStrength;
  opponentRating: number;
}
export interface CEERankedSimTiming {
  countdownMs: number;
  gameMs: number;
  overtimeMs: number;
  overtimeAttempts: number;
  maxAttempts: number;
}
export interface CEERankedSimInput {
  pool: readonly CEERankedCandidate[];
  openings: ReadonlyArray<CEERankedOpening>;
  settings: CEESettings;
  /** 题库外但可能被猜到的角色视图（开局谱角色与爱噶首猜）。 */
  extraViews: ReadonlyMap<number, CEECharacterView>;
  bots: [CEERankedSimBot, CEERankedSimBot];
  timing: CEERankedSimTiming;
  random: () => number;
}

interface Runner {
  index: 0 | 1;
  brain: CEERankedBotBrain;
  /** 本局累计出手次数，含没记上反馈的退化一手。 */
  attempts: number;
  /** 当前时段内已用的次数，进入加时清零。 */
  used: number;
  /** 当前时段允许的出手次数。 */
  quota: number;
  /** 下一次出手的时刻；无穷大表示该方当前时段无法或无需再出手。 */
  nextAt: number;
}

interface GameOutcome {
  winner: 0 | 1 | null;
  attempts: [number, number];
  overtime: boolean;
  /** 猜中那一刻的时刻（平局时为本局结束的时刻），标定用它算中位用时。 */
  finishMs: number;
}

/** 一局赛跑：双方按各自的思考时刻出手，先猜中者胜，两边都到点或用尽则平局。 */
export function simulateCEERankedGame(
  input: CEERankedSimInput & { answerId: number }
): GameOutcome {
  const { pool, openings, settings, extraViews, timing, random } = input;
  const answer = pool.find((item) => item.character.id === input.answerId)?.character;
  const viewOf = (id: number): CEECharacterView | undefined =>
    pool.find((item) => item.character.id === id)?.character ?? extraViews.get(id);
  const consistentCount = (brain: CEERankedBotBrain): number =>
    filterCEECandidates(
      ceeRankedBotEligible(brain, pool),
      brain.observations,
      brain.strength.dims,
      settings
    ).length;

  const makeRunner = (index: 0 | 1): Runner => ({
    index,
    brain: createCEERankedBot({
      persona: input.bots[index].persona,
      strength: input.bots[index].strength,
      opponentRating: input.bots[index].opponentRating,
      pool,
      random,
    }),
    attempts: 0,
    used: 0,
    quota: timing.maxAttempts,
    nextAt: Number.POSITIVE_INFINITY,
  });
  const runners: [Runner, Runner] = [makeRunner(0), makeRunner(1)];
  const schedule = (runner: Runner, from: number): void => {
    runner.nextAt =
      runner.used >= runner.quota || !ceeRankedBotEligible(runner.brain, pool).length
        ? Number.POSITIVE_INFINITY
        : from + ceeRankedBotThinkMs(runner.brain, consistentCount(runner.brain), random);
  };
  const outcome = (winner: 0 | 1 | null, overtime: boolean, finishMs: number): GameOutcome => ({
    winner,
    attempts: [runners[0].attempts, runners[1].attempts],
    overtime,
    finishMs,
  });
  let overtime = false;
  const enterOvertime = (at: number): void => {
    overtime = true;
    for (const runner of runners) {
      runner.used = 0;
      runner.quota = timing.overtimeAttempts;
      // 还没用尽的人保留原定出手时刻，用尽的人从进入加时的时刻重新计时。
      if (!Number.isFinite(runner.nextAt)) schedule(runner, at);
    }
  };

  for (const runner of runners) schedule(runner, timing.countdownMs);
  let phaseDeadline = timing.gameMs;
  for (;;) {
    const time = Math.min(runners[0].nextAt, runners[1].nextAt);
    if (time < phaseDeadline) {
      const actor = runners[0].nextAt <= runners[1].nextAt ? runners[0] : runners[1];
      const guessId = nextCEERankedBotGuess(actor.brain, pool, openings, settings, random);
      actor.attempts += 1;
      actor.used += 1;
      if (guessId === input.answerId) return outcome(actor.index, overtime, time);
      const character = viewOf(guessId);
      if (character && answer)
        recordCEERankedBotFeedback(
          actor.brain,
          character,
          buildCEEFeedback(character, answer, settings)
        );
      else {
        // 视图取不到（题库外首猜且没有 extraViews）时这一手只计次数，但要让大脑继续往前走。
        actor.brain.guessed.add(guessId);
        actor.brain.step += 1;
      }
      schedule(actor, time);
      continue;
    }
    if (overtime) return outcome(null, true, phaseDeadline);
    enterOvertime(phaseDeadline);
    phaseDeadline += timing.overtimeMs;
  }
}

/** 三局两胜：每局从 pool 里按 weight 抽一道本场未用过的题，胜 1 分、平各 0.5，先到 2 分者胜。 */
export function simulateCEERankedSeries(input: CEERankedSimInput): {
  winner: 0 | 1 | null;
  points: [number, number];
} {
  const remaining = [...input.pool];
  const points: [number, number] = [0, 0];
  for (let game = 0; game < 3 && points[0] < 2 && points[1] < 2; game += 1) {
    if (!remaining.length) break;
    const total = remaining.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
    let roll = input.random() * total;
    let picked = remaining.length - 1;
    for (let index = 0; index < remaining.length; index += 1) {
      roll -= Math.max(0, remaining[index].weight);
      if (roll < 0) {
        picked = index;
        break;
      }
    }
    const answerId = remaining.splice(picked, 1)[0].character.id;
    const result = simulateCEERankedGame({ ...input, answerId });
    if (result.winner === null) {
      points[0] += 0.5;
      points[1] += 0.5;
    } else points[result.winner] += 1;
  }
  return {
    winner: points[0] > points[1] ? 0 : points[1] > points[0] ? 1 : null,
    points,
  };
}
