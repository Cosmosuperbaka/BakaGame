import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { Button } from "./Button";
import { Sheet } from "./Sheet";

const meta = {
  title: "基础控件/Sheet",
  component: Sheet,
  tags: ["overlay"],
  parameters: { layout: "fullscreen" },
  // meta 先把必填入参补齐，stories 只覆盖自己关心的交互；真实渲染由 render 里的包装组件驱动。
  args: {
    open: true,
    onOpenChange: () => {},
    title: "许可证",
    children: null,
  },
} satisfies Meta<typeof Sheet>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 默认打开；关闭后留下真实的触发按钮，交互调试时可以再次打开。 */
function SheetDemo({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="p-6">
      <Button variant="outline" onClick={() => setOpen(true)}>
        打开侧边面板
      </Button>
      <Sheet open={open} onOpenChange={setOpen} title={title}>
        {children}
      </Sheet>
    </div>
  );
}

export const Basic: Story = {
  name: "基础",
  render: () => (
    <SheetDemo title="许可证">
      <p className="text-sm">
        侧边面板固定在最右缘，标题栏不随内容滚动；正文区自己滚动，长内容不会把页面撑高。
      </p>
      <p className="mt-3 text-sm text-muted-foreground">
        按 Esc、点遮罩或右上角的关闭按钮都能收起面板，关闭后焦点回到打开它的按钮。
      </p>
    </SheetDemo>
  ),
  // 打开时 Radix 把焦点交给面板；鼠标点开时按钮不显示焦点环，这里移开焦点与之对齐。
  play: async () => {
    await screen.findByRole("dialog", { name: "许可证" });
    dropFocus();
  },
};

export const Scrollable: Story = {
  name: "长内容内部滚动",
  render: () => (
    <SheetDemo title="长内容">
      <div className="space-y-3">
        {Array.from({ length: 24 }, (_, index) => (
          <p key={index} className="text-sm text-muted-foreground">
            第 {index + 1} 段内容。标题栏固定，这一段会随内容区一起滚动，页面本身不滚动。
          </p>
        ))}
      </div>
    </SheetDemo>
  ),
  play: async () => {
    await screen.findByRole("dialog", { name: "长内容" });
    dropFocus();
  },
};
