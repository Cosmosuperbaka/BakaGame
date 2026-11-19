import { AppError } from "../domain/Errors";
import type {
  AnimeAutoFilters,
  BangumiSubjectDetails,
  BangumiSubjectSearchResult,
} from "../shared/Index";

export interface BangumiGetSubjectOptions {
  waitForImage?: boolean;
}

export interface BangumiDataProvider {
  initialize?: () => Promise<void>;
  searchSubjects(
    keyword: string,
    limit?: number,
    filters?: AnimeAutoFilters
  ): Promise<BangumiSubjectSearchResult[]>;
  /**
   * 条目详情。本地库缺封面时默认**不等回源**（猜测判定在热路径上，不能被上游往返拖慢），
   * 封面在后台补取落库；出题这类可以等一下的调用方传 `waitForImage` 换完整封面。
   * 在线 provider 的详情本就带封面，忽略该选项。
   */
  getSubject(subjectId: string, options?: BangumiGetSubjectOptions): Promise<BangumiSubjectDetails>;
  chooseRandomSubject(
    filters?: AnimeAutoFilters,
    random?: () => number
  ): Promise<BangumiSubjectDetails>;
  /** 角色立绘：本地数据集不含图片，只能回源取，结果写进回填缓存。 */
  resolveCharacterImage(characterId: number): Promise<string | undefined>;
  /**
   * 番剧封面：只读数据集没有图片列，命中回填缓存就直接返回，否则回源一次并落盘。
   * 搜索列表缺的封面由客户端滚进视口时经 `song.subject.image` 按需补。
   */
  resolveSubjectImage(subjectId: string): Promise<string | undefined>;
  /**
   * 释放底层资源（SQLite 句柄等）。声明为可选：远端 provider 不需要它。
   * 有了这个声明，回退 provider 就不必再写双重 `as unknown as` 去探测方法是否存在。
   */
  close?: () => void | Promise<void>;
}

/**
 * 「搜一页、随机取一条、再取详情」的随机出题：三种数据提供者（本地库、数据线程门面、在线）
 * 的流程完全相同，只有底层的搜索与详情不同，所以只写一份。
 */
export const pickRandomSubject = async (
  provider: Pick<BangumiDataProvider, "searchSubjects" | "getSubject">,
  filters: AnimeAutoFilters,
  random: () => number
): Promise<BangumiSubjectDetails> => {
  const candidates = await provider.searchSubjects(
    "",
    Math.min(filters.subjectLimit ?? 50, 50),
    filters
  );
  if (candidates.length === 0) throw new AppError("BANGUMI_NO_SUBJECT", "选不到符合条件的番剧");
  const selected =
    candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
  return provider.getSubject(selected.id, { waitForImage: true });
};
