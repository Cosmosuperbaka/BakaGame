/**
 * 随机选区间时回避歌名：判断歌词窗口里有没有直接唱出（或写出）歌名。
 *
 * 只服务服务端随机切片；玩家自定义的区间不经过这里。
 * 判定宁可放过不可错杀：判不出的一律当作「不含歌名」，避免规则把所有窗口都判脏、
 * 让「优先干净区间」退化成永远回退。
 */
import { VERSION_MARKER_PATTERN } from "../../domain/TitlePatterns";
import { normalizeComparableText } from "../../infrastructure/music/MusicDeduplicator";
import type { SongDetails, SongLyricLine } from "../../shared/Index";
import { stripVersionInfo } from "../../domain/TitlePatterns";
import { splitTitleSegments } from "./SongTitleMatching";

/**
 * 「短歌名」上限（归一化后的字符数），短歌名只按整行等同判定，不做子串匹配。
 * 单个汉字/假名几乎处处是子串，子串匹配会把整首歌判脏；两个汉字的歌名（晴天、夜曲）
 * 是常见的真实歌名，唱出来就等于泄题，仍按子串判定。拉丁字母的词则放宽到两个字符（Go、Me）。
 */
export const SHORT_CJK_TITLE_MAX_LENGTH = 1;
export const SHORT_LATIN_TITLE_MAX_LENGTH = 2;

/** 含日文假名、汉字、韩文的名字走紧凑子串匹配；纯拉丁字母数字走词边界匹配。 */
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 紧凑形：繁简、全半角、大小写、空白与标点全部抹平。 */
const compact = (value: string): string =>
  normalizeComparableText(value).replace(/[\p{P}\p{S}\s]+/gu, "");

/** 词形：保留词边界，非字母数字一律折成单个空格，两端补空格便于整词匹配。 */
const tokens = (value: string): string => {
  const words = value
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return ` ${words.join(" ")} `;
};

/** 括号内外的片段：`原名 (译名)` 里的译名同样会被唱到，也要回避。 */
const BRACKET_PARTS = /[（(【[「『]([^）)】\]」』]*)[）)】\]」』]/gu;

/**
 * 一首歌的所有「歌名写法」：原名、去版本后缀的核心名（Live、TV Size 等不算歌名的一部分）、
 * 括号内外的拆段、并列曲名的各段，以及百科里的别名/译名。
 */
export const songTitleNames = (
  song: Pick<SongDetails, "title"> & { encyclopedia?: { aliases?: string[] } }
): string[] => {
  const names = new Set<string>();
  const add = (value: string | undefined) => {
    const text = value?.trim();
    if (text) names.add(text);
  };
  const base = song.title ?? "";
  add(base);
  const core = stripVersionInfo(base);
  add(core);
  for (const source of [base, core]) {
    add(source.replace(BRACKET_PARTS, " "));
    for (const match of source.matchAll(BRACKET_PARTS)) {
      // Live、TV Size 之类的版本标注不是歌名，歌词里唱到 live 不该被判成唱了歌名。
      if (!VERSION_MARKER_PATTERN.test(match[1])) add(match[1]);
    }
  }
  for (const segment of splitTitleSegments(core)) add(segment);
  for (const alias of song.encyclopedia?.aliases ?? []) add(alias);
  return [...names];
};

interface PreparedName {
  compact: string;
  tokens: string;
  cjk: boolean;
  short: boolean;
}

const prepareNames = (names: readonly string[]): PreparedName[] => {
  const seen = new Set<string>();
  const prepared: PreparedName[] = [];
  for (const name of names) {
    const flat = compact(name);
    if (!flat || seen.has(flat)) continue;
    seen.add(flat);
    const cjk = CJK_PATTERN.test(name);
    prepared.push({
      compact: flat,
      tokens: tokens(name),
      cjk,
      short: flat.length <= (cjk ? SHORT_CJK_TITLE_MAX_LENGTH : SHORT_LATIN_TITLE_MAX_LENGTH),
    });
  }
  return prepared;
};

/** 一段文本（可能是一行，也可能是相邻几行拼接）是否唱出了这个名字。 */
const textHasName = (text: string, wholeLine: boolean, name: PreparedName): boolean => {
  const flat = compact(text);
  if (!flat) return false;
  // 短歌名只认整行就是歌名，原因见 SHORT_* 常量。
  if (name.short) return wholeLine && flat === name.compact;
  if (name.cjk) return flat.includes(name.compact);
  return tokens(text).includes(name.tokens);
};

const lineFields = (line: SongLyricLine): string[] =>
  [line.text, line.translatedLyric, line.romanLyric].filter((value): value is string =>
    Boolean(value)
  );

/**
 * 窗口里唱出歌名的行数（0 表示干净）。逐行检查，并把相邻几行拼接后再查一遍，
 * 以覆盖歌名被换行拆开的情形；译文与罗马音同样会展示给玩家，一并检查。
 */
export const countTitleLines = (
  lines: readonly SongLyricLine[],
  names: PreparedTitleNames
): number => {
  if (names.length === 0) return 0;
  const flagged = new Set<number>();
  lines.forEach((line, index) => {
    for (const field of lineFields(line)) {
      if (names.some((name) => textHasName(field, true, name))) flagged.add(index);
    }
  });
  if (flagged.size > 0 || lines.length < 2) return flagged.size;
  // 只有跨行拼接才出现歌名：算一处命中，让它排在干净窗口之后。
  const pickers = [
    (line: SongLyricLine) => line.text,
    (line: SongLyricLine) => line.translatedLyric ?? "",
    (line: SongLyricLine) => line.romanLyric ?? "",
  ];
  const joinedHit = pickers.some((pick) => {
    const joined = lines.map(pick).join(" ");
    return names.some((name) => !name.short && textHasName(joined, false, name));
  });
  return joinedHit ? 1 : 0;
};

export type PreparedTitleNames = readonly PreparedName[];

/** 预处理一次歌名写法，供对大量窗口反复判定。 */
export const prepareTitleNames = (names: readonly string[]): PreparedTitleNames =>
  prepareNames(names);
