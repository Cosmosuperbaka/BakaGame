import { artistsOverlap, extractArtistTokens, normalizeComparableText } from "../MusicDeduplicator";

/**
 * AMLL 按歌名检索的结果校验：检索词里的每个词只要出现在曲名、歌手或专辑名之一就算命中，
 * 所以「专辑名恰好等于本曲名」的同专辑别的歌（专辑同名主打歌最常见）也会被召回。
 * 不校验就采纳第一条，会把另一首歌的逐字歌词装进这首歌的题面。
 *
 * 判定宁可错过不可错配：错过只是退到平台自己的歌词，错配则整轮的歌词与音频对不上。
 */

/**
 * 同一曲名的不同录音：现场、伴奏、Remix、TV Size、不插电、Demo、各种 ver.。
 * 时间轴和原版对不上，两边是否带这类标记必须一致。
 */
const RECORDING_VARIANT_PATTERN =
  /\b(?:live|remix(?:ed)?|inst(?:rumental)?|off\s*vocal|karaoke|tv\s*size|short\s*size|acoustic|demo|ver(?:sion)?)\b|伴奏|纯音乐|純音樂|現場|现场|カラオケ|インスト|リミックス|弾き語り|弹唱/iu;

/** 括号段（含日文引号）：`ブルーバード (青鸟)` 的译名、`小幸运 (电影《…》主题曲)` 的出处说明。 */
const BRACKETED_PART_PATTERN = /[（(【[「『][^）)】\]」』]*[）)】\]」』]/gu;

/** 歌手占位：平台缺歌手时填的固定文本，不能当作真实歌手参与比对。 */
const UNKNOWN_ARTIST_NAMES = new Set(["未知歌手", "未知艺人", "unknown", "unknownartist"]);

const readStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    : [];

/**
 * 两个曲名是否指同一次录音：完整写法归一后相同；或一侧去掉括号段后与另一侧完整写法相同
 * （译名、出处说明这类括号段），且两侧都带或都不带录音版本标记。
 * 两侧都带**不同**的括号段（`Part 1` 与 `Part 2`）不算同一首。
 */
export const isSameRecordingTitle = (left: string, right: string): boolean => {
  const fullLeft = normalizeComparableText(left);
  const fullRight = normalizeComparableText(right);
  if (!fullLeft || !fullRight) return false;
  if (fullLeft === fullRight) return true;
  if (RECORDING_VARIANT_PATTERN.test(left) !== RECORDING_VARIANT_PATTERN.test(right)) return false;
  const coreLeft = normalizeComparableText(left.replace(BRACKETED_PART_PATTERN, " "));
  const coreRight = normalizeComparableText(right.replace(BRACKETED_PART_PATTERN, " "));
  return (
    (Boolean(coreLeft) && coreLeft === fullRight) || (Boolean(coreRight) && coreRight === fullLeft)
  );
};

const knownArtistTokens = (artist: string | undefined): string[] =>
  extractArtistTokens(artist ?? "").filter((token) => !UNKNOWN_ARTIST_NAMES.has(token));

/**
 * AMLL 检索条目是否就是这首歌：条目登记的曲名里至少一个写法与本曲名是同一次录音，
 * 且本曲有真实歌手、条目也登记了歌手时两边有交集（繁简与别名互通，见 `artistsOverlap`）。
 */
export const isAmllSearchItemMatch = (
  item: Record<string, unknown>,
  title: string,
  artist: string | undefined
): boolean => {
  const names = readStrings(item.musicNames);
  if (!names.some((name) => isSameRecordingTitle(name, title))) return false;
  const expectedArtists = knownArtistTokens(artist);
  if (expectedArtists.length === 0) return true;
  const itemArtists = readStrings(item.artistNames).flatMap((name) => extractArtistTokens(name));
  if (itemArtists.length === 0) return true;
  return artistsOverlap(expectedArtists, itemArtists);
};
