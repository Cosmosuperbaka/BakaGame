/**
 * 更新日志正文的轻量标记解析。
 *
 * changelog.json 的 content 用纯文本书写，无需 HTML 标签：
 *   - 以 `-` 或 `*` 开头的行是列表项
 *   - 其余非空行是段落
 *   - 行内支持 `**加粗**`、`` `等宽` `` 和 `[文字](链接)`
 *
 * 解析结果为结构化节点，由渲染层转成 React 元素，
 * 不使用 dangerouslySetInnerHTML。
 */

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

export type BlockNode =
  | { kind: "list"; items: InlineNode[][] }
  | { kind: "paragraph"; content: InlineNode[] };

/** 行内标记：加粗、等宽、链接。链接只接受 http(s) 与站内相对路径。 */
const INLINE_PATTERN = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let cursor = 0;

  for (const match of source.matchAll(INLINE_PATTERN)) {
    const at = match.index ?? 0;
    if (at > cursor) nodes.push({ kind: "text", text: source.slice(cursor, at) });

    const [raw, strong, code, linkText, linkHref] = match;
    if (strong !== undefined) {
      nodes.push({ kind: "strong", text: strong });
    } else if (code !== undefined) {
      nodes.push({ kind: "code", text: code });
    } else if (linkText !== undefined && linkHref !== undefined) {
      const safe = /^(https?:\/\/|\/)/.test(linkHref);
      nodes.push(
        safe
          ? { kind: "link", text: linkText, href: linkHref }
          : { kind: "text", text: linkText },
      );
    }
    cursor = at + raw.length;
  }

  if (cursor < source.length) nodes.push({ kind: "text", text: source.slice(cursor) });
  return nodes;
}

export function parseChangelogContent(content: string): BlockNode[] {
  const blocks: BlockNode[] = [];
  let list: InlineNode[][] | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      list = null;
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) {
        list = [];
        blocks.push({ kind: "list", items: list });
      }
      list.push(parseInline(bullet[1]));
      continue;
    }

    list = null;
    blocks.push({ kind: "paragraph", content: parseInline(line) });
  }

  return blocks;
}
