import type {
  CEECharacterSummary,
  CEECharacterView,
  CEEDirectoryResult,
  CEEExtraTagSection,
  CEEImageSize,
  CEESettings,
  CEESubjectSummary,
} from "../shared/CEE";
import type { BangumiSearchOptions } from "./BangumiSearchIndex";

/** SQLite 的原始输入，不包含随房间设置变化的标签池。 */
export interface CEERawAppearance {
  id: number;
  type: number;
  name: string;
  nameCn: string;
  date: string;
  relationType: number;
  rating: number;
  ratingCount: number;
  heat: number;
  rawTags: Record<string, number>;
  metaTags: string[];
}

export interface CEERawCharacter extends CEECharacterSummary {
  aliases: string[];
  gender: "male" | "female" | "?";
  popularity: number;
  summary: string;
  appearances: CEERawAppearance[];
  characterTags: string[];
  voiceActors: string[];
  extraTagsBySubject: Record<number, CEEExtraTagSection[]>;
}

export interface CEEDataProvider {
  searchCharacters(keyword: string, limit?: number): Promise<CEECharacterSummary[]>;
  searchSubjects(keyword: string, limit?: number, types?: number[]): Promise<CEESubjectSummary[]>;
  getSubjectCharacters(subjectId: number, limit?: number): Promise<CEECharacterSummary[]>;
  /** 按编号取作品摘要，顺序随输入、本地没有的编号跳过；不含 NSFW 过滤以外的筛选。 */
  getSubjects(subjectIds: number[]): Promise<CEESubjectSummary[]>;
  getRawCharacter(id: number): Promise<CEERawCharacter>;
  getCharacter(id: number, settings: CEESettings): Promise<CEECharacterView>;
  chooseRandomCharacter(settings: CEESettings, random?: () => number): Promise<CEECharacterView>;
  importDirectory(indexId: number): Promise<CEEDirectoryResult>;
  /** 角色图；`size` 缺省为大图，搜索列表这类方形缩略图传 `grid`。 */
  resolveCharacterImage(id: number, size?: CEEImageSize): Promise<string | undefined>;
  /** 作品封面；本地没有、NSFW 或上游无图时为 `undefined` */
  resolveSubjectImage(id: number, size?: CEEImageSize): Promise<string | undefined>;
  close(): void | Promise<void>;
}

export interface CEEDataOptions {
  /** 唯一的数据集路径：与猜歌共用同一个库（见 tools/build_bangumi_db.py）。 */
  dbPath: string;
  enrichmentPath?: string;
  apiBase?: string;
  imageBase?: string;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  meilisearch?: BangumiSearchOptions;
}

export type CEEDataInit = Omit<CEEDataOptions, "fetcher" | "now" | "meilisearch"> & {
  meilisearch?: Omit<BangumiSearchOptions, "client">;
};
