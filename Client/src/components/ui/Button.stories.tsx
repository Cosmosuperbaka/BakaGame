import type { Meta, StoryObj } from "@storybook/react-vite";
import { Copy, Play, Send, Trash2 } from "lucide-react";
import { Button } from "./Button";

const meta = {
  title: "基础控件/Button",
  component: Button,
  args: { children: "开始游戏" },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

const VARIANTS = [
  ["default", "开始游戏"],
  ["secondary", "取消准备"],
  ["outline", "复制链接"],
  ["ghost", "返回大厅"],
  ["destructive", "踢出玩家"],
  ["link", "查看更新日志"],
] as const;

const SIZES = ["sm", "default", "lg"] as const;

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

export const Variants: Story = {
  name: "变体与尺寸",
  render: () => (
    <div className="grid w-[58rem] gap-4">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-wrap items-center gap-3">
          {VARIANTS.map(([variant, label]) => (
            <Button key={variant} variant={variant} size={size}>
              {label}
            </Button>
          ))}
        </div>
      ))}
    </div>
  ),
};

export const States: Story = {
  name: "图标、加载与禁用",
  render: () => (
    <div className="flex w-[58rem] flex-wrap items-center gap-3">
      <Button><Play />开始游戏</Button>
      <Button variant="outline"><Copy />复制</Button>
      <Button variant="destructive"><Trash2 />移除</Button>
      <Button size="icon" aria-label="发送消息"><Send /></Button>
      <Button size="icon" variant="ghost" aria-label="复制链接"><Copy /></Button>
      <Button loading>开始游戏</Button>
      <Button variant="outline" loading>保存中</Button>
      <Button disabled>等待玩家准备 (1/3)</Button>
      <Button variant="outline" disabled>复制</Button>
    </div>
  ),
};
