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
  CEE_RANKED_BOT_ANCHORS,
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
/** 反查档位的二分次数：档位跨度几千，四十次后误差远小于 1 分。 */
const LEVEL_SEARCH_ROUNDS = 40;

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
  const level = levelFor(persona, nominal - bias);
  const strengthRating = strengthAt(persona, level);
  return { level, strengthRating, targetRating: strengthRating + bias };
}

/** 某人格在某档位的强度分：档位换回的实战分加人格偏移。 */
const strengthAt = (persona: CEERankedPersona, level: number): number =>
  ceeRankedBotRatingOfLevel(level) + ceeRankedPersonaOffset(persona, level);

/**
 * 反查强度分等于 wanted 的档位，超出范围夹到两端。人格偏移随档位变化得比实战分平缓，强度分随
 * 档位严格递增，二分即可；高档的偏移变化可以很陡（慢人格在快档吃亏更多），不能靠简单迭代收敛。
 */
const levelFor = (persona: CEERankedPersona, wanted: number): number => {
  let low = CEE_RANKED_BOT_ANCHORS[0].level;
  let high = CEE_RANKED_BOT_ANCHORS[CEE_RANKED_BOT_ANCHORS.length - 1].level;
  if (wanted <= strengthAt(persona, low)) return low;
  if (wanted >= strengthAt(persona, high)) return high;
  for (let round = 0; round < LEVEL_SEARCH_ROUNDS; round += 1) {
    const middle = (low + high) / 2;
    if (strengthAt(persona, middle) < wanted) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
};
