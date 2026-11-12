import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "./Badge";
import { Collapsible } from "./Collapsible";

const meta = {
  title: "基础控件/Collapsible",
  component: Collapsible,
  args: {
    title: "许可证原文",
    children: (
      <p className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">
        MIT License{"\n\n"}Permission is hereby granted, free of charge, to any person obtaining a
        copy of this software and associated documentation files.
      </p>
    ),
  },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Collapsible>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

/** 依赖抽屉底部的许可证原文：分隔线下一枚标题胶囊，收起与展开各一份；展开时标题转为正文色。 */
export const Default: Story = {
  name: "收起与展开",
  render: (args) => (
    <div className="space-y-6">
      {[false, true].map((open) => (
        <div key={String(open)} className="space-y-3 rounded-md border bg-popover p-4">
          <p className="text-sm">vite · 7.1.0 · MIT</p>
          <div className="border-t pt-3">
            <Collapsible {...args} defaultOpen={open} />
          </div>
        </div>
      ))}
    </div>
  ),
};

/** 弹窗里的说明（登录说明、连接信息）：`size="sm"`，与周围 text-xs 的说明同字号。 */
export const Notice: Story = {
  name: "说明 · 小号",
  args: {
    title: "登录说明",
    size: "sm",
    defaultOpen: true,
    children: (
      <div className="space-y-1.5 text-xs text-muted-foreground">
        <p>登录只用于少数需要身份验证的功能：云同步设置、查看自己反馈的回复。</p>
        <p>不登录也能游玩并匿名提交反馈。</p>
      </div>
    ),
  },
};

/** CEE 反馈表这类 text-xs 的密集区域用 `size="sm"`，标题与箭头随之收小，不比周围的标签更醒目。 */
export const Small: Story = {
  name: "密集区域 · 小号",
  args: {
    title: "游戏专属标签",
    size: "sm",
    children: (
      <div className="flex flex-wrap gap-1 text-xs">
        <Badge size="sm" variant="matched">
          吉他
        </Badge>
        <Badge size="sm" variant="muted">
          作曲
        </Badge>
      </div>
    ),
  },
  render: (args) => (
    <div className="space-y-6">
      {[false, true].map((open) => (
        <div key={String(open)} className="space-y-2 rounded-md border bg-panel p-3">
          <p className="text-xs text-success">共同作品：示例作品</p>
          <div className="flex flex-wrap gap-1">
            <Badge size="sm" variant="muted">
              鼓手
            </Badge>
            <Badge size="sm" variant="matched">
              队长
            </Badge>
          </div>
          <Collapsible {...args} defaultOpen={open} />
        </div>
      ))}
    </div>
  ),
};
