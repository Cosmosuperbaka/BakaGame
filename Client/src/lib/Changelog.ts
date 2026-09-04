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

/** 更新日志支持的标准分类类型。 */
export type ChangelogType =
  | "feat"
  | "fix"
  | "chore"
  | "perf"
  | "refactor"
  | "style"
  | "docs"
  | "test"
  | "build"
  | "ci"
  | "revert";

/** 各分类在界面展示的中文语义标签。 */
export const CHANGELOG_TYPE_LABELS: Record<string, string> = {
  feat: "新功能",
  fix: "问题修复",
  chore: "日常维护",
  perf: "性能优化",
  refactor: "代码重构",
  style: "样式与界面",
  docs: "文档说明",
  test: "测试补充",
  build: "构建更新",
  ci: "持续集成",
  revert: "变更回退",
};

/** 标准分类呈现顺序。 */
export const CHANGELOG_TYPE_ORDER: readonly string[] = [
  "feat",
  "fix",
  "perf",
  "style",
  "refactor",
  "docs",
  "chore",
  "test",
  "build",
  "ci",
  "revert",
];

/** 单个分类的正文来源：单串（内含 \n）或每项一行的数组。 */
export type ChangelogCategoryContent = string | string[];

/**
 * 更新日志内容结构：按变更类型聚合的键值对象。
 * 如某版本有对应类型更新就填入对应类型的，未填写或空的类型不包含。
 */
export type ChangelogContent = Partial<Record<ChangelogType, ChangelogCategoryContent>> &
  Record<string, ChangelogCategoryContent | undefined>;

export interface ChangelogEntry {
  version: string;
  date: string;
  content: ChangelogContent;
}

/** 解析后的分类区块定义，供页面按需渲染。 */
export interface ParsedCategorySection {
  type: string;
  label: string;
  blocks: BlockNode[];
}

import { compareVersions as semverCompare } from "compare-versions";

/**
 * 语义化版本比较：a 比 b 新则为正（1），旧则为负（-1），相同为 0。
 * 借助 compare-versions 严格遵循 SemVer 2.0.0 规范，正确支持预发版本与构建元数据。
 */
export function compareVersions(a: string, b: string): number {
  return semverCompare(a.trim(), b.trim());
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
const toLines = (content: ChangelogCategoryContent): string[] =>
  (Array.isArray(content) ? content : [content]).flatMap((chunk) => chunk.split(/\r?\n/));

export function parseChangelogContent(content: ChangelogCategoryContent): BlockNode[] {
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

/**
 * 解析单个版本的分类更新日志。
 * 仅提取有实际非空更新的分类，按规范顺序排列；未填写或为空的分类坚决不包含在结果中。
 */
export function parseChangelogEntry(content: ChangelogContent): ParsedCategorySection[] {
  if (!content || typeof content !== "object") return [];

  const activeKeys = Object.keys(content).filter((key) => {
    const raw = content[key];
    if (!raw) return false;
    if (Array.isArray(raw)) {
      return raw.some((line) => line.trim().length > 0);
    }
    return raw.trim().length > 0;
  });

  activeKeys.sort((a, b) => {
    const idxA = CHANGELOG_TYPE_ORDER.indexOf(a);
    const idxB = CHANGELOG_TYPE_ORDER.indexOf(b);
    const orderA = idxA === -1 ? Number.MAX_SAFE_INTEGER : idxA;
    const orderB = idxB === -1 ? Number.MAX_SAFE_INTEGER : idxB;
    if (orderA !== orderB) return orderA - orderB;
    return a.localeCompare(b);
  });

  const sections: ParsedCategorySection[] = [];
  for (const key of activeKeys) {
    const raw = content[key];
    if (!raw) continue;
    const blocks = parseChangelogContent(raw);
    if (blocks.length > 0) {
      sections.push({
        type: key,
        label: CHANGELOG_TYPE_LABELS[key] ?? key,
        blocks,
      });
    }
  }

  return sections;
}

