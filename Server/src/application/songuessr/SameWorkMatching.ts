/**
 * 「其他版本也算对」的同作品判定：原曲是同一首，翻唱、改编、现场、伴奏与古典乐的不同演奏
 * 都判对。房间设置关闭时不走这里，判对仍是严格的「同一首歌」（`isSameAnswerSong`）。
 *
 * 证据按强弱依次判：
 * 1. 严格判对成立的照样成立。
 * 2. 两边都认出古典乐目录号时由作品键定论（见 `ClassicalWorkKey`）。平台在古典区的
 *    原曲回指经常指错（《离别曲》回指到 Op.9 No.1 夜曲），所以排在回指之前。
 * 3. 网易云的翻唱回指：一边是另一边的原曲，或两边指向同一首原曲。
 * 4. 去掉版本装饰后曲名相同（含译名与别名）。两边原唱都知道时要求原唱有交集：两位歌手
 *    各自的原创同名歌是两首歌，翻唱照抄曲名也分不清它翻的是谁。有一边是来源不明的翻唱
 *    或改编时放行，但「夜曲」「Intro」这类通用曲名不放行。
 *
 * 宽松模式也宁可错过不可错配：判不出的一律判错，玩家可以换一个版本再猜。
 */
import {
  BRACKETED_PART_PATTERN,
  DISTINCT_PART_PATTERN,
  stripVersionInfo,
} from "../../domain/TitlePatterns";
import {
  artistsOverlap,
  extractArtistTokens,
  knownArtistTokens,
  normalizeComparableText,
} from "../../infrastructure/music/MusicDeduplicator";
import type { SongDetails } from "../../shared/Index";
import { classicalWorkProfile, compareClassicalWorks } from "./ClassicalWorkKey";
import {
  COVER_MARKER_PATTERN,
  INSTRUMENTAL_ARRANGEMENT_PATTERN,
  NON_ORIGINAL_VERSION_PATTERN,
  isSameAnswerSong,
} from "./SongTitleMatching";

/** 判定用到的歌曲字段；别名（含平台译名）只取百科里的 `aliases`。 */
export type WorkComparableSong = Pick<SongDetails, "id" | "title" | "artist"> &
  Partial<
    Pick<
      SongDetails,
      "album" | "originCoverType" | "originSongId" | "originSongTitle" | "originSongArtist"
    >
  > & { encyclopedia?: { aliases?: string[] } };

/** 网易云的版本关系：2 = 翻唱，3 = 改编（器乐版、DJ 版等）。 */
const DERIVED_COVER_TYPES = new Set([2, 3]);

/** 装饰段里表明「这是别人的版本」的写法，补足通用标记表没有的「×× 版」、DJ、女声版等。 */
const VERSION_DECORATION_PATTERN =
  /版|\b(?:remix|mix|ver(?:sion)?|dj|bootleg|mashup|nightcore|sped\s*up|slowed|cover)\b|原唱|翻自|女声|男声|童声/iu;

/** 装饰段里点名原唱的写法：`(原唱 周杰伦)`、`[原唱: 周杰伦]`、`(翻自 周杰伦)`、`(Cover 贝多芬)`。 */
const ORIGIN_ARTIST_DECORATION_PATTERN =
  /(?:原唱|翻自|cover(?!\s*by\b)(?:\s*from\b)?)\s*[:：]?\s*(.+)$/iu;

/** 尾部的 ` - 钢琴版`、` ～弾き語り～` 一类后缀。 */
const DECORATED_SUFFIX_PATTERN = /\s[-–—~～〜]+\s*([^-–—~～〜]+?)\s*[-–—~～〜]*\s*$/u;

/**
 * 通用曲名：不同作品共用的体裁名与段落名。曲名相同只能说明体裁相同，
 * 「来源不明的版本」不能凭它放行；原唱都已知且有交集时仍然算数。
 */
const GENERIC_TITLE_KEYS = new Set(
  [
    "intro",
    "outro",
    "interlude",
    "prologue",
    "epilogue",
    "overture",
    "opening",
    "ending",
    "theme",
    "main theme",
    "bgm",
    "untitled",
    "instrumental",
    "bonus track",
    "nocturne",
    "serenade",
    "waltz",
    "etude",
    "sonata",
    "prelude",
    "lullaby",
    "minuet",
    "march",
    "canon",
    "序",
    "序曲",
    "序章",
    "前奏",
    "间奏",
    "尾声",
    "无题",
    "纯音乐",
    "伴奏",
    "夜曲",
    "小夜曲",
    "圆舞曲",
    "练习曲",
    "奏鸣曲",
    "前奏曲",
    "摇篮曲",
    "小步舞曲",
    "进行曲",
    "卡农",
  ].map(normalizeComparableText)
);

const aliasesOf = (song: WorkComparableSong): string[] => song.encyclopedia?.aliases ?? [];

/** 曲名里的装饰段：括号内容与尾部后缀。 */
const decorationsOf = (title: string): string[] => {
  const parts = [...title.matchAll(BRACKETED_PART_PATTERN)].map((match) => match[0].slice(1, -1));
  const suffix = title.replace(BRACKETED_PART_PATTERN, " ").match(DECORATED_SUFFIX_PATTERN)?.[1];
  return suffix ? [...parts, suffix] : parts;
};

const isVersionDecoration = (part: string) =>
  VERSION_DECORATION_PATTERN.test(part) ||
  COVER_MARKER_PATTERN.test(part) ||
  NON_ORIGINAL_VERSION_PATTERN.test(part) ||
  INSTRUMENTAL_ARRANGEMENT_PATTERN.test(part);

/**
 * 是不是别人的版本（翻唱、改编、现场、伴奏）：平台自标的版本关系，或曲名装饰段、
 * 专辑名里的版本标记。只看装饰段：曲名本身是 `Piano Man` 不代表它是钢琴版。
 */
const isDerivedVersion = (song: WorkComparableSong): boolean =>
  DERIVED_COVER_TYPES.has(song.originCoverType ?? 0) ||
  Boolean(song.originSongId) ||
  decorationsOf(song.title).some(isVersionDecoration) ||
  Boolean(song.album && COVER_MARKER_PATTERN.test(song.album));

/**
 * 这首歌的原唱：平台回指给出的原曲歌手、曲名里点名的原唱；不是别人的版本时就是它自己的歌手。
 * 别人的版本又说不出原唱时返回 undefined（未知）。
 */
const originCreatorsOf = (song: WorkComparableSong): string[] | undefined => {
  const declared = knownArtistTokens(song.originSongArtist);
  if (declared.length) return declared;
  for (const part of decorationsOf(song.title)) {
    const named = part.match(ORIGIN_ARTIST_DECORATION_PATTERN)?.[1];
    const tokens = named ? extractArtistTokens(named) : [];
    if (tokens.length) return tokens;
  }
  if (isDerivedVersion(song)) return undefined;
  const own = knownArtistTokens(song.artist);
  return own.length ? own : undefined;
};

/**
 * 作品曲名键：去掉版本说明（Live、钢琴版、原唱署名）与说明性括号段（译名、出处）后归一。
 * 带编次的括号段（`Part 1`）保留，它区分的是不同的歌。
 */
const workTitleKey = (name: string): string => {
  const stripped = stripVersionInfo(name).replace(BRACKETED_PART_PATTERN, (part) =>
    !isVersionDecoration(part) && DISTINCT_PART_PATTERN.test(part) ? part : " "
  );
  const suffix = stripped.match(DECORATED_SUFFIX_PATTERN);
  const core =
    suffix && isVersionDecoration(suffix[1]!) ? stripped.slice(0, suffix.index) : stripped;
  return normalizeComparableText(core) || normalizeComparableText(name);
};

/** 一首歌所有可比的作品曲名：曲名、所指原曲的曲名、译名与别名。单字的键太容易撞，不收。 */
const workTitleKeys = (song: WorkComparableSong): Set<string> =>
  new Set(
    [song.title, song.originSongTitle, ...aliasesOf(song)]
      .filter((name): name is string => Boolean(name?.trim()))
      .map(workTitleKey)
      .filter((key) => key.length >= 2)
  );

/** 网易云的翻唱回指：一边是另一边的原曲，或两边指向同一首原曲（ID 已是统一 URN）。 */
const sharesOriginSong = (
  guess: WorkComparableSong,
  answer: WorkComparableSong,
  alternateSongIds: readonly string[]
): boolean => {
  const answerIds = new Set([answer.id, ...alternateSongIds]);
  if (answer.originSongId) answerIds.add(answer.originSongId);
  return [guess.id, guess.originSongId].some((id) => id !== undefined && answerIds.has(id));
};

const sameTitledVersion = (guess: WorkComparableSong, answer: WorkComparableSong): boolean => {
  const answerKeys = workTitleKeys(answer);
  const shared = [...workTitleKeys(guess)].filter((key) => answerKeys.has(key));
  if (shared.length === 0) return false;
  const guessCreators = originCreatorsOf(guess);
  const answerCreators = originCreatorsOf(answer);
  if (guessCreators && answerCreators) return artistsOverlap(guessCreators, answerCreators);
  return shared.some((key) => !GENERIC_TITLE_KEYS.has(key));
};

const classicalProfileOf = (song: WorkComparableSong) =>
  classicalWorkProfile([song.title, ...aliasesOf(song)], song.artist);

/** 猜测与答案是否同一作品（「其他版本也算对」开启时的判对口径）。 */
export const isSameWork = (
  guess: WorkComparableSong,
  answer: WorkComparableSong,
  alternateSongIds: readonly string[]
): boolean => {
  if (isSameAnswerSong(guess, answer, alternateSongIds)) return true;
  const classical = compareClassicalWorks(classicalProfileOf(guess), classicalProfileOf(answer));
  if (classical !== "unknown") return classical === "same";
  if (sharesOriginSong(guess, answer, alternateSongIds)) return true;
  return sameTitledVersion(guess, answer);
};
