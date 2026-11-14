import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen } from "storybook/test";
import { ConfirmDialog } from "./ConfirmDialog";

const meta = {
  title: "公共组件/ConfirmDialog",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function OpenConfirm({ fail }: { fail: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title="强制下线「小布丁」？"
      description="该账号所有设备上的会话会立即失效，需要重新登录。"
      confirmLabel="强制下线"
      onConfirm={() => Promise.resolve(fail ? "操作失败：账号不存在" : null)}
    />
  );
}

/** 危险操作的二次确认：取消在前、危险色确认在后。 */
export const Confirm: Story = {
  name: "危险操作确认",
  tags: ["overlay"],
  render: () => <OpenConfirm fail={false} />,
};

/** 确认失败：失败文案留在弹窗里。 */
export const ConfirmFailed: Story = {
  name: "危险操作确认 · 失败",
  tags: ["overlay"],
  render: () => <OpenConfirm fail />,
  play: async ({ userEvent }) => {
    await userEvent.click(await screen.findByRole("button", { name: "强制下线" }));
    await screen.findByRole("alert");
  },
};
