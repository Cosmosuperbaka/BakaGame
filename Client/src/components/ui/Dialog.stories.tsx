import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { Button } from "./Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./Dialog";
import { Input } from "./Input";

const meta = {
  title: "基础控件/Dialog",
  component: Dialog,
  tags: ["overlay"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 默认打开；关闭后留下真实的触发按钮，交互调试时可以再次打开。 */
function DialogDemo({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="p-6">
      <Button variant="outline" onClick={() => setOpen(true)}>
        {trigger}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>{children}</DialogContent>
      </Dialog>
    </div>
  );
}

export const PasswordPrompt: Story = {
  name: "输入房间密码",
  render: () => (
    <DialogDemo trigger="加入房间">
      <DialogHeader>
        <DialogTitle>输入房间密码</DialogTitle>
        <DialogDescription>房间 &ldquo;小布丁的房间&rdquo; 需要密码</DialogDescription>
      </DialogHeader>
      <Input type="password" placeholder="请输入密码" className="h-10 text-base" />
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">取消</Button>
        </DialogClose>
        <Button>加入</Button>
      </DialogFooter>
    </DialogDemo>
  ),
};

export const DestructiveConfirm: Story = {
  name: "危险操作确认",
  render: () => (
    <DialogDemo trigger="放弃本局">
      <DialogHeader>
        <DialogTitle>放弃本局</DialogTitle>
        <DialogDescription>确认后本局无法继续猜测，组队时会影响整个队伍。</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">继续猜测</Button>
        </DialogClose>
        <Button variant="destructive">确认放弃</Button>
      </DialogFooter>
    </DialogDemo>
  ),
  // 打开时 Radix 把焦点交给首个按钮；鼠标点开时按钮不显示焦点环，这里移开焦点与之对齐。
  play: async () => {
    await screen.findByRole("dialog");
    dropFocus();
  },
};
