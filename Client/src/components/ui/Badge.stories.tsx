import type { Meta, StoryObj } from "@storybook/react-vite";
import { Clock3, Eye, EyeOff, Shield } from "lucide-react";
import { Badge } from "./Badge";

const meta = {
  title: "基础控件/Badge",
  component: Badge,
  args: { children: "等待中" },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

export const Variants: Story = {
  name: "全部变体",
  render: () => (
    <div className="flex w-[36rem] flex-wrap items-center gap-3">
      <Badge>OP</Badge>
      <Badge variant="secondary">fix</Badge>
      <Badge variant="destructive">8s</Badge>
      <Badge variant="outline">默认热歌榜</Badge>
      <Badge variant="outline">歌手：LiSA</Badge>
      <Badge variant="outline">评分 8.9</Badge>
    </div>
  ),
};

export const WithIcons: Story = {
  name: "带图标",
  render: () => (
    <div className="flex w-[36rem] flex-wrap items-center gap-3">
      <Badge variant="outline" className="gap-1 font-mono">
        <Clock3 className="h-3.5 w-3.5" />
        42s
      </Badge>
      <Badge variant="destructive" className="gap-1 font-mono">
        <Clock3 className="h-3.5 w-3.5" />
        8s
      </Badge>
      <Badge variant="secondary" className="gap-1.5 px-3 py-1 text-xs font-medium">
        <Shield className="h-3.5 w-3.5 text-questioner" />
        出题人视角
      </Badge>
      <Badge variant="outline" className="gap-1 text-xs font-normal">
        <Eye className="h-3.5 w-3.5" />
        可观战
      </Badge>
      <Badge variant="outline" className="gap-1 border-dashed text-xs font-normal text-muted-foreground">
        <EyeOff className="h-3.5 w-3.5" />
        禁观战
      </Badge>
    </div>
  ),
};
