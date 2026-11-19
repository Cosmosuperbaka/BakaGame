import type { EventLogger } from "../EventLogger";
import { isPlaylistTruncated } from "./MusicCache";

/** 歌单单页曲目上限：`playlist_track_all` 的 limit 上限就是 1000。 */
export const PLAYLIST_PAGE_SIZE = 1000;
/**
 * 歌单翻页硬上限（50000 首）。正常歌单远达不到，仅作兜底：
 * 上游对超范围 offset 若仍返回整页，没有上界就会一直翻下去。
 */
export const PLAYLIST_MAX_PAGES = 50;

interface RemainingPagesInput<TRaw> {
  /** 首页新增的曲目数；首页就没有新增时不再翻页。 */
  firstAdded: number;
  /** 上游声明的曲目总数；已取够就停。 */
  declaredCount: number | undefined;
  /** 当前已收集的曲目数。 */
  collectedCount: () => number;
  /** 取第 `page` 页（从 1 起）的原始曲目；返回 undefined 表示这一页没取到，结束翻页并保留已取部分。 */
  fetchPage: (page: number) => Promise<TRaw[] | undefined>;
  /** 把一页原始曲目收进结果，返回新增条数（按 ID 去重由调用方负责）。 */
  collect: (rawSongs: TRaw[]) => number;
}

/**
 * 单页装不下的歌单必须继续翻页，否则尾部曲目永远进不了题库。
 *
 * 停止条件：已取够声明总数、翻页失败、本页没有新增曲目、或本页不足一页
 * （避免上游对超范围 offset 仍返回整页时无限翻下去）。翻页失败不丢弃已取到的部分。
 */
export const readRemainingPlaylistPages = async <TRaw>(
  input: RemainingPagesInput<TRaw>
): Promise<void> => {
  for (let page = 1; page < PLAYLIST_MAX_PAGES && input.firstAdded > 0; page += 1) {
    if (input.declaredCount !== undefined && input.collectedCount() >= input.declaredCount) break;
    const rawSongs = await input.fetchPage(page);
    if (!rawSongs) break;
    const added = input.collect(rawSongs);
    if (added === 0 || rawSongs.length < PLAYLIST_PAGE_SIZE) break;
  }
};

/** 读到的曲目比声明的少时补一条告警：题库被缩小是要让人看见的。 */
export const warnIfPlaylistTruncated = (
  logger: Pick<EventLogger, "warn"> | undefined,
  message: string,
  context: Record<string, unknown>,
  declared: number | undefined,
  fetched: number
): void => {
  if (!isPlaylistTruncated(declared, fetched)) return;
  logger?.warn?.(message, { ...context, declared, fetched });
};
