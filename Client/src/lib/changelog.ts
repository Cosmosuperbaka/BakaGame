/**
 * 更新日志正文的轻量标记解析。
 *
 * changelog.json 的 content 用纯文本书写，无需 HTML 标签：
 *   - 以 `-` 或 `*` 开头的行是列表项
 *   - 其余非空行是段落
 *   - 行内支持 `**加粗**`、`` `等宽` `` 和 `[文字](链接)`
 *
 * content 可以写成字符串，也可以写成字符串数组——数组的每一项就是一行，
 * 于是 JSON 里的换行等于日志里的换行，不必把整段挤进一行再插 `\n`。
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

/** 正文来源：单串（内含 \n）或每项一行的数组。 */
export type ChangelogContent = string | string[];

export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  content: ChangelogContent;
}

/** 把 "1.2.3" 拆成可比较的数字元组；缺位补 0，非数字段按 0 处理。 */
const parseVersion = (version: string): number[] =>
  version
    .trim()
    .replace(/^[vV]/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);

/** 语义化版本比较：a 比 b 新则为正。逐段按数字比，避免 1.10.0 被判小于 1.9.0。 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 取更新日志里的最新版本号：按版本号大小选，不依赖数组顺序，
 * 也不需要另外维护一个 currentVersion 字段。
 */
export function resolveLatestVersion(entries: readonly ChangelogEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  return entries.reduce(
    (latest, entry) => (compareVersions(entry.version, latest) > 0 ? entry.version : latest),
    entries[0].version,
  );
}

/** 更新日志按版本号从新到旧排序，JSON 里的书写顺序不影响展示。 */
export function sortEntriesByVersion<T extends ChangelogEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => compareVersions(b.version, a.version));
}

/** 把两种写法归一成行数组；数组项自身仍可包含换行。 */
const toLines = (content: ChangelogContent): string[] =>
  (Array.isArray(content) ? content : [content]).flatMap((chunk) => chunk.split(/\r?\n/));

export function parseChangelogContent(content: ChangelogContent): BlockNode[] {
  const blocks: BlockNode[] = [];
  let list: InlineNode[][] | null = null;

  for (const rawLine of toLines(content)) {
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
