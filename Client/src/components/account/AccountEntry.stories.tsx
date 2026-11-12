import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen } from "storybook/test";
import { STORY_PROFILE, presetAccount } from "@/stories/fixtures/Account";
import { AccountButton, AccountDialogs, FeedbackButton } from "./AccountEntry";

/**
 * 主页右上角的账号与反馈入口，按账号状态分别呈现；故事给它套一条与页头同底色的栏。
 * 同页挂上弹窗宿主（与首页一致），入口点开的弹窗才能看到自按钮展开的来源动效。
 */
function Bar() {
  return (
    <div className="flex items-center justify-end gap-1 rounded-md border bg-background p-2">
      <AccountButton />
      <FeedbackButton />
      <AccountDialogs />
    </div>
  );
}

const meta = {
  title: "账号/AccountEntry",
  component: AccountButton,
  render: () => <Bar />,
} satisfies Meta<typeof AccountButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 首屏读取账号时：同尺寸的禁用按钮占位，页头不跳。 */
export const Loading: Story = {
  name: "读取中",
  beforeEach: () => presetAccount({ status: "loading" }),
};

export const Guest: Story = {
  name: "未登录",
  beforeEach: () => presetAccount({ status: "guest" }),
};

export const SignedIn: Story = {
  name: "已登录",
  beforeEach: () => presetAccount({ status: "signedIn", profile: STORY_PROFILE }),
};

/** 有两条未读回复：头像与反馈按钮各带一枚红点。 */
export const Unread: Story = {
  name: "已登录 · 有未读回复",
  beforeEach: () =>
    presetAccount({ status: "signedIn", profile: STORY_PROFILE, unreadFeedback: 2 }),
};

/** 管理员展开菜单：资料、反馈、后台与退出四项。 */
export const MenuOpen: Story = {
  name: "菜单展开 · 管理员",
  tags: ["overlay"],
  beforeEach: () =>
    presetAccount({
      status: "signedIn",
      profile: { ...STORY_PROFILE, role: "admin", name: "一个很长很长的账号昵称会被截断" },
      unreadFeedback: 2,
    }),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: /^账号菜单/ }));
    await screen.findByRole("button", { name: "退出登录" });
  },
};
