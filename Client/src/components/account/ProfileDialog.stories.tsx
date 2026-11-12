import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, within } from "storybook/test";
import type { AccountProfile } from "@bakagame/shared";
import { dropFocus } from "@/stories/PlayHelpers";
import { STORY_PROFILE, presetAccount, stubApi, type StubReply } from "@/stories/fixtures/Account";
import { ProfileDialog } from "./ProfileDialog";

/** 账号资料弹窗：资料取自账号 Store，通行密钥列表走 Better Auth 端点，由故事桩住。 */
function OpenProfile() {
  const [open, setOpen] = useState(true);
  return <ProfileDialog open={open} onOpenChange={setOpen} />;
}

const PASSKEYS = [
  { id: "pk-1", name: "Windows Hello（这台电脑）", createdAt: "2026-10-02T10:00:00.000Z" },
  { id: "pk-2", name: "Bitwarden", createdAt: "2026-10-20T21:30:00.000Z" },
];

function setup(profile: Partial<AccountProfile>, passkeys: StubReply = PASSKEYS) {
  const restoreAccount = presetAccount({
    status: "signedIn",
    profile: { ...STORY_PROFILE, ...profile },
  });
  const restoreApi = stubApi({
    "auth:/passkey/list-user-passkeys": passkeys,
    "account/updateProfile": "pending",
  });
  return () => {
    restoreApi();
    restoreAccount();
  };
}

const meta = {
  title: "账号/ProfileDialog",
  component: ProfileDialog,
  tags: ["overlay"],
  args: { open: true, onOpenChange: () => {} },
  render: () => <OpenProfile />,
} satisfies Meta<typeof ProfileDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  name: "查看",
  beforeEach: () => setup({}),
  play: async () => {
    await within(await screen.findByRole("dialog")).findByText("Bitwarden");
  },
};

/** 三枚徽章都有（主理人佩戴中）、昵称很长：徽章行与说明的节奏、昵称截断。 */
export const ManyBadges: Story = {
  name: "徽章很多 · 昵称很长",
  beforeEach: () =>
    setup({
      name: "一个起得非常非常长、长到资料头部放不下的账号昵称",
      role: "admin",
      badges: [
        { kind: "owner", serial: null },
        { kind: "contributor", serial: null },
        { kind: "pioneer", serial: 1 },
      ],
      equippedBadge: "owner",
    }),
  play: async () => {
    await within(await screen.findByRole("dialog")).findByText("Bitwarden");
  },
};

/** 没有徽章、没有通行密钥：两处空状态。 */
export const Empty: Story = {
  name: "无徽章无密钥",
  beforeEach: () => setup({ badges: [], equippedBadge: null }, []),
  play: async () => {
    await within(await screen.findByRole("dialog")).findByText("还没有添加通行密钥。");
  },
};

export const PasskeysLoading: Story = {
  name: "通行密钥读取中",
  beforeEach: () => setup({}, "pending"),
};

export const PasskeysFailed: Story = {
  name: "通行密钥读取失败",
  beforeEach: () => setup({}, "error"),
  play: async () => {
    await within(await screen.findByRole("dialog")).findByText(/读取失败|网络/);
  },
};

/** 一行就地改名：输入框与行同高。 */
export const Renaming: Story = {
  name: "通行密钥改名",
  beforeEach: () => setup({}),
  play: async ({ userEvent }) => {
    const scope = within(await screen.findByRole("dialog"));
    await userEvent.click(await scope.findByRole("button", { name: "重命名「Bitwarden」" }));
    await scope.findByRole("textbox", { name: "通行密钥名称" });
  },
};

/** 打开「资料卡显示 QQ 号」后保存：保存中按钮转圈。 */
export const Saving: Story = {
  name: "保存中",
  beforeEach: () => setup({}),
  play: async ({ userEvent }) => {
    const scope = within(await screen.findByRole("dialog"));
    await scope.findByText("Bitwarden");
    await userEvent.click(scope.getByRole("switch", { name: "资料卡显示 QQ 号" }));
    await userEvent.click(scope.getByRole("button", { name: "保存" }));
    dropFocus();
  },
};

/** 保存失败：错误说明在操作区上方。 */
export const SaveFailed: Story = {
  name: "保存失败",
  beforeEach: () => {
    const restore = setup({});
    const restoreError = stubApi({ "account/updateProfile": "error" });
    return () => {
      restoreError();
      restore();
    };
  },
  play: async ({ userEvent }) => {
    const scope = within(await screen.findByRole("dialog"));
    await scope.findByText("Bitwarden");
    await userEvent.click(scope.getByRole("switch", { name: "资料卡显示 QQ 号" }));
    await userEvent.click(scope.getByRole("button", { name: "保存" }));
    await scope.findByText("保存失败，请稍后重试");
    dropFocus();
  },
};
