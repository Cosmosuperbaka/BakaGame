/**
 * Bangumi v0 接口响应里本项目用得到的字段，以及「接口形态 → 数据集行形态」的归一。
 *
 * 新条目发现与运行时更新器都要把接口作品写进同一张 `subjects` 表，标签、热度、评分的归一
 * 只能有一份：两处各写一遍，口径就会随着某一处的修补而悄悄分叉。
 */

/** 接口形态的 infobox 是键值数组，dump 形态是 wikitext；多值项的元素形如 `{ v }`。 */
export type ApiInfobox = string | Array<{ key?: string; value?: unknown }>;

/** `/v0/subjects/{id}` 里本项目用得到的字段。 */
export interface ApiSubject {
  id?: number;
  type?: number;
  name?: string;
  name_cn?: string;
  date?: string;
  infobox?: ApiInfobox;
  summary?: string;
  nsfw?: boolean;
  tags?: Array<{ name?: string; count?: number }>;
  meta_tags?: string[];
  images?: { large?: string };
  rating?: { score?: number; total?: number; rank?: number };
  collection?: Record<string, number>;
}

export interface ApiCharacter {
  id?: number;
  /** 角色类型（1 人物 / 2 机体 / 3 舰船 / 4 组织），对应库里的 `role` 列。 */
  type?: number;
  /** 关联关系的中文名，只有作品的角色列表接口才带。 */
  relation?: string;
  name?: string;
  gender?: string | null;
  summary?: string;
  infobox?: ApiInfobox;
  stat?: { comments?: number; collects?: number };
}

/** 作品的关联条目（`/v0/subjects/{id}/subjects`）。 */
export interface ApiRelation {
  id?: number;
  type?: number;
  relation?: string;
}

const infoboxValues = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value])
    .map((item) => {
      const text = typeof item === "object" && item ? (item as { v?: unknown }).v : item;
      return typeof text === "string" || typeof text === "number" ? String(text).trim() : "";
    })
    .filter(Boolean);

/** 把接口的键值数组还原成 dump 同形的 wikitext，库里 `infobox` 列只有这一种形态。 */
export const infoboxToWikitext = (infobox: ApiInfobox | null | undefined): string => {
  if (typeof infobox === "string") return infobox;
  if (!Array.isArray(infobox) || !infobox.length) return "";
  const lines = infobox.map(({ key, value }) =>
    Array.isArray(value)
      ? `|${key}={\r\n${infoboxValues(value)
          .map((item) => `[${item}]`)
          .join("\r\n")}\r\n}`
      : `|${key}= ${infoboxValues(value)[0] ?? ""}`
  );
  return `{{Infobox\r\n${lines.join("\r\n")}\r\n}}`;
};

/** 按顺序取第一个有值的键对应的多值；找不到返回空数组。 */
export const infoboxField = (infobox: ApiInfobox | undefined, keys: string[]): string[] => {
  if (!Array.isArray(infobox)) return [];
  for (const key of keys) {
    const values = infoboxValues(infobox.find((item) => item.key === key)?.value);
    if (values.length) return values;
  }
  return [];
};

/** 从接口响应取热度：收藏分布各桶求和，与全量构建脚本同一口径。 */
export const heatOf = (subject: ApiSubject): number =>
  Object.values(subject.collection ?? {}).reduce<number>(
    (sum, value) => sum + Number(value ?? 0),
    0
  );

/** 接口作品落到 `subjects` 表所需的归一后字段（不含类型与别名，两处写库的口径不同）。 */
export interface SubjectColumns {
  name: string;
  nameCn: string;
  infobox: string;
  summary: string;
  date: string;
  tagNames: string[];
  rawTags: Record<string, number>;
  metaTags: string[];
  score: number;
  ratingCount: number;
  heat: number;
  rank: number;
  image: string;
}

export const subjectColumnsFromApi = (subject: ApiSubject): SubjectColumns => {
  const tags = Array.isArray(subject.tags) ? subject.tags : [];
  const rating = subject.rating ?? {};
  return {
    name: String(subject.name ?? ""),
    nameCn: String(subject.name_cn ?? ""),
    infobox: infoboxToWikitext(subject.infobox),
    summary: String(subject.summary ?? ""),
    date: String(subject.date ?? ""),
    tagNames: tags.map((tag) => String(tag.name ?? "")).filter(Boolean),
    rawTags: Object.fromEntries(
      tags.filter((tag) => tag.name).map((tag) => [String(tag.name), Number(tag.count ?? 0)])
    ),
    metaTags: subject.meta_tags ?? [],
    score: Number(rating.score ?? 0),
    ratingCount: Number(rating.total ?? 0),
    heat: heatOf(subject),
    rank: Number(rating.rank ?? 0),
    image: String(subject.images?.large ?? ""),
  };
};
