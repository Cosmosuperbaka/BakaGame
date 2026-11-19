/**
 * 文本字宽单位：CJK 与全角字符算 2 个单位，其余算 1 个。
 * 描述输入框的上限按它计，两端各抄一份会在口径漂移时让 Agent 与人类的输入行为分歧。
 */
export const textUnitsOf = (char: string): number => {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x9fff) || // CJK、部首、康熙等
    (code >= 0xa960 && code <= 0xa97f) || // Hangul Jamo Extended
    (code >= 0xac00 && code <= 0xd7ff) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility
    (code >= 0xfe10 && code <= 0xfe1f) || // Vertical Forms
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK Compatibility Forms
    (code >= 0xff01 && code <= 0xff60) || // Fullwidth Forms
    (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth Signs
    (code >= 0x1b000 && code <= 0x1b0ff) || // Kana Supplement
    (code >= 0x20000 && code <= 0x2fffd) || // CJK Unified Ideographs Extension B-F
    (code >= 0x30000 && code <= 0x3fffd) // CJK Unified Ideographs Extension G
    ? 2
    : 1;
};

export const textUnits = (text: string): number =>
  [...text].reduce((sum, char) => sum + textUnitsOf(char), 0);

/** 按字宽单位截到上限以内，不拆开一个字符。 */
export const clampUnits = (text: string, maxUnits: number): string => {
  let units = 0;
  let result = "";
  for (const char of text) {
    const width = textUnitsOf(char);
    if (units + width > maxUnits) break;
    units += width;
    result += char;
  }
  return result;
};

/** 卧底描述与补充发言的上限（≈10 个汉字或 20 个英文字符）。 */
export const FAKER_DESCRIPTION_MAX_UNITS = 20;

/**
 * 描述超出上限时给出拒绝说明，没超限返回 `undefined`。服务端命令入口与 Agent 入口共用这一个判定，
 * 上限与说明口径只有一份：两处各写一遍，口径一漂移就会出现「Agent 被拒、改过的客户端放行」。
 * 传入的应是已归一（去首尾空白、折叠连续空白）的文本：服务端按归一后的内容存储与展示。
 */
export const fakerDescriptionOverflow = (text: string): string | undefined => {
  const units = textUnits(text);
  if (units <= FAKER_DESCRIPTION_MAX_UNITS) return undefined;
  return `描述超出上限：最多 ${FAKER_DESCRIPTION_MAX_UNITS} 个字宽单位（约 ${FAKER_DESCRIPTION_MAX_UNITS / 2} 个汉字或 ${FAKER_DESCRIPTION_MAX_UNITS} 个英文字符，汉字与全角字符算 2），当前 ${units}`;
};
