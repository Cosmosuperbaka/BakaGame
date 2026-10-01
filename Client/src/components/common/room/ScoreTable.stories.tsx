import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "@/components/ui/Badge";
import { ROLE_COLORS, ROLE_LABELS } from "@/config/WhoIsFakerPresentation";
import { ScoreTable, type ScoreTableColumn } from "./ScoreTable";

// 三个游戏的结算各自在房间页与阶段故事里出现；这里在接近手机内容宽度的框里看折行与对齐。
const meta = {
  title: "公共组件/ScoreTable",
  decorators: [(Story) => <div className="w-[20rem] rounded-md border bg-panel p-4"><Story /></div>],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const ROLE_COLUMNS: ScoreTableColumn[] = [
  { key: "role", header: "身份", align: "left" },
  { key: "delta", header: "本局", signed: true },
  { key: "total", header: "总分", tone: "strong" },
];

const ROLE_ROWS = [
  { name: "Christopher_Wellington", role: "undercover", delta: 3, total: 11 },
  { name: "长名字的平民玩家会折成两行", role: "civilian", delta: 1, total: 7 },
  { name: "阿紫", role: "angel", delta: 2, total: 4 },
  { name: "小白", role: "blank", delta: 0, total: 0 },
] satisfies Array<{ name: string; role: keyof typeof ROLE_LABELS; delta: number; total: number }>;

/** 谁是卧底的身份列：徽章左对齐，零分不补「+」，长拉丁名与长中文名都在名字列内断开。 */
export const RoleColumn: Story = {
  name: "身份徽章列 · 长名字",
  render: () => (
    <ScoreTable
      title="身份揭示与得分统计"
      columns={ROLE_COLUMNS}
      rows={ROLE_ROWS.map((row) => ({
        key: row.name,
        name: row.name,
        cells: {
          role: <Badge variant="outline" size="xs" className={ROLE_COLORS[row.role]}>{ROLE_LABELS[row.role]}</Badge>,
          delta: row.delta,
          total: row.total,
        },
      }))}
    />
  ),
};

/** CCB 的明细次行：出题人的扣分照原样显示负号，没有名次时显示破折号。 */
export const DetailRow: Story = {
  name: "明细次行 · 负分",
  render: () => (
    <ScoreTable
      title="本局得分"
      columns={[
        { key: "rank", header: "名次" },
        { key: "score", header: "得分", signed: true, tone: "strong" },
      ]}
      rows={[
        { key: "a", name: "月见里", detail: ["猜中角色", "基础 8", "首猜 2", "快速 2", "作品 0", "出题 0"], cells: { rank: 1, score: 12 } },
        { key: "b", name: "Sakuraba", detail: ["基础 0", "首猜 0", "快速 0", "作品 0", "出题 0"], cells: { rank: "—", score: 0 } },
        { key: "c", name: "出题人", detail: ["纯在送分", "基础 0", "首猜 0", "快速 0", "作品 0", "出题 -6"], cells: { rank: "—", score: -6 } },
      ]}
    />
  ),
};
