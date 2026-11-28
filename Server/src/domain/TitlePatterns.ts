/**
 * 曲名版本标记的判定正则（伴奏/纯音乐/Live/Remix/feat 等）。
 *
 * 纯领域规则：出题候选过滤（application/songuessr）与番剧曲目匹配
 * （infrastructure/BangumiProvider）共用同一份词表，两边各自漂移会误杀同源候选。
 */
export const VERSION_MARKER_PATTERN =
  /(?:伴奏|纯音乐|电视尺寸|动画剪辑|\b(?:inst(?:rumental)?\.?|off\s*vocal|karaoke|tv\s*size|anime\s*edit|radio\s*edit|ver(?:sion)?\.?|version|mix|edit|remaster(?:ed)?|live|acoustic|demo|cover|remix|feat(?:uring)?\.?)\b)/iu;
export const BRACKETED_VERSION_PATTERN = /\s*[（(【[]\s*([^）)】\]]*)\s*[）)】\]]/gu;
/** 尾部装饰后缀：`曲名 - TV size -`、`曲名 ～TV size～`。日文波浪线 `〜`（U+301C）与全角 `～` 是两个字符，都要认。 */
export const DECORATED_VERSION_SUFFIX_PATTERN = /\s*[-~～〜–—]+\s*(.*?)\s*(?:[-~～〜–—]+\s*)?$/u;
export const BARE_VERSION_SUFFIX_PATTERN =
  /\s+(?:inst(?:rumental)?\.?|off\s*vocal|karaoke|伴奏|纯音乐|电视尺寸|动画剪辑|tv\s*size|anime\s*edit|radio\s*edit|remix|(?:[^\s]+\s+)?ver(?:sion)?\.?)\s*$/iu;
export const FEAT_SUFFIX_PATTERN =
  /\s*(?:[（(【[]\s*)?feat(?:uring)?\.?\s*[^）)】\]]+[）)】\]]?\s*$/iu;

/** 括号段（含日文引号）：`ブルーバード (青鸟)` 的译名、`小幸运 (电影《…》主题曲)` 的出处说明。 */
export const BRACKETED_PART_PATTERN = /[（(【[「『][^）)】\]」』]*[）)】\]」』]/gu;

/**
 * 区分「同一首歌的不同部分或编次」的括号段：带数字，或 Part、Vol.、Chapter、Edition、
 * 第…部/章/話 这类标记。它们不是说明文字，不能去掉，否则 `Song (Part 1)` 会被当成 `Song`。
 * 判不准的一律当作有区分意义（宁可错过）。
 */
export const DISTINCT_PART_PATTERN =
  /\p{Nd}|\b(?:part|pt|vol(?:ume)?|chapter|act|episode|ep|edition|side|reprise)\b|[上中下]篇|[前后後][编編]|第.+?[部章話话幕]/iu;

/**
 * 剥掉曲名里的版本标记（括号内的伴奏/Live/Remix 说明、尾部装饰后缀、feat 署名）。
 *
 * 循环到不再变化为止：一个曲名可能同时带多层标记，单趟替换会残留。
 */
export const stripVersionInfo = (value: string): string => {
  let result = value.replace(BRACKETED_VERSION_PATTERN, (match, metadata: string) =>
    VERSION_MARKER_PATTERN.test(metadata) ? "" : match
  );
  while (true) {
    const next = result
      .replace(DECORATED_VERSION_SUFFIX_PATTERN, (match, metadata: string) =>
        VERSION_MARKER_PATTERN.test(metadata) ? "" : match
      )
      .replace(BARE_VERSION_SUFFIX_PATTERN, "")
      .replace(FEAT_SUFFIX_PATTERN, "");
    if (next === result) return result;
    result = next;
  }
};
