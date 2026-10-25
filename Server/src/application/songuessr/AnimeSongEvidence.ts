/** 番剧歌曲归属证据评分与非人声音轨否决的纯函数。 */
import { isReleaseYearOffTarget } from "./Records";
import { MusicCookieInput, MusicProvider } from "../../infrastructure/NeteaseMusicProvider";
import {
  BangumiSubjectDetails,
  SongDetails,
  type BangumiMusicTrack,
  type SongSearchResult,
} from "../../shared/Index";
import {
  ANIME_SCOPED_BONUS,
  DRAMA_TRACK_PATTERN,
  MAX_ARTIST_QUERY_LENGTH,
  NON_ORIGINAL_MARKERS,
  NO_VOCAL_VERSION_PATTERN,
  RADIO_TALK_TRACK_PATTERN,
  TRACK_NUMBER_TITLE_PATTERN,
  albumAnchorsWork,
  artistOverlap,
  isSongAlbumMatch,
  songTitleSimilarity,
} from "./SongTitleMatching";

export const ALTERNATE_VERSION_PATTERN =
  /\bremix(?:ed)?\b|リミックス|\btv\s*size\b|\bgame\s*size\b|\bshort\s*ver(?:sion)?\b|\bmovie\s*ver(?:sion)?\b/iu;

/**
 * 该曲名是否属于**根本没有歌声**的音轨（台词轨 / 电台谈话 / 伴奏 / 纯音乐 / 卡拉 OK）。
 *
 * 与 `isUnplayableAlbumTrack` 的区别：后者只在专辑路径做「选哪首」的粗筛，
 * 且包含的现场 / 不插电 / demo / 器乐改编等标记只是**版本不同**，仍有人声、
 * 仍可出题（所以 `scoreAnimeSongCandidate` 只降权不剔除）。这里只认
 * 「放出来玩家无从猜起」的硬缺陷，必须在**所有路径**的验证阶段一律否决。
 */
export const isNonVocalTrack = (title: string): boolean =>
  DRAMA_TRACK_PATTERN.test(title) ||
  RADIO_TALK_TRACK_PATTERN.test(title) ||
  NO_VOCAL_VERSION_PATTERN.test(title) ||
  TRACK_NUMBER_TITLE_PATTERN.test(title);

/**
 * 为网易云候选歌曲打「原版优先」分，分数越高越接近 Bangumi 记录的原唱版本。
 * resolveAnimeSong 会按此分数降序取首个可播放歌曲，从而在翻唱、器乐改编、伴奏等
 * 版本混排时优先选中原版，避免「原版存在却抽到翻唱」。
 */
/**
 * 候选是否具备「就是这首歌」的准入证据（准入看身份，与看版本的排序分刻意解耦）。
 * 曲名完全一致（此时不看歌手）、专辑名与原曲目名完全一致、候选名完整包含条目名 →
 * 有资格；候选名只是条目名的一截 → 须另有锚点（歌手交集 / 专辑指向本番，见
 * `albumAnchorsWork`）；其余无资格。非原唱降权不参与准入，翻唱可降级出题。
 */
export const hasAnimeSongEvidence = (
  candidate: SongSearchResult,
  track: BangumiMusicTrack,
  options: { animeScoped?: boolean; animeNames?: readonly string[] } = {}
): boolean => {
  const titleScore = songTitleSimilarity(candidate.title, track.title);
  if (titleScore >= 2) return true;
  // 专辑名与原曲目名完全一致（见规则 2）。
  if (isSongAlbumMatch(candidate.album, track.title)) return true;
  if (titleScore < 1) return false;
  // 部分命中（候选是条目名的一截 / 条目名带后缀）必须另有独立锚点 —— 歌手交集或专辑指向
  // 本条目的专辑；「出现在带番剧名的检索结果里」不算（见 albumAnchorsWork 的事故注释）。
  return (
    artistOverlap(candidate, track) === true ||
    albumAnchorsWork(candidate.album, track, options.animeNames ?? [])
  );
};

/**
 * 为网易云候选歌曲打「原版优先」分，分数越高越接近 Bangumi 记录的原唱版本。
 * resolveAnimeSong 会按此分数降序取首个可播放歌曲，从而在翻唱、器乐改编、伴奏等
 * 版本混排时优先选中原版，避免「原版存在却抽到翻唱」。
 */
export const scoreAnimeSongCandidate = (
  candidate: SongSearchResult,
  track: BangumiMusicTrack,
  options: { animeScoped?: boolean } = {}
): number => {
  let score = songTitleSimilarity(candidate.title, track.title);
  if (isSongAlbumMatch(candidate.album, track.title)) score += 2;
  const overlap = artistOverlap(candidate, track);
  if (overlap !== undefined) score += overlap ? 4 : -3;
  const descriptiveText = `${candidate.title} ${candidate.album ?? ""}`;
  const expectedText = `${track.title} ${track.artist ?? ""}`;
  for (const [pattern, weight] of NON_ORIGINAL_MARKERS) {
    if (pattern.test(descriptiveText) && !pattern.test(expectedText)) score -= weight;
  }
  // 番剧上下文命中：候选出现在「曲名 + 番剧名/中文名」的检索结果里，是该曲目
  // 确实属于这部番的强证据。
  if (options.animeScoped) score += ANIME_SCOPED_BONUS;
  return score;
};

/**
 * 为一个 Bangumi 音乐条目拼出常规检索词，并标出其中「带番剧上下文」的那几条。
 *
 * 返回的两个数组按原顺序逐条消耗检索预算，顺序即优先级，不可重排。
 */
export const buildTrackQueries = (
  track: BangumiMusicTrack,
  anime: BangumiSubjectDetails
): { queries: string[]; scopeQueries: string[] } => {
  const queries: string[] = [];
  // 歌手名只在**足够短**时才拼进检索词：Bangumi 的 artist 常是整串声优列表
  // （「A、B、C、D、E、F」这种），拼进去等于把检索词毁掉，网易云什么都搜不到。
  // 这时退回番剧名（原名往往是英文，与中文 / 日文名都不一样）。
  const artistQuery =
    track.artist && track.artist.trim().length <= MAX_ARTIST_QUERY_LENGTH
      ? track.artist.trim()
      : "";
  if (artistQuery) queries.push(`${track.title} ${artistQuery}`);
  if (anime.name) queries.push(`${track.title} ${anime.name}`);
  if (anime.nameCn && anime.nameCn !== anime.name) queries.push(`${track.title} ${anime.nameCn}`);
  queries.push(track.title);
  const broadQueries = [
    anime.name ? `${track.title} ${anime.name}` : "",
    anime.nameCn && anime.nameCn !== anime.name ? `${track.title} ${anime.nameCn}` : "",
    track.title,
  ].filter((query) => query && !queries.includes(query));
  queries.push(...broadQueries);

  const scopeQueries = [
    anime.name ? `${track.title} ${anime.name}` : "",
    anime.nameCn && anime.nameCn !== anime.name ? `${track.title} ${anime.nameCn}` : "",
  ].filter(Boolean);

  return { queries, scopeQueries };
};

/**
 * 用「有出题资格」过滤检索候选，再按原版优先分降序、同分保持原顺序排列。
 *
 * 准入门槛用「证据分」而非排序分：非原唱标记的降权只在排序里生效，
 * 唯一候选是翻唱 / 改编时仍要能降级出题（见 hasAnimeSongEvidence）。
 */
export const rankEvidencedCandidates = (
  matched: { candidates: SongSearchResult[]; animeScopedIds: Set<string> },
  track: BangumiMusicTrack,
  animeNames: string[]
): SongSearchResult[] =>
  matched.candidates
    .map((candidate, index) => {
      const options = {
        animeScoped: matched.animeScopedIds.has(candidate.id),
        animeNames,
      };
      return {
        candidate,
        index,
        score: scoreAnimeSongCandidate(candidate, track, options),
        evidenced: hasAnimeSongEvidence(candidate, track, options),
      };
    })
    .filter((entry) => entry.evidenced)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.candidate);

/** 自动出题的一条「番剧 → 可出歌曲」结果。 */
export type AnimeSongPick = { song: SongDetails; track: BangumiMusicTrack };

/**
 * 条目的候选池：来源标记决定还能不能放宽身份与年代，翻唱回指的原曲要插回同一个数组。
 * 只有「常规检索」这一条路（`looseFallback`）允许放宽：专辑 / 番剧级兜底已经把
 * 「哪首歌」放宽了，不该再把「是不是原版」「年代」一起放宽。
 */
export type TrackCandidatePool = {
  track: BangumiMusicTrack;
  list: SongSearchResult[];
  fromAnimeLevel: boolean;
  looseFallback: boolean;
};

/** 让位候选的三种归处：翻唱、同名不同年、近期已出过。 */
export type SongFallbackKind = "cover" | "year" | "recent";

/** 单个候选在验证阶段的判定入参：池内位置、让位归处与取到的歌曲详情。 */
export type FallbackPickEntry = {
  index: number;
  candidate: SongSearchResult;
  kind: SongFallbackKind;
  pick: AnimeSongPick;
};

/**
 * 自动出题的逐条目回源上下文：检索/详情预算、三档让位兜底槽与原曲去重集合
 * 都挂在同一对象上跨曲目累积，兜底优先级即字段顺序。
 */
export type AnimeSongLookup = {
  provider: MusicProvider;
  anime: BangumiSubjectDetails;
  cookie: MusicCookieInput | undefined;
  animeNames: string[];
  minPopularity: number;
  recentSongIds: Set<string>;
  originRetryIds: Set<string>;
  budget: { search: number; detail: number };
  fallbackRecent?: AnimeSongPick;
  fallbackYear?: AnimeSongPick;
  fallbackCover?: AnimeSongPick;
};

/**
 * 让位形态都只能在详情阶段判定，且一律「让位不占名额」：
 * - **翻唱**：网易云自标 `originCoverType === 2` 的是**别人的演唱录音**，文本维度认不出它；
 * - **同名不同曲**：曲名（与专辑名）完全一致，发行年份却与番剧差一二十年（发行年只在详情里有）；
 * - **近期出过**：真正属于本番的歌，只是刚听过，不返还名额（换下一首候选）。
 */
export const fallbackKindOfSong = (
  song: SongDetails,
  anime: BangumiSubjectDetails,
  recentSongIds: Set<string>
): SongFallbackKind | undefined => {
  if (song.originCoverType === 2) return "cover";
  if (isReleaseYearOffTarget(song.releaseYear, anime.year)) return "year";
  if (recentSongIds.has(song.id)) return "recent";
  return undefined;
};

/** 详情已带热度时再过一道门槛：热度缺失按不达标处理。 */
export const isBelowMinPopularity = (song: SongDetails, minPopularity: number): boolean =>
  minPopularity > 0 && (song.popularity === undefined || song.popularity < minPopularity);

/** 巡检的房间回收结论：`skip` 整间跳过、`grace` 已补校准并跳过、`keep` 继续后续阶段。 */
