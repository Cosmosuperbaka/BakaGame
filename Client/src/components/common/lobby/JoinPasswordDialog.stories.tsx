import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { JoinPasswordDialog } from "./JoinPasswordDialog";

const meta = {
  title: "公共组件/JoinPasswordDialog",
  component: JoinPasswordDialog,
  tags: ["overlay"],
  args: { roomName: "深夜卧底局", password: "", onPasswordChange: fn(), onCancel: fn(), onConfirm: fn() },
} satisfies Meta<typeof JoinPasswordDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 空密码时「加入」禁用。 */
export const Default: Story = { name: "默认" };

/** 提交在途：按钮转圈并禁用。 */
export const Pending: Story = { name: "加入中", args: { password: "1234", pending: true } };

/** 密码错误：输入框标红，文案写在框下。 */
export const WrongPassword: Story = {
  name: "密码错误",
  args: { password: "1234", error: { message: "房间密码错误", invalid: true } },
};

/** 归不到字段的失败只给文案，不标红。 */
export const TooManyAttempts: Story = {
  name: "尝试次数过多",
  args: { password: "1234", error: { message: "密码错误次数过多，请稍后再试", invalid: false } },
};
