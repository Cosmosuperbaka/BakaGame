import { isReleaseYearOffTarget } from "./Records";
import { MusicCookieInput, MusicProvider } from "../../infrastructure/NeteaseMusicProvider";
/** 番剧歌曲归属证据评分与非人声音轨否决的纯函数。 */
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
 * 候选是否具备「就是这首歌」的准入证据。
 *
 * 只回答一个问题：**这个候选有没有资格作为「Bangumi 记录的那首歌」进入验证队列？**
 * 判定刻意与分数解耦 —— 两者回答的不是同一件事：准入看身份（是不是这首歌），
 * 排序（`scoreAnimeSongCandidate`）看版本（是不是原版）。
 *
 * 规则：
 * 1. 曲名完全一致 → 有资格。此时**不看歌手**：翻唱常把曲名照抄（靠 `originCoverType`
 *    在验证阶段让位），Bangumi 与网易云的歌手写法差异也常导致交集为空，用歌手否掉
 *    会让真正的原版连被验证的机会都没有；
 * 2. 专辑名与原曲目名完全一致 → 有资格（即使曲名完全对不上）：Bangumi 会把**整张原声带**
 *    挂成一条关联曲目，此时条目名就是专辑名，官方曲目与条目名毫无文字交集。实测事故是
 *    帝玖管弦乐团的《交响组曲「君の名は。」》靠曲名命中顶掉了官方原声带；
 * 3. 候选名**完整包含**条目名（`曲名 - 番剧名` / `曲名 (TV Size)`）→ 有资格，保持宽松；
 * 4. 候选名只是条目名的**一截**（专辑型条目名的前后缀、双 A 面单曲的某一段）→ 必须另有
 *    独立锚点（歌手交集 / 专辑指向本番，见 `albumAnchorsWork`）；
 * 5. 其余情况（曲名完全对不上、专辑名也对不上）→ 无资格；
 * 6. 非原唱标记的降权**不参与**准入：唯一候选是翻唱 / 改编时仍要能降级出题
 *    （既有语义「仅能召回翻唱版时仍可出题」），否则会退化成「该番剧没有可播放的关联歌曲」。
 *
 * 被第 4 条挡掉的正是实测的错配事故：《いつだってYELL》（忍者乱太郎 ED）被 2026 年
 * 无关的《Yell》顶掉、《ぼくらは小さな悪魔》被《ぼくら》顶掉、《5 Moving Shadows》
 * （Princess Principal 角色歌单曲）被《Moving Shadows》(Lessovsky / Max Vertigo，
 * 专辑《5 (Five Years of Kiez Beats)》) 顶掉 —— 最后这条说明「出现在带番剧名的检索
 * 结果里」这个信号不足以锚定（网易云模糊检索会把无关同名曲一起召回）。宁可这一首
 * 出不了题（上层会换下一首），也不能让玩家听到一首无关的歌。
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
  // 番剧上下文命中：候选出现在「曲名 + 番剧名/中文名」的检索结果里，是该曲目确实
  // 属于这部番的强证据。**同名不同曲**（实测《拜托了老师》2002 的 OP 被 2023 年 XG
  // 的同名《SHOOTING STAR》顶掉）里，别人家的同名原创只会在裸曲名检索里出现，
  // 而原版总跟着番剧名一起被召回 —— 这一条正是把两者区分开的免费信号。
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
 *
 * 只有「常规检索」这一条路（`looseFallback`）允许放宽：专辑 / 番剧级兜底已经把「哪首歌」
 * 放宽了，不该再把「是不是原版」一起放宽（实测番剧兜底会召回该番的**日语翻唱版**并出题）；
 * 同理也不该再放宽「年代」—— 实测《あした天気になあれ》(1984) 被 2026 年的 CeVIO 合成音
 * 同名曲顶掉，正是靠「标题命中该番另一条目 + 年份兜底」两道放宽叠出来的。
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
 *
 * - **翻唱**：网易云自标 `originCoverType === 2` 的版本是**别人的演唱录音**。
 *   文本维度在它面前全失效（翻唱常把曲名与专辑名照抄原曲，实测《裸の勇者》原版
 *   与翻唱曲名、专辑名一字不差），只有这个字段能把它认出来。
 * - **同名不同曲**：曲名（与专辑名）完全一致，发行年份却与番剧差了一二十年；
 *   发行年只有歌曲详情里有。同名新歌往往成批排在前面（实测 XG / chuLa / Anna Yvette
 *   等同名版本都是「曲名 + 专辑名」双命中得 4 分，而原版挂在「动画名 - 曲名」的专辑下
 *   只有 2 分），若让它们吃掉验证名额，排在后面的原版连被验证的机会都没有。
 *   整体仍受 detail 预算约束，不会无界回源。
 * - **近期出过**：是真正属于本番的歌，只是刚听过，所以不返还名额（换下一首候选）。
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
