import type {
  AnimeAutoFilters,
  BangumiSubjectDetails,
  BangumiSubjectSearchResult,
} from "../shared/Index";
import {
  pickRandomSubject,
  type BangumiDataProvider,
  type BangumiGetSubjectOptions,
} from "./BangumiDataProvider";
import type { BangumiDataWorkerClient } from "./BangumiDataWorkerClient";

/**
 * 猜歌侧的数据门面：请求都经共享的 `BangumiDataWorkerClient` 发往**同一个** Worker 进程
 * （CEE 共用它），把 SQLite/Meilisearch 的写操作收口到单一线程，天然串行。
 */
export class BangumiWorkerProvider implements BangumiDataProvider {
  constructor(
    private readonly client: BangumiDataWorkerClient,
    /** 与 CEE 共用的初始化 Promise：两边等的是同一次 init。 */
    private readonly ready: Promise<unknown>
  ) {}

  async searchSubjects(
    keyword: string,
    limit = 20,
    filters: AnimeAutoFilters = {}
  ): Promise<BangumiSubjectSearchResult[]> {
    await this.ready;
    return this.client.request({
      method: "song.searchSubjects",
      keyword,
      limit,
      filters,
    }) as Promise<BangumiSubjectSearchResult[]>;
  }

  async getSubject(
    subjectId: string,
    options: BangumiGetSubjectOptions = {}
  ): Promise<BangumiSubjectDetails> {
    await this.ready;
    return this.client.request({
      method: "song.getSubject",
      subjectId,
      ...(options.waitForImage ? { waitForImage: true } : {}),
    }) as Promise<BangumiSubjectDetails>;
  }

  async resolveCharacterImage(characterId: number): Promise<string | undefined> {
    await this.ready;
    return this.client.request({ method: "song.resolveCharacterImage", characterId }) as Promise<
      string | undefined
    >;
  }

  async resolveSubjectImage(subjectId: string): Promise<string | undefined> {
    await this.ready;
    return this.client.request({ method: "song.resolveSubjectImage", subjectId }) as Promise<
      string | undefined
    >;
  }

  chooseRandomSubject(
    filters: AnimeAutoFilters = {},
    random = Math.random
  ): Promise<BangumiSubjectDetails> {
    return pickRandomSubject(this, filters, random);
  }

  close() {
    // Worker 由共享客户端统一关闭，门面不重复 terminate。
  }
}
