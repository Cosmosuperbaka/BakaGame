import { shuffle } from "../../domain/Rules";
import {
  type BangumiMusicTrack,
  type BangumiSubjectDetails,
  type SongAlbumSearchResult,
  type SongSearchResult,
} from "../../shared/Index";
import type { MusicCookieInput, MusicProvider } from "../../infrastructure/music/MusicProvider";
import { ALTERNATE_VERSION_PATTERN } from "./AnimeSongEvidence";
import { ANIME_SONG_SEARCH_LIMIT, isUnusableSongCandidate } from "./Records";
import {
  ALBUM_NAME_EXACT_SCORE,
  ALBUM_SEARCH_LIMIT,
  ANIME_RELEASE_CONTEXT_PATTERN,
  albumNameScore,
  buildAlbumQueries,
  isSongCandidateMatch,
  isSongTitleMatch,
  isUnplayableAlbumTrack,
  normalizeSongTitle,
  normalizedArtists,
  retryOnce,
} from "./SongTitleMatching";
import type { SonGuessrContext } from "./Context";

/** 猜番候选检索：按曲目、专辑与番剧级三种口径向音乐上游检索候选。 */

/**
 * 用同一曲目的多个检索词并行回源，合并去重后只保留与曲目相关的候选。
 * 命中的判定同时接受「曲名命中」与「专辑名与原曲目名完全一致」——后者用于
 * 召回挂在整张原声带专辑下的官方原版（见 `isSongAlbumMatch`）。
 */
export const searchAnimeTrackCandidates = async (
  provider: MusicProvider,
  queries: string[],
  track: BangumiMusicTrack,
  cookie: MusicCookieInput | undefined,
  budget: { search: number },
  /** 带番剧名/中文名的检索词：命中它们的候选标记为「番剧上下文命中」。 */
  scopeQueries: readonly string[] = []
): Promise<{ candidates: SongSearchResult[]; animeScopedIds: Set<string> }> => {
  const searches = await Promise.all(
    queries.map(async (query) => {
      if (budget.search <= 0) return { query, results: [] as SongSearchResult[] };
      budget.search -= 1;
      try {
        return { query, results: await provider.search(query, ANIME_SONG_SEARCH_LIMIT, cookie) };
      } catch (error) {
        if (!isUnusableSongCandidate(error)) throw error;
        return { query, results: [] as SongSearchResult[] };
      }
    })
  );

  const merged = new Map<string, SongSearchResult>();
  const animeScopedIds = new Set<string>();
  for (const { query, results } of searches) {
    // 标记必须做在「已合并」判断**之前**：候选可能先在裸曲名检索里进池、
    // 之后才在带番剧名的检索里出现，那一次出现才是「属于本番」的证据。
    const scoped = scopeQueries.includes(query);
    for (const candidate of results) {
      if (scoped) animeScopedIds.add(candidate.id);
      if (merged.has(candidate.id)) continue;
      if (!isSongCandidateMatch(candidate, track.title)) continue;
      merged.set(candidate.id, candidate);
    }
  }
  return { candidates: [...merged.values()], animeScopedIds };
};

/**
 * 「专辑型条目」的兜底解析：多检索词搜专辑，取最匹配那张的曲目。
 *
 * Bangumi 把大量资源挂成整张专辑条目（角色歌合辑 / 印象曲集 / OST / 精选集），
 * 条目名就是专辑名。这类条目按曲名检索必然无候选，按专辑名却能直接搜到；
 * 命中的专辑里的歌全部属于这部番，可以出题 —— 猜番模式下玩家猜的是番剧名，
 * 曲目名只用于结算展示，因此不必强求曲名与条目名一致。
 *
 * 仍然剔除专辑里的伴奏 / 纯音乐 / 现场 / 翻唱分轨（见 `isUnplayableAlbumTrack`），
 * 它们不是可出的原曲；剩下的顺序随机，避免每次都从专辑第一轨出题。
 */
export const resolveAlbumTrackCandidates = async (
  ctx: SonGuessrContext,
  provider: MusicProvider,
  track: BangumiMusicTrack,
  anime: BangumiSubjectDetails,
  cookie: MusicCookieInput | undefined,
  budget: { search: number }
): Promise<SongSearchResult[]> => {
  // 供应商不支持专辑能力时静默跳过（接口方法都是可选的）。
  if (!provider.searchAlbums || !provider.getAlbumSongs) return [];
  const animeNames = [anime.name, anime.nameCn].filter((name): name is string => Boolean(name));

  // 同一条目的多个检索词之间没有依赖，**必须并行回源**（与 searchAnimeTrackCandidates 一致）：
  // 串行发会把专辑路径变成 3~6 次顺序等待，自动出题的等待时间直接翻倍。
  const searches = await Promise.all(
    buildAlbumQueries(track, anime).map(async (query) => {
      if (budget.search <= 0) return [] as SongAlbumSearchResult[];
      budget.search -= 1;
      try {
        return await retryOnce(() => provider.searchAlbums!(query, ALBUM_SEARCH_LIMIT, cookie));
      } catch (error) {
        if (!isUnusableSongCandidate(error)) throw error;
        return [] as SongAlbumSearchResult[];
      }
    })
  );
  const collected: SongAlbumSearchResult[] = searches.flat();
  if (collected.length === 0) return [];

  const unique = new Map<string, SongAlbumSearchResult>();
  for (const album of collected) if (!unique.has(album.id)) unique.set(album.id, album);
  const trackArtists = track.artist ? normalizedArtists(track.artist) : new Set<string>();
  const artistHit = (album: SongAlbumSearchResult): boolean => {
    if (trackArtists.size === 0 || !album.artist) return false;
    const albumArtists = normalizedArtists(album.artist);
    return [...trackArtists].some((name) => albumArtists.has(name));
  };
  const album = [...unique.values()]
    .map((entry) => {
      const artistMatches = artistHit(entry);
      return {
        entry,
        artistMatches,
        score: albumNameScore(entry.name, track.title, animeNames, artistMatches),
      };
    })
    .filter((item) => {
      if (item.score <= 0) return false;
      if (item.artistMatches) return true;
      // 歌手对不上时只认两种归属证据：专辑名与条目名**全等**（搜到的就是同名那张盘），
      // 或专辑名自带番剧归属（含番剧名 + 发行上下文）。
      // 「专辑名 ⊂ 条目名」的**子串**命中在陌生歌手手里是同名顶替的高危形态 ——
      // 实测事故：条目《TVアニメ Summer Pockets "leave a mark"》（角色歌集，艺人
      // 是本作 CV）被 LUREKS 2026 年的无关同名专辑《Leave a Mark》以 60 分顶替，
      // 专辑曲目直接出题。与 resolveAnimeLevelCandidates 的 belongsToAnime 同口径。
      if (item.score >= ALBUM_NAME_EXACT_SCORE) return true;
      const normalizedEntry = normalizeSongTitle(item.entry.name);
      return animeNames.some((name) => {
        const normalizedName = normalizeSongTitle(name);
        return (
          normalizedName.length >= 4 &&
          normalizedEntry.includes(normalizedName) &&
          ANIME_RELEASE_CONTEXT_PATTERN.test(item.entry.name)
        );
      });
    })
    // 同名专辑常有别人的版本，艺术家与 Bangumi 记录对得上的优先（数据集补录 artist
    // 之后这条才真正可用）；其余按名称相似度，序号命中因此能压过隔壁那张。
    .sort(
      (left, right) =>
        Number(right.artistMatches) - Number(left.artistMatches) || right.score - left.score
    )
    .at(0)?.entry;
  if (!album || budget.search <= 0) return [];

  budget.search -= 1;
  let songs: SongSearchResult[];
  try {
    songs = await retryOnce(() => provider.getAlbumSongs!(album.id, cookie));
  } catch (error) {
    if (!isUnusableSongCandidate(error)) throw error;
    return [];
  }
  const playable = songs.filter((song) => !isUnplayableAlbumTrack(song.title));
  // 原版优先：同盘里的 Remix / TV Size 分轨只是「版本不同」（整盘都是版本分轨时
  // 兜底可出），但原版存在时不得随机抢先。
  const originals = playable.filter((song) => !ALTERNATE_VERSION_PATTERN.test(song.title));
  const alternates = playable.filter((song) => ALTERNATE_VERSION_PATTERN.test(song.title));
  return [...shuffle(originals, ctx.random), ...shuffle(alternates, ctx.random)];
};

/**
 * 番剧级兜底：条目级解析全部失败时，用番剧名检索单曲，只要歌确实属于这部番就出题。
 *
 * 为什么需要：Bangumi 的条目名可能既不是歌名、也与网易云的命名对不上
 * （《「クラスターエッジ」キャラクターコレクション》搜专辑一张都搜不到，但用番剧
 * **原名** `CLUSTER EDGE` 能搜出该番的《ココロのつぼみ》《FLY HIGH》）。
 *
 * 只保留两种能证明「属于本番」的候选：
 * - 专辑名含番剧名（任一形态）；
 * - 歌名与该番任一 Bangumi 曲目标题一致（跨条目互证）。
 *
 * 因此可能出到该番的**其它**曲目而非条目指名的那张专辑，这是有意的取舍：猜番模式下
 * 玩家猜的是番剧名，出一首确实属于该番的歌远好于整条出不了题。
 */
export const resolveAnimeLevelCandidates = async (
  ctx: SonGuessrContext,
  provider: MusicProvider,
  anime: BangumiSubjectDetails,
  cookie: MusicCookieInput | undefined,
  budget: { search: number }
): Promise<SongSearchResult[]> => {
  const animeNames = [anime.name, anime.nameCn].filter((name): name is string => Boolean(name));
  if (animeNames.length === 0) return [];
  // 同样并行回源（见 resolveAlbumTrackCandidates 的说明）：番剧名与中文名之间无依赖。
  const searches = await Promise.all(
    animeNames.map(async (name) => {
      if (budget.search <= 0) return [] as SongSearchResult[];
      budget.search -= 1;
      try {
        return await retryOnce(() => provider.search(name, ANIME_SONG_SEARCH_LIMIT, cookie));
      } catch (error) {
        if (!isUnusableSongCandidate(error)) throw error;
        return [] as SongSearchResult[];
      }
    })
  );
  const collected = new Map<string, SongSearchResult>();
  for (const found of searches) {
    for (const candidate of found)
      if (!collected.has(candidate.id)) collected.set(candidate.id, candidate);
  }
  const otherTrackTitles = anime.musicTracks.map((entry) => entry.title);
  const belongsToAnime = (candidate: SongSearchResult): boolean => {
    const album = candidate.album ?? "";
    // 专辑名含番剧名**还不够**：番剧名撞车的外文歌/同名歌，专辑名往往也叫同一个名字。
    // 必须再有一层发行上下文（动画 / 原声带 / 主题歌 / 角色歌 …）才算证据。
    if (
      animeNames.some((name) => album.includes(name)) &&
      ANIME_RELEASE_CONTEXT_PATTERN.test(album)
    ) {
      return true;
    }
    return otherTrackTitles.some((title) => isSongTitleMatch(candidate.title, title));
  };
  return shuffle([...collected.values()].filter(belongsToAnime), ctx.random);
};
