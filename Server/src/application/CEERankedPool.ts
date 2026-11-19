import type { CEECharacterView, CEESettings } from "../shared/CEE";
import type { CEERankedTierId } from "../shared/CEERanked";
import type { CEERankedOpening } from "../domain/CEERankedOpeningBook";
import type { CEERankedCandidate } from "../domain/CEERankedSolver";

/** 一个难度档在某个北京日的排位题库。 */
export interface CEERankedPool {
  tier: CEERankedTierId;
  settings: CEESettings;
  /** 北京日 YYYY-MM-DD：题库随热度与年份变化，按日重建。 */
  day: string;
  /** 用本档设置派生的角色视图与被抽为答案的先验权重；按 id 升序。 */
  candidates: CEERankedCandidate[];
  /** 开局谱里热度达标、视图可取的角色，按本场题库评估的切分效果排序。 */
  openings: CEERankedOpening[];
  /** 本场题库之外、人机会猜到的角色视图（开局谱角色与爱噶首猜），按 id 升序。 */
  extras: CEECharacterView[];
}

/** 排位题库端口：与 `CEEDataProvider` 分开，免得每个测试替身都要补这个方法。 */
export interface CEERankedPoolProvider {
  getRankedPool(tier: CEERankedTierId, now: number): Promise<CEERankedPool>;
}
