import type { CCBCharacterSummary, CCBCharacterView, CCBDirectoryResult, CCBExtraTagSection, CCBSettings, CCBSubjectSummary } from "../shared/CCB";

/** SQLite 的原始输入，不包含随房间设置变化的标签池。 */
export interface CCBRawAppearance {
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

export interface CCBRawCharacter extends CCBCharacterSummary {
  aliases: string[];
  gender: "male" | "female" | "?";
  popularity: number;
  summary: string;
  appearances: CCBRawAppearance[];
  characterTags: string[];
  voiceActors: string[];
  extraTagsBySubject: Record<number, CCBExtraTagSection[]>;
}

export interface CCBDataProvider {
  searchCharacters(keyword: string, limit?: number): Promise<CCBCharacterSummary[]>;
  searchSubjects(keyword: string, limit?: number, types?: number[]): Promise<CCBSubjectSummary[]>;
  getSubjectCharacters(subjectId: number, limit?: number): Promise<CCBCharacterSummary[]>;
  getRawCharacter(id: number): Promise<CCBRawCharacter>;
  getCharacter(id: number, settings: CCBSettings): Promise<CCBCharacterView>;
  chooseRandomCharacter(settings: CCBSettings, random?: () => number): Promise<CCBCharacterView>;
  importDirectory(indexId: number): Promise<CCBDirectoryResult>;
  resolveCharacterImage(id: number): Promise<string | undefined>;
  close(): void | Promise<void>;
}

export interface CCBDataOptions {
  characterPath: string;
  enrichmentPath?: string;
  apiBase?: string;
  imageBase?: string;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

export type CCBDataInit = Omit<CCBDataOptions, "fetcher" | "now">;
