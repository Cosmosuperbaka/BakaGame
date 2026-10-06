import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Plus } from "lucide-react";
import { fn, screen } from "storybook/test";
import { Button } from "@/components/ui/Button";
import { dropFocus } from "@/stories/PlayHelpers";
import { CreateRoomDialog, type CreateRoomDialogProps } from "./CreateRoomDialog";

/** 默认打开；关闭后留下大厅里的「创建房间」按钮，交互调试时可以再次打开。 */
function CreateRoomDemo({ open: initialOpen, onOpenChange, ...props }: CreateRoomDialogProps) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <div className="p-6">
      <Button size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" />
        创建房间
      </Button>
      <CreateRoomDialog
        {...props}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange(next);
        }}
      />
    </div>
  );
}

const meta = {
  title: "公共组件/CreateRoomDialog",
  component: CreateRoomDialog,
  tags: ["overlay"],
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    defaultName: "海豹的房间",
    onOpenChange: fn(),
    onCreate: fn(async () => {}),
    onValidationError: fn(),
  },
  render: (args) => <CreateRoomDemo {...args} />,
} satisfies Meta<typeof CreateRoomDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: "打开" };

export const Private: Story = {
  name: "私密房间",
  play: async ({ userEvent }) => {
    // 开关依次为「私密房间」「允许旁观」。
    const [privateSwitch] = await screen.findAllByRole("switch");
    await userEvent.click(privateSwitch);
    await screen.findByPlaceholderText("设置房间密码");
    dropFocus();
  },
};

export const MissingPassword: Story = {
  name: "私密房间 · 未填密码",
  play: async ({ userEvent }) => {
    const [privateSwitch] = await screen.findAllByRole("switch");
    await userEvent.click(privateSwitch);
    const create = screen.getByRole("button", { name: "创建" });
    await userEvent.click(create);
    await screen.findByText("私密房间需要设置密码");
    // 弹窗打开时 body 不接收指针事件，把指针移到弹窗标题上，让按钮退出悬停态。
    await userEvent.hover(screen.getByRole("heading", { name: "创建房间" }));
    dropFocus();
  },
};

/** CCB 建房：「兼容原版」开启后私密开关改称「不在大厅显示」，允许旁观锁定为开。 */
function CompatibleDemo(props: CreateRoomDialogProps) {
  const [original, setOriginal] = useState(true);
  return (
    <CreateRoomDemo
      {...props}
      nameMaxLength={original ? 30 : 32}
      roomMode={{
        label: "兼容原版",
        description: "开启后建在原版服务器上，原版网页也能加入；没有密码，不能禁止旁观。",
        checked: original,
        onCheckedChange: setOriginal,
      }}
      privacy={original ? "unlisted" : "password"}
      spectatorsDisabledReason={original ? "原版房间不允许禁止观战" : undefined}
    />
  );
}

export const OriginalCompatible: Story = {
  name: "兼容原版 · 开启",
  render: (args) => <CompatibleDemo {...args} />,
};

export const OriginalUnavailable: Story = {
  name: "兼容原版 · 不可用",
  args: {
    roomMode: {
      label: "兼容原版", description: "开启后建在原版服务器上。", checked: false, onCheckedChange: fn(),
      disabledReason: "原版服务器暂未接入，请使用增强房。",
    },
  },
};
