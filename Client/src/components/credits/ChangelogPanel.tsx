import { Badge } from "@/components/ui/Badge";
import {
  parseChangelogEntry,
  sortEntriesByVersion,
  type ChangelogContent,
  type ChangelogEntry,
  type InlineNode,
} from "@/lib/Changelog";

/** 行内标记：加粗、等宽与链接，解析结果来自 `lib/Changelog.ts`，不使用 HTML 注入。 */
function InlineContent({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.kind) {
          case "strong":
            return (
              <strong key={index} className="font-semibold text-foreground">
                {node.text}
              </strong>
            );
          case "code":
            return (
              <code key={index} className="rounded-md bg-muted px-1 py-0.5 font-mono text-xs">
                {node.text}
              </code>
            );
          case "link":
            return (
              <a
                key={index}
                href={node.href}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-2"
              >
                {node.text}
              </a>
            );
          default:
            return <span key={index}>{node.text}</span>;
        }
      })}
    </>
  );
}

/** 单个版本的正文：只渲染有实际内容的分类，分类顺序由解析层按规范排好。 */
function ChangelogBody({ content }: { content: ChangelogContent }) {
  const sections = parseChangelogEntry(content);

  if (sections.length === 0) {
    return <div className="py-2 text-sm text-muted-foreground">暂无详细说明</div>;
  }

  return (
    <div className="space-y-3">
      {sections.map((section) => (
        <div
          key={section.type}
          className="space-y-1.5"
          data-testid={`changelog-category-${section.type}`}
        >
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" size="xs" className="font-mono lowercase">
              {section.type}
            </Badge>
            <span className="text-xs font-semibold text-foreground">{section.label}</span>
          </div>
          <div className="space-y-1 pl-0.5 text-sm text-muted-foreground">
            {section.blocks.map((block, index) =>
              block.kind === "list" ? (
                <ul key={index} className="ml-4 list-outside list-disc space-y-1">
                  {block.items.map((item, itemIndex) => (
                    <li key={itemIndex} className="pl-0.5">
                      <InlineContent nodes={item} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p key={index}>
                  <InlineContent nodes={block.content} />
                </p>
              )
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 更新日志标签：按版本号从新到旧排列，宽屏版本号在左栏随内容滚动吸顶。
 * 内容在构建期定型，不存在加载中状态。
 */
export function ChangelogPanel({ entries }: { entries: readonly ChangelogEntry[] }) {
  if (entries.length === 0) {
    return <div className="py-10 text-center text-sm text-muted-foreground">暂无更新日志</div>;
  }

  return (
    <ol className="space-y-6">
      {sortEntriesByVersion(entries).map((entry) => (
        <li key={entry.version} className="grid gap-2 sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:gap-4">
          <div className="flex items-baseline gap-2 sm:sticky sm:top-0 sm:flex-col sm:gap-0.5 sm:self-start">
            <strong className="text-base">V{entry.version}</strong>
            <span className="text-xs text-muted-foreground">{entry.date}</span>
          </div>
          <ChangelogBody content={entry.content} />
        </li>
      ))}
    </ol>
  );
}
