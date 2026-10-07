/**
 * Bangumi 维基 BBCode 的解析：只认 Bangumi 实际用到的那几种标记，不认识的方括号原样保留为文字；
 * 未闭合或错位的标记同样退回文字，不吞内容。渲染见 `components/common/BangumiRichText`。
 */
export type MarkupTag = "b" | "i" | "u" | "s" | "mask" | "url" | "size" | "color" | "quote" | "center" | "right" | "left" | "code";
export type MarkupElement = { tag: MarkupTag; value?: string; raw: string; children: MarkupNode[] };
export type MarkupNode = string | MarkupElement;

const TOKEN = /\[(\/?)(b|i|u|s|mask|url|size|color|quote|center|right|left|code)(?:=([^\]\n]*))?\]/gi;

export function parseBangumiMarkup(source: string): MarkupNode[] {
  const root: MarkupNode[] = [];
  const stack: Array<MarkupElement> = [];
  const top = () => stack.at(-1)?.children ?? root;
  const text = (value: string) => {
    if (!value) return;
    const list = top();
    if (typeof list.at(-1) === "string") list[list.length - 1] += value;
    else list.push(value);
  };
  // 未闭合的标记退回文字：开标记原样作文字，子内容并回上一层。
  const unwind = (node: MarkupElement) => {
    text(node.raw);
    for (const child of node.children) {
      if (typeof child === "string") text(child);
      else top().push(child);
    }
  };
  let last = 0;
  for (const match of source.matchAll(TOKEN)) {
    text(source.slice(last, match.index));
    last = match.index + match[0].length;
    const tag = match[2]!.toLowerCase() as MarkupTag;
    if (!match[1]) {
      const node = { tag, value: match[3], raw: match[0], children: [] };
      top().push(node);
      stack.push(node);
      continue;
    }
    const depth = stack.findLastIndex((node) => node.tag === tag);
    if (depth === -1) { text(match[0]); continue; }
    // 先闭合了外层：中间没闭合的内层退回文字
    while (stack.length - 1 > depth) {
      const inner = stack.pop()!;
      const parent = top();
      parent.splice(parent.indexOf(inner), 1);
      unwind(inner);
    }
    stack.pop();
  }
  text(source.slice(last));
  while (stack.length) {
    const node = stack.pop()!;
    const parent = top();
    parent.splice(parent.indexOf(node), 1);
    unwind(node);
  }
  return root;
}

export const plainText = (nodes: MarkupNode[]): string => nodes.map((node) => (typeof node === "string" ? node : plainText(node.children))).join("");
