/**
 * 许可证原文多按 80 列硬换行。抽屉比 80 列窄，`pre-wrap` 会把每一行再折一次，
 * 读出来是「to any person obtaining a / copy / of this software…」这种一行一个词的锯齿。
 *
 * 这里只把「普通段落」里的硬换行并回空格，让浏览器按抽屉宽度重新折行；
 * 带缩进、列表记号或整段很短（标题、版权行）的块原样保留，条款编号与对齐不受影响。
 * 只改换行，不动任何字符，原文内容逐字不变。
 */

/** 段落里出现这些行首就按「有版式的块」原样保留。 */
const STRUCTURED_LINE = /^(\s|[-*•+]\s|\d+[.)]\s|\(?[a-z0-9]{1,3}\)\s|[A-Z][A-Z0-9 ]{2,}:?$)/;

/** 硬换行的段落至少有一行接近常见的折行宽度；全是短行的块多半是标题或签名，不并。 */
const WRAPPED_LINE_MIN = 60;

export function reflowLicenseText(text: string): string {
  return text
    .split(/(\n[ \t]*\n)/)
    .map((block) => {
      // 分隔符（空行）原样留下。
      if (!block.trim() || /^\n[ \t]*\n$/.test(block)) return block;
      const lines = block.split("\n");
      if (lines.length < 2) return block;
      if (lines.some((line) => STRUCTURED_LINE.test(line))) return block;
      if (!lines.some((line) => line.length >= WRAPPED_LINE_MIN)) return block;
      return lines.map((line) => line.trim()).join(" ");
    })
    .join("");
}
