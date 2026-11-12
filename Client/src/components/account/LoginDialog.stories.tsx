import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { presetAccount, stubApi } from "@/stories/fixtures/Account";
import { LoginDialog } from "./LoginDialog";

/**
 * 登录 / 注册弹窗。昵称回显与发码接口都由故事桩住；QQ 头像是站外地址，截图环境拦掉外网，
 * 头像按「取不到」落回同尺寸的占位圆。
 */
function OpenLogin() {
  const [open, setOpen] = useState(true);
  return <LoginDialog open={open} onOpenChange={setOpen} />;
}

const meta = {
  title: "账号/LoginDialog",
  component: LoginDialog,
  tags: ["overlay"],
  args: { open: true, onOpenChange: () => {} },
  render: () => <OpenLogin />,
  beforeEach: () => {
    const restoreAccount = presetAccount({ status: "guest" });
    const restoreApi = stubApi({
      "account/qqName": "小布丁",
      "account/requestLoginCode": { registered: true, resendAfterSeconds: 60, qqName: "小布丁" },
    });
    return () => {
      restoreApi();
      restoreAccount();
    };
  },
} satisfies Meta<typeof LoginDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const dialog = async () => within(await screen.findByRole("dialog"));

/** 刚打开：占位头像、空的 QQ 号框，发送验证码禁用。 */
export const Empty: Story = { name: "输入 QQ 号" };

/** QQ 号合法：号先落在头像下，停输后查到的昵称自上方顶进来。 */
export const Identified: Story = {
  name: "QQ 号与昵称到达",
  play: async ({ userEvent }) => {
    const scope = await dialog();
    await userEvent.type(scope.getByLabelText("QQ 号"), "123456789");
    await scope.findByText("小布丁");
  },
};

/** 只输了一半：号不合法，身份行与 QQ 号都不出现，说明写「对应的 QQ 邮箱」。 */
export const Partial: Story = {
  name: "QQ 号未输完",
  play: async ({ userEvent }) => {
    const scope = await dialog();
    await userEvent.type(scope.getByLabelText("QQ 号"), "1234");
  },
};

/** 发码请求还没回来：按钮转圈，其余按钮禁用。 */
export const Sending: Story = {
  name: "发送中",
  beforeEach: () => stubApi({ "account/requestLoginCode": "pending" }),
  play: async ({ userEvent }) => {
    const scope = await dialog();
    await userEvent.type(scope.getByLabelText("QQ 号"), "123456789");
    await scope.findByText("小布丁");
    await userEvent.click(scope.getByRole("button", { name: "发送验证码" }));
    dropFocus();
  },
};

/** 发码失败：错误说明出现在字段下方。 */
export const SendFailed: Story = {
  name: "发送失败",
  beforeEach: () => stubApi({ "account/requestLoginCode": "error" }),
  play: async ({ userEvent }) => {
    const scope = await dialog();
    await userEvent.type(scope.getByLabelText("QQ 号"), "123456789");
    await userEvent.click(scope.getByRole("button", { name: "发送验证码" }));
    await scope.findByRole("alert");
    dropFocus();
  },
};

/** 第二步：验证码框、重发倒计时与「换个 QQ 号」。 */
export const CodeStep: Story = {
  name: "输入验证码",
  play: async ({ userEvent }) => {
    const scope = await dialog();
    await userEvent.type(scope.getByLabelText("QQ 号"), "123456789");
    await userEvent.click(scope.getByRole("button", { name: "发送验证码" }));
    await userEvent.type(await scope.findByLabelText("验证码"), "1234");
  },
};

/** 新号：标题改为「注册账号」，主按钮「注册并登录」。 */
export const Register: Story = {
  name: "新号注册",
  beforeEach: () =>
    stubApi({
      "account/requestLoginCode": { registered: false, resendAfterSeconds: 60, qqName: "新来的" },
    }),
  play: async ({ userEvent }) => {
    const scope = await dialog();
    await userEvent.type(scope.getByLabelText("QQ 号"), "123456789");
    await userEvent.click(scope.getByRole("button", { name: "发送验证码" }));
    await scope.findByRole("button", { name: "注册并登录" });
    await userEvent.type(scope.getByLabelText("验证码"), "123456");
  },
};

/** 底部「登录说明」展开：四段说明。 */
export const NoticeOpen: Story = {
  name: "登录说明展开",
  play: async ({ userEvent }) => {
    const scope = await dialog();
    await userEvent.click(scope.getByRole("button", { name: "登录说明" }));
    await scope.findByText(/不登录也能游玩/);
    dropFocus();
  },
};
