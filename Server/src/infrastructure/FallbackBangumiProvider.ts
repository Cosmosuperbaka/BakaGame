import type { AnimeAutoFilters, BangumiSubjectDetails, BangumiSubjectSearchResult } from "../shared/Index";
import type { BangumiDataProvider } from "./LocalBangumiProvider";

/** 本地数据库不可用时自动切换到网络 API。 */
export class FallbackBangumiProvider implements BangumiDataProvider {
  private localDisabled = false;

  constructor(private readonly local: BangumiDataProvider, private readonly remote: BangumiDataProvider) {}

  searchSubjects(keyword: string, limit?: number, filters?: AnimeAutoFilters): Promise<BangumiSubjectSearchResult[]> {
    return this.run(() => this.local.searchSubjects(keyword, limit, filters), () => this.remote.searchSubjects(keyword, limit, filters));
  }

  getSubject(subjectId: string): Promise<BangumiSubjectDetails> {
    return this.run(() => this.local.getSubject(subjectId), () => this.remote.getSubject(subjectId));
  }

  chooseRandomSubject(filters?: AnimeAutoFilters, random?: () => number): Promise<BangumiSubjectDetails> {
    return this.run(() => this.local.chooseRandomSubject(filters, random), () => this.remote.chooseRandomSubject(filters, random));
  }

  resolveCharacterImage(characterId: number): Promise<string | undefined> {
    return this.run(() => this.local.resolveCharacterImage(characterId), () => this.remote.resolveCharacterImage(characterId));
  }

  async close(): Promise<void> {
    await Promise.all([
      typeof (this.local as unknown as { close?: () => unknown }).close === "function" ? (this.local as unknown as { close: () => unknown }).close() : undefined,
      typeof (this.remote as unknown as { close?: () => unknown }).close === "function" ? (this.remote as unknown as { close: () => unknown }).close() : undefined,
    ]);
  }

  private async run<T>(localCall: () => Promise<T>, remoteCall: () => Promise<T>): Promise<T> {
    if (this.localDisabled) return remoteCall();
    try {
      return await localCall();
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code !== "BANGUMI_DATA_UNAVAILABLE" && code !== "BANGUMI_QUERY_TIMEOUT") throw error;
      this.localDisabled = true;
      return remoteCall();
    }
  }
}
