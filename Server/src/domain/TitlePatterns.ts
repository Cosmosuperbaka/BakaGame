/**
 * 曲名版本标记的判定正则（伴奏/纯音乐/Live/Remix/feat 等）。
 *
 * 纯领域规则：出题候选过滤（application/songuessr）与番剧曲目匹配
 * （infrastructure/BangumiProvider）共用同一份词表，两边各自漂移会误杀同源候选。
 */
export const VERSION_MARKER_PATTERN =
  /(?:伴奏|纯音乐|电视尺寸|动画剪辑|\b(?:inst(?:rumental)?\.?|off\s*vocal|karaoke|tv\s*size|anime\s*edit|radio\s*edit|ver(?:sion)?\.?|version|mix|edit|remaster(?:ed)?|live|acoustic|demo|cover|remix|feat(?:uring)?\.?)\b)/iu;
export const BRACKETED_VERSION_PATTERN = /\s*[（(【[]\s*([^）)】\]]*)\s*[）)】\]]/gu;
export const DECORATED_VERSION_SUFFIX_PATTERN = /\s*[-~～–—]+\s*(.*?)\s*(?:[-~～–—]+\s*)?$/u;
export const BARE_VERSION_SUFFIX_PATTERN =
  /\s+(?:inst(?:rumental)?\.?|off\s*vocal|karaoke|伴奏|纯音乐|电视尺寸|动画剪辑|tv\s*size|anime\s*edit|radio\s*edit|remix|(?:[^\s]+\s+)?ver(?:sion)?\.?)\s*$/iu;
export const FEAT_SUFFIX_PATTERN =
  /\s*(?:[（(【[]\s*)?feat(?:uring)?\.?\s*[^）)】\]]+[）)】\]]?\s*$/iu;

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
