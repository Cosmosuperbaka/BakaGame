import type { SongSearchResult } from "../shared/SonGuessr";
import { toSimplified } from "./ChineseConverter";

export interface AggregatedSongSearchResult extends SongSearchResult {
  /** 聚合后关联的备用音源 URN 列表 (按首选到次选排序) */
  sources?: string[];
  /** 综合排序打分 */
  relevanceScore?: number;
  /** 上游平台搜索返回的初始位置位次 (从 0 开始) */
  upstreamRank?: number;
}

/**
 * 文本强规范化：繁简归一、NFKC 字符归一、小写化、剥离所有空格与标点符号.
 */
export function normalizeComparableText(value: string): string {
  return toSimplified(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_—–/:：·.'"“”‘’()（）[\]【】{}《》〈〉~～!！?？`#@*^&|\\+=]+/g, "");
}

/**
 * 剥离标题中的副标题噪音 (如 Live、伴奏、Remix、电视剧插曲等)，提取纯正曲名.
 */
export function extractCanonicalTitle(title: string): string {
  let cleaned = toSimplified(title || "").normalize("NFKC");

  // 1. 剥离括号内的各类版本描述
  cleaned = cleaned.replace(
    /[([（【][^()[\]（）【】]*(?:live|remaster|remix|feat|ft\.|ver\.|version|伴奏|instrumental|inst|重制|原声|原唱|心动曲|插曲|片头曲|片尾曲|主题曲|ed|op|theme|ost|edition|acoustic|deluxe|edit|cut|cover|翻唱|纯音乐)[^()[\]（）【】]*[)\]）】]/gi,
    ""
  );

  // 2. 剥离连字符后的尾部后缀 (例如: "晴天 - Live", "歌曲名 - 伴奏")
  cleaned = cleaned.replace(
    /\s*[-—–]\s*(?:live|remaster\w*|remix|伴奏|instrumental|inst|重制版?|原声版?|原唱|cover|翻唱|纯音乐).*/gi,
    ""
  );

  const normalized = normalizeComparableText(cleaned);
  return normalized || normalizeComparableText(title);
}

/**
 * 歌手字符串拆分为独立人名集合 (支持各种常见分隔符).
 */
export function extractArtistTokens(artistStr: string): string[] {
  if (!artistStr) return [];
  return artistStr
    .split(/[/&、+×\s]+|(?:\s+feat\.?\s+)|\bft\.?\b/gi)
    .map((token) => normalizeComparableText(token))
    .filter((token) => token.length > 0);
}

const ARTIST_ALIASES: Record<string, string[]> = {
  "生物股长": ["いきものがかり"],
  "いきものがかり": ["生物股长"],
  "tk": ["tkfrom凛として时雨"],
  "tkfrom凛として时雨": ["tk"],
  "garnidelia": ["美依礼芽", "美依礼芽maria", "maria"],
  "美依礼芽": ["garnidelia"],
  "美依礼芽maria": ["garnidelia"],
};

/**
 * 检查两个歌手集合是否存在显著交集.
 */
export function artistsOverlap(artistsA: string[], artistsB: string[]): boolean {
  if (artistsA.length === 0 || artistsB.length === 0) return false;
  for (const a of artistsA) {
    const aliasesA = [a, ...(ARTIST_ALIASES[a] || [])];
    for (const b of artistsB) {
      const aliasesB = [b, ...(ARTIST_ALIASES[b] || [])];
      for (const aliasA of aliasesA) {
        for (const aliasB of aliasesB) {
          if (
            aliasA === aliasB ||
            (aliasA.length >= 2 && aliasB.length >= 2 && (aliasA.includes(aliasB) || aliasB.includes(aliasA)))
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * 物理时长容差门限：原版同一录音室母带在各平台的编码时长偏差通常 <= 3000ms.
 */
export function durationMatches(durA?: number, durB?: number, toleranceMs = 3000): boolean {
  if (typeof durA !== "number" || typeof durB !== "number" || durA <= 0 || durB <= 0) {
    return true;
  }
  return Math.abs(durA - durB) <= toleranceMs;
}

/**
 * 判定两首歌曲是否属于同一作品实体 (Canonical Work).
 */
export function isSameSongWork(songA: SongSearchResult, songB: SongSearchResult): boolean {
  const canonA = extractCanonicalTitle(songA.title);
  const canonB = extractCanonicalTitle(songB.title);
  if (!canonA || !canonB) return false;

  const titleMatches =
    canonA === canonB ||
    (canonA.length >= 2 && canonB.length >= 2 && (canonA.includes(canonB) || canonB.includes(canonA)));
  if (!titleMatches) {
    return false;
  }

  const artistsA = extractArtistTokens(songA.artist);
  const artistsB = extractArtistTokens(songB.artist);
  if (!artistsOverlap(artistsA, artistsB)) {
    return false;
  }

  // 时长防线：标题歌手一致但时长相差 > 3s 的（如 Live 版、加长版、伴奏），强制不合并
  if (!durationMatches(songA.durationMs, songB.durationMs, 3000)) {
    return false;
  }

  return true;
}

/** 识别翻唱或消音/衍生版本. */
export function isDerivationSong(song: SongSearchResult): boolean {
  if (song.originCoverType === 2) return true;
  const t = (song.title || "").toLowerCase();
  const a = (song.artist || "").toLowerCase();
  return (
    /(?:伴奏|纯伴奏|纯音乐|纯音楽|off\s*vocal|インスト|karaoke|カラオケ|instrumental|\binst\b|片段|铃声|加速|变速|慢速|dj版|remix|翻唱|翻录|\bcover\b|カヴァー|原唱[：:])/i.test(t) ||
    /(?:群星|网络歌手)/i.test(a)
  );
}

/**
 * 计算歌曲的相关度打分.
 */
export function calculateRelevanceScore(
  song: SongSearchResult & { upstreamRank?: number },
  keyword: string,
  isDualPlatform: boolean
): number {
  const normKeyword = normalizeComparableText(keyword);
  const normTitle = normalizeComparableText(song.title);
  const canonTitle = extractCanonicalTitle(song.title);
  const normArtist = normalizeComparableText(song.artist);

  let score = 0;

  // 1. 上游权威检索排位先验分 (搜索引擎已根据全网海量点播与官方歌手给出的位次)
  const rank = song.upstreamRank ?? 10;
  const rankBonus = Math.max(0, Math.round(80 / (1 + rank * 0.45)));
  score += rankBonus;

  // 检查标题括号内的译名 / 副标题 (如 "ブルーバード (青鸟)" 或 "恋愛サーキュレーション (恋爱循环)")
  const parenMatch = (song.title || "").match(/^(.*?)\s*[(（](.*?)[)）]\s*$/);
  let subTitleExactMatch = false;
  if (parenMatch) {
    const subCanon = extractCanonicalTitle(parenMatch[2]!);
    if (subCanon === normKeyword) {
      subTitleExactMatch = true;
    }
  }

  // 2. 标题匹配度：主标题完全匹配 > 括号副标题匹配 > 前缀匹配 > 包含匹配
  if (canonTitle === normKeyword || normTitle === normKeyword) {
    score += 100;
  } else if (subTitleExactMatch) {
    score += 80;
  } else if (canonTitle.startsWith(normKeyword) || normTitle.startsWith(normKeyword)) {
    score += 60;
  } else if (canonTitle.includes(normKeyword) || normTitle.includes(normKeyword)) {
    score += 30;
  }

  // 3. 歌手包含匹配加分
  if (normKeyword.includes(normArtist) && normArtist.length >= 2) {
    score += 50;
  } else if (normArtist === normKeyword) {
    score += 50;
  } else if (normArtist.includes(normKeyword)) {
    score += 25;
  }

  // 4. 双源互证加分 (两边都检索到同一作品)
  if (isDualPlatform) {
    score += 20;
  }

  // 5. 热度微调
  if (typeof song.popularity === "number" && song.popularity > 0) {
    score += Math.min(Math.round(song.popularity / 5), 20);
  }

  // 6. 负向版本惩罚
  const rawTitle = (song.title || "").toLowerCase();
  const rawArtist = (song.artist || "").toLowerCase();

  // 伴奏 / 纯伴奏 / 卡拉OK / Instrumental
  if (/(?:伴奏|纯伴奏|纯音乐|纯音楽|off\s*vocal|インスト|karaoke|カラオケ|instrumental|\binst\b)/i.test(rawTitle)) {
    score -= 160;
  }

  // 片段 / 剪辑 / 铃声 / 变速 / 加速 / 慢速
  if (/(?:片段|铃声|剪辑|加速|变速|慢速|dj版|remix)/i.test(rawTitle)) {
    score -= 160;
  }

  // 翻唱标记 (当搜索词本身未指定 cover / 翻唱时)
  if (
    (song.originCoverType === 2 || /(?:翻唱|翻录|\bcover\b|カヴァー|自翻|试唱|原唱[：:])/i.test(rawTitle)) &&
    !normKeyword.includes("cover") &&
    !normKeyword.includes("翻唱")
  ) {
    score -= 100;
  }

  // 现场版 / Live
  if (/(?:live|现场)/i.test(rawTitle)) {
    score -= 25;
  }

  // 歌手是群星 / 网络歌手
  if (/(?:群星|网络歌手)/i.test(rawArtist)) {
    score -= 60;
  }

  return score;
}

/** 参与合流与打分的候选：搜索结果加上上游平台位次。 */
type RankedSong = SongSearchResult & { upstreamRank?: number };

/** 判定为同一作品实体后合流的一组候选：主实体 + 备用音源。 */
interface SongCluster {
  primary: RankedSong;
  alternatives: RankedSong[];
}

/**
 * 合流簇内择优：新主实体上位，原主实体降为备用音源。
 */
function promoteClusterPrimary(cluster: SongCluster, newPrimary: RankedSong): void {
  const oldPrimary = cluster.primary;
  cluster.primary = newPrimary;
  cluster.alternatives = cluster.alternatives.filter((s) => s.id !== newPrimary.id);
  cluster.alternatives.push(oldPrimary);
}

/**
 * 判定候选是否应取代当前主实体.
 *
 * 择优链：非衍生版 > 包含搜索关键词的官方全名/译名 > 更纯正无噪音的曲名 >
 * 上游排名靠前者 > 同位次时有封面的优先。
 */
function shouldPromoteCandidate(candidate: RankedSong, primary: RankedSong, normKeyword: string): boolean {
  const candidateIsDeriv = isDerivationSong(candidate);
  const primaryIsDeriv = isDerivationSong(primary);

  // 当前不是衍生版、而原主是衍生版 -> 替换；反之两个都是衍生版时不动
  if (primaryIsDeriv) return !candidateIsDeriv;
  if (candidateIsDeriv) return false;

  // 优先 1：包含搜索关键词的官方全名/译名 (例如 "ブルーバード (青鸟)" 优于 "ブルーバード")
  const candidateHasKeyword = normalizeComparableText(candidate.title).includes(normKeyword);
  const primaryHasKeyword = normalizeComparableText(primary.title).includes(normKeyword);
  if (candidateHasKeyword !== primaryHasKeyword) return candidateHasKeyword;

  // 优先 2：更纯正无噪音的曲名 (例如 "晴天" 优于 "晴天 (2020 Remaster)")
  const candidateIsClean = normalizeComparableText(candidate.title) === extractCanonicalTitle(candidate.title);
  const primaryIsClean = normalizeComparableText(primary.title) === extractCanonicalTitle(primary.title);
  if (candidateIsClean !== primaryIsClean) return candidateIsClean;

  // 优先 3：上游排名靠前者 (0 > 1)；同位次时（优先 4）原主无封面而候选有封面也替换
  const candidateRank = candidate.upstreamRank ?? 99;
  const primaryRank = primary.upstreamRank ?? 99;
  if (candidateRank !== primaryRank) return candidateRank < primaryRank;
  return !primary.pictureUrl && Boolean(candidate.pictureUrl);
}

/** 主实体与任一备用音源分属不同平台时视为双源互证。 */
function hasCrossPlatformSource(primary: RankedSong, alternatives: RankedSong[]): boolean {
  const primaryPlatform = primary.id.split(":")[0];
  return alternatives.some((alt) => alt.id.split(":")[0] !== primaryPlatform);
}

/** 综合评分优先，其后按衍生版 / 上游位次 / 双源互证 / 热度的确定性决胜链. */
function compareAggregatedSongs(a: AggregatedSongSearchResult, b: AggregatedSongSearchResult): number {
  const diff = (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
  if (diff !== 0) return diff;

  // 平分决胜 1：非衍生版优先于衍生版
  const derivA = isDerivationSong(a) ? 1 : 0;
  const derivB = isDerivationSong(b) ? 1 : 0;
  if (derivA !== derivB) return derivA - derivB;

  // 平分决胜 2：上游排名更靠前者优先 (rank 0 优于 rank 1)
  const rankA = a.upstreamRank ?? 99;
  const rankB = b.upstreamRank ?? 99;
  if (rankA !== rankB) return rankA - rankB;

  // 平分决胜 3：双平台互证者优先
  const dualA = (a.sources?.length ?? 1) > 1 ? 1 : 0;
  const dualB = (b.sources?.length ?? 1) > 1 ? 1 : 0;
  if (dualA !== dualB) return dualB - dualA;

  // 平分决胜 4：热度更高者优先
  return (b.popularity ?? 0) - (a.popularity ?? 0);
}

/**
 * 双平台搜索结果去重、合流与综合排序.
 */
export function aggregateAndDeduplicateSongs(
  songs: RankedSong[],
  keyword: string,
  limit = 20
): AggregatedSongSearchResult[] {
  const normKeyword = normalizeComparableText(keyword);
  const clusters: SongCluster[] = [];

  for (const song of songs) {
    const matchedCluster = clusters.find((cluster) => isSameSongWork(cluster.primary, song));

    if (!matchedCluster) {
      clusters.push({
        primary: song,
        alternatives: [],
      });
      continue;
    }

    matchedCluster.alternatives.push(song);
    if (shouldPromoteCandidate(song, matchedCluster.primary, normKeyword)) {
      promoteClusterPrimary(matchedCluster, song);
    }
  }

  // 计算每个合流实体的最终打分
  const aggregated: AggregatedSongSearchResult[] = clusters.map(({ primary, alternatives }) => ({
    ...primary,
    sources: [primary.id, ...alternatives.map((a) => a.id)],
    relevanceScore: calculateRelevanceScore(primary, keyword, hasCrossPlatformSource(primary, alternatives)),
  }));

  return aggregated.sort(compareAggregatedSongs).slice(0, limit);
}
