import type { Database } from "bun:sqlite";
import type { CEECharacterSummary, CEESubjectSummary } from "../../shared/CEE";
import type { BangumiSearchIndex } from "../BangumiSearchIndex";
import type { CEEEnrichment } from "../CEEEnrichment";
import { escapeLike } from "../db/FtsQuery";

/** 各模块共用的依赖：同一条数据集连接、补全层与时钟，由门面统一持有与关闭。 */
export interface CEEContext {
  db: Database;
  enrichment: CEEEnrichment;
  now: () => number;
  search?: BangumiSearchIndex;
}

export interface CharacterRow {
  id: number;
  name: string;
  name_cn: string;
  gender: string;
  aliases: string;
  summary: string;
  comments: number;
  collects: number;
}
export interface SubjectRow {
  id: number;
  type: number;
  name: string;
  name_cn: string;
  date: string;
  raw_tags: string;
  meta_tags: string;
  score: number;
  rating_count: number;
  heat: number;
  relation_type?: number;
}
export const boundedLimit = (limit: number, maximum = 50) =>
  Math.min(maximum, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20));
export const like = (keyword: string) => `%${escapeLike(keyword)}%`;
export const positiveId = (id: number) => Number.isSafeInteger(id) && id > 0;
export const validTypes = (types: number[]) =>
  [...new Set(types)].filter((type) => [1, 2, 3, 4, 6].includes(type));

/** 封面只读已回填的那份，不在列表查询里回源；缺的由客户端按需经 `cee.subject.image` 补。 */
export const toSubjectSummary = (enrichment: CEEEnrichment, row: SubjectRow): CEESubjectSummary => {
  const imageUrl = enrichment.readImage(row.id, "subject");
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    nameCn: row.name_cn || row.name,
    year: /^\d{4}/.test(row.date) ? Number(row.date.slice(0, 4)) : null,
    rating: row.score,
    heat: row.heat,
    ...(imageUrl ? { imageUrl } : {}),
  };
};

/** 搜索列表是 36~40px 的方形框：取方格图，避免竖版大图被裁到只剩头顶。 */
export const toCharacterSummary = (
  enrichment: CEEEnrichment,
  row: CharacterRow
): CEECharacterSummary => {
  const supplement = enrichment.readCharacter(row.id);
  return {
    id: row.id,
    name: supplement.name ?? row.name,
    nameCn: supplement.nameCn ?? (row.name_cn || row.name),
    imageUrl: enrichment.readImage(row.id, "character", "grid"),
  };
};
