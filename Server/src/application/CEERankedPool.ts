import type { CEECharacterView, CEESettings } from "../shared/CEE";
import type { CEERankedTierId } from "../shared/CEERanked";
import type { CEERankedCandidate } from "../domain/CEERankedSolver";

/** 一个难度档在某个北京日的排位题库。 */
export interface CEERankedPool {
  tier: CEERankedTierId;
  settings: CEESettings;
  /** 北京日 YYYY-MM-DD：题库随热度与年份变化，按日重建。 */
  day: string;
  /** 用本档设置派生的角色视图与被抽为答案的先验权重；按 id 升序。 */
  candidates: CEERankedCandidate[];
  /** `rankCEEOpenings` 的结果。 */
  openings: Array<{ id: number; expectedRemaining: number; worstClass: number }>;
  /** 题库外但人机会用到的角色视图（目前只有爱噶首猜的丰川祥子）；数据集里没有就为空。 */
  extras: CEECharacterView[];
}

/** 排位题库端口：与 `CEEDataProvider` 分开，免得每个测试替身都要补这个方法。 */
export interface CEERankedPoolProvider {
  getRankedPool(tier: CEERankedTierId, now: number): Promise<CEERankedPool>;
}
