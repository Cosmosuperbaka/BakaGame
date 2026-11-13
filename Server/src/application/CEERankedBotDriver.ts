// ==================== 排位人机驱动 ====================
// 到点替人机出手：大脑按局重建，出手时刻与思考节奏都在系列赛运行时上，随机数由上下文注入。
import type { CEECharacterView } from "../shared/Index";
import { AppError } from "../domain/Errors";
import { applyCEERankedSeriesGuess } from "../domain/CEERankedSeries";
import {
  ceeRankedGameSeatFinished,
  type CEERankedGame,
  type CEERankedSeatIndex,
} from "../domain/CEERankedGame";
import { ceeRankedBotThinkMs } from "../domain/CEERankedBotTiming";
import {
  ceeRankedBotEligible,
  createCEERankedBot,
  nextCEERankedBotGuess,
  recordCEERankedBotFeedback,
  type CEERankedBotBrain,
} from "../domain/CEERankedBot";
import { filterCEECandidates } from "../domain/CEERankedSolver";
import type { CEERankedContext, CEERankedSeriesRuntime } from "./CEERankedRuntime";

/** 人机席位固定在 1 号席：真人对局里 0 号是发起者，人机对局里真人也排在 0 号。 */
const BOT_SEAT: CEERankedSeatIndex = 1;
/** 到点就出手；取不到视图的固定首猜只跳过、不占次数。 */
export function driveBot(ctx: CEERankedContext, runtime: CEERankedSeriesRuntime, now: number): void {
  const game = runtime.series.current;
  if (!game || game.phase === "settled") {
    runtime.botNextGuessAt = null;
    runtime.brain = null;
    return;
  }
  if (game.phase === "countdown") return;
  const brain = ensureBrain(ctx, runtime, game, now);
  // 加时或补回次数后重新排一手。
  if (runtime.botNextGuessAt === null && !ceeRankedGameSeatFinished(game.seats[BOT_SEAT]))
    runtime.botNextGuessAt = now + thinkMs(ctx, runtime, brain);
  for (let guard = 0; guard < 64; guard += 1) {
    const at = runtime.botNextGuessAt;
    if (at === null || at > now) return;
    botMove(ctx, runtime, brain, game, now);
  }
}


function ensureBrain(
  ctx: CEERankedContext,
  runtime: CEERankedSeriesRuntime,
  game: CEERankedGame,
  now: number
): CEERankedBotBrain {
  const existing = runtime.brain;
  if (existing && existing.gameNumber === game.number) return existing.brain;
  const spec = runtime.botSpec;
  if (spec === null) throw new AppError("RANKED_UNAVAILABLE", "排位人机状态不完整");
  const brain = createCEERankedBot({
    persona: spec.persona,
    strength: spec.strength,
    // 爱噶的思考节奏按开赛时定下的强度分（已扣校准偏差），整场不变，与审计记录一致。
    opponentRating: spec.strengthRating,
    pool: runtime.pool.candidates,
    random: ctx.random,
  });
  runtime.brain = { brain, gameNumber: game.number };
  runtime.botNextGuessAt = Math.max(game.startsAt, now) + thinkMs(ctx, runtime, brain);
  return brain;
}


function thinkMs(
  ctx: CEERankedContext,
  runtime: CEERankedSeriesRuntime,
  brain: CEERankedBotBrain
): number {
  return ceeRankedBotThinkMs(brain, consistentCount(runtime, brain), ctx.random);
}


/** 一致候选数：人机「知道自己还没排除掉多少个」，影响它的犹豫程度。 */
function consistentCount(runtime: CEERankedSeriesRuntime, brain: CEERankedBotBrain): number {
  const eligible = ceeRankedBotEligible(brain, runtime.pool.candidates);
  return filterCEECandidates(
    eligible,
    brain.observations,
    brain.strength.dims,
    runtime.series.settings
  ).length;
}


function botMove(
  ctx: CEERankedContext,
  runtime: CEERankedSeriesRuntime,
  brain: CEERankedBotBrain,
  game: CEERankedGame,
  now: number
): void {
  const settings = runtime.series.settings;
  let id: number;
  try {
    id = nextCEERankedBotGuess(
      brain,
      runtime.pool.candidates,
      runtime.pool.openings,
      settings,
      ctx.random
    );
  } catch (error) {
    // 没有可猜的已知角色：本局不再出手，交给截止与加时规则收口。
    if (error instanceof AppError && error.code === "RANKED_NO_CANDIDATE") {
      runtime.botNextGuessAt = null;
      return;
    }
    throw error;
  }
  const view = botView(runtime, id);
  if (view === null) {
    // 数据集里没有这个角色的视图：记进已猜、推进步数，立刻再要下一手，不占对局次数。
    brain.guessed.add(id);
    brain.step += 1;
    return;
  }
  const guess = applyCEERankedSeriesGuess(runtime.series, BOT_SEAT, view, now);
  recordCEERankedBotFeedback(brain, view, guess.feedback);
  const current = runtime.series.current;
  if (current !== game || current === null) {
    runtime.botNextGuessAt = null;
    return;
  }
  runtime.botNextGuessAt = ceeRankedGameSeatFinished(current.seats[BOT_SEAT])
    ? null
    : now + thinkMs(ctx, runtime, brain);
}


function botView(runtime: CEERankedSeriesRuntime, id: number): CEECharacterView | null {
  const candidate = runtime.pool.candidates.find((item) => item.character.id === id);
  if (candidate) return candidate.character;
  return runtime.pool.extras.find((item) => item.id === id) ?? null;
}

