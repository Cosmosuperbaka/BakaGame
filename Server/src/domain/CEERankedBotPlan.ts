// ==================== 排位人机开局定强度 ====================
// 一场人机系列赛开赛时，按玩家分数与校准偏差定下人机的档位、强度分与计分分。纯函数。
//
// 三个分数各管一件事：
// - 标称分：想让玩家碰到多强的对手（普通人格在玩家分数上下浮动，爱噶固定高出一截）。
// - 强度分：模型认为这场人机有多强（档位换回的实战分加人格偏移，已夹到能达到的范围）。
// - 计分分：强度分加校准偏差，即估计的真实实力；结算按它算，校准样本按强度分记。
// 想要的分数超出人机能达到的范围时，强度分与计分分都停在顶（底）上，不再跟着玩家分数走，
// 玩家分数因此有稳定点，不会靠反复赢碰顶的人机一直涨。
import {
  ceeRankedBotLevelOfRating,
  ceeRankedBotRatingOfLevel,
  ceeRankedPersonaOffset,
  clamp,
  type CEERankedPersona,
} from "./CEERankedBotProfile";
import { CEE_RANKED_AIGA_RATING_RANGE } from "./CEERankedBotTiming";

/** 普通人格的标称分在玩家分数上下浮动的幅度。 */
export const CEE_RANKED_BOT_NOMINAL_SPREAD = 120;
/**
 * 爱噶的标称分比玩家高出的实战分：她是靠速度压人的难缠对手，同分真人对她的系列赛期望得分约
 * 两成五。强出的部分是真快出来的，计分按实力算，不另加溢价。
 */
export const CEE_RANKED_AIGA_EDGE = 190;
/** 人格偏移随档位变，反查档位时的迭代次数。 */
const OFFSET_ROUNDS = 3;

export interface CEERankedBotPlan {
  /** 强度表档位：生成强度用。爱噶不走强度表，这里只是与她实战分对应的档位。 */
  level: number;
  /** 模型给出的实战分：普通人格含人格偏移，爱噶就是她的节奏分。已夹到能达到的范围。 */
  strengthRating: number;
  /** 计分分：强度分加校准偏差。 */
  targetRating: number;
}

/** 标称分：普通人格在玩家分数上下浮动，爱噶固定高出 `CEE_RANKED_AIGA_EDGE`。 */
export function ceeRankedBotNominal(
  persona: CEERankedPersona,
  playerRating: number,
  random: () => number
): number {
  if (persona.id === "aiga") return playerRating + CEE_RANKED_AIGA_EDGE;
  return playerRating + (random() * 2 - 1) * CEE_RANKED_BOT_NOMINAL_SPREAD;
}

/**
 * 按标称分与该组校准偏差定下这场人机：偏差 δ 表示真实实力 ≈ 强度分 + δ，所以先扣掉 δ 与人格
 * 偏移去找档位，再从档位换回强度分；没被夹住时计分分就等于标称分。
 */
export function planCEERankedBot(input: {
  persona: CEERankedPersona;
  nominal: number;
  bias: number;
}): CEERankedBotPlan {
  const { persona, nominal, bias } = input;
  if (persona.id === "aiga") {
    const rating = clamp(
      nominal - bias,
      CEE_RANKED_AIGA_RATING_RANGE.min,
      CEE_RANKED_AIGA_RATING_RANGE.max
    );
    return {
      level: ceeRankedBotLevelOfRating(rating),
      strengthRating: rating,
      targetRating: rating + bias,
    };
  }
  // 人格偏移随档位变，档位又要先扣偏移才找得到：从基线档位出发迭代几次，偏移变化很平缓，
  // 两三次就稳定。
  const wanted = nominal - bias;
  let level = ceeRankedBotLevelOfRating(wanted);
  for (let round = 0; round < OFFSET_ROUNDS; round += 1)
    level = ceeRankedBotLevelOfRating(wanted - ceeRankedPersonaOffset(persona, level));
  const strengthRating = ceeRankedBotRatingOfLevel(level) + ceeRankedPersonaOffset(persona, level);
  return { level, strengthRating, targetRating: strengthRating + bias };
}
