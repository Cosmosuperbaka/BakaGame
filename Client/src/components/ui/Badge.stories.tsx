import type { Meta, StoryObj } from "@storybook/react-vite";
import { Clock3, Eye, EyeOff } from "lucide-react";
import { Badge } from "./Badge";

const meta = {
  title: "基础控件/Badge",
  component: Badge,
  args: { children: "等待中" },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

/** 四行依次为：实底强调标记、内容标签、卡片上的次要信息、挂在条目旁的微型提示。 */
export const Variants: Story = {
  name: "全部变体",
  render: () => (
    <div className="grid w-[36rem] gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge>OP</Badge>
        <Badge variant="secondary">fix</Badge>
        <Badge variant="destructive">8s</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant="outline">默认热歌榜</Badge>
        <Badge variant="outline">歌手：LiSA</Badge>
        <Badge variant="muted">双马尾</Badge>
        <Badge variant="matched">傲娇</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant="subtle">等待中</Badge>
        <Badge variant="active">游戏中</Badge>
        <Badge variant="subtle">
          <Eye className="h-3.5 w-3.5" />
          可旁观
        </Badge>
        <Badge variant="unavailable">
          <EyeOff className="h-3.5 w-3.5" />
          禁止旁观
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          示例歌曲
          <Badge variant="restricted" size="xs">会员专享</Badge>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          排位赛
          <Badge variant="upcoming" size="xs">即将上线</Badge>
        </div>
      </div>
    </div>
  ),
};

/** default 用于卡片与筛选条件，sm 用于密集的标签表格，xs 用于挂在名称或单元格旁的微型标记。 */
export const Sizes: Story = {
  name: "尺寸",
  render: () => (
    <div className="flex w-[36rem] flex-wrap items-center gap-3">
      <Badge variant="muted">双马尾</Badge>
      <Badge variant="muted" size="sm">双马尾</Badge>
      <Badge variant="matched" size="sm">傲娇</Badge>
      <Badge variant="muted" size="sm">已隐藏</Badge>
      <Badge variant="secondary" size="xs" className="font-mono lowercase">fix</Badge>
      <Badge variant="outline" size="xs">卧底</Badge>
    </div>
  ),
};

export const WithIcons: Story = {
  name: "带图标",
  render: () => (
    <div className="flex w-[36rem] flex-wrap items-center gap-3">
      <Badge variant="outline" className="font-mono">
        <Clock3 className="h-3.5 w-3.5" />
        42s
      </Badge>
      <Badge variant="destructive" className="font-mono">
        <Clock3 className="h-3.5 w-3.5" />
        8s
      </Badge>
    </div>
  ),
};
