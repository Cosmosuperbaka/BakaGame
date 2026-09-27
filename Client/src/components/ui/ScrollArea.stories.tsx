import type { Meta, StoryObj } from "@storybook/react-vite";
import changelogData from "@/data/changelog.json";
import {
  CHANGELOG_TYPE_LABELS,
  parseChangelogEntry,
  sortEntriesByVersion,
  type ChangelogEntry,
  type InlineNode,
} from "@/lib/Changelog";
import { ScrollArea } from "./ScrollArea";

const meta = {
  title: "基础控件/ScrollArea",
  component: ScrollArea,
} satisfies Meta<typeof ScrollArea>;

export default meta;
type Story = StoryObj<typeof meta>;

const plain = (nodes: InlineNode[]) => nodes.map((node) => node.text).join("");

// 取真实更新日志的条目作长列表，内容量足以超出容器高度。
const CHANGELOG_LINES = sortEntriesByVersion((changelogData as { entries: ChangelogEntry[] }).entries)
  .slice(0, 6)
  .flatMap((entry) =>
    parseChangelogEntry(entry.content).flatMap((section) =>
      section.blocks.flatMap((block, blockIndex) =>
        (block.kind === "list" ? block.items : [block.content]).map((nodes, index) => ({
          key: `${entry.version}-${section.type}-${blockIndex}-${index}`,
          meta: `V${entry.version} · ${CHANGELOG_TYPE_LABELS[section.type] ?? section.type}`,
          text: plain(nodes),
        })),
      ),
    ),
  );

export const LongContent: Story = {
  name: "长内容裁切",
  render: () => (
    <ScrollArea className="h-72 w-80 rounded-md border bg-panel">
      <ul className="space-y-3 p-4">
        {CHANGELOG_LINES.map((line) => (
          <li key={line.key} className="space-y-0.5">
            <div className="text-xs text-muted-foreground">{line.meta}</div>
            <div className="text-sm break-words">{line.text}</div>
          </li>
        ))}
      </ul>
    </ScrollArea>
  ),
};
