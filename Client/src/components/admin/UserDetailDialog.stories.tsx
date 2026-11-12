import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import {
  ADMIN_USER_FULL,
  ADMIN_USER_SELF,
  ADMIN_USER_SPARSE,
  installAdmin,
} from "@/stories/fixtures/Admin";
import { UserDetailDialog } from "./UserDetailDialog";

function OpenDetail({ userId }: { userId: string }) {
  const [open, setOpen] = useState<string | null>(userId);
  return (
    <UserDetailDialog
      userId={open}
      onOpenChange={(next) => {
        if (!next) setOpen(null);
      }}
      onChanged={() => {}}
    />
  );
}

/** 用户详情弹窗：资料、最近对局、徽章与封禁、改角色、强制下线。 */
const meta = {
  title: "Admin/UserDetailDialog",
  component: UserDetailDialog,
  tags: ["overlay"],
  args: { userId: ADMIN_USER_FULL.id, onOpenChange: () => {}, onChanged: () => {} },
  render: (args) => <OpenDetail userId={args.userId ?? ADMIN_USER_FULL.id} />,
} satisfies Meta<typeof UserDetailDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const body = async () => within(await screen.findByRole("dialog"));

/** 信息很全：封禁中带原因与解除时间、两枚徽章、8 局对局、长昵称。 */
export const Full: Story = {
  name: "信息很全 · 封禁中",
  beforeEach: () => installAdmin(),
  play: async () => {
    await (await body()).findByText("最近对局");
    dropFocus();
  },
};

/** 信息很少：刚注册、没查到 QQ 昵称、没徽章没对局。 */
export const Sparse: Story = {
  name: "信息很少",
  args: { userId: ADMIN_USER_SPARSE.id },
  beforeEach: () => installAdmin(),
  play: async () => {
    await (await body()).findByText("还没有对局记录");
    dropFocus();
  },
};

export const Self: Story = {
  name: "自己的账号",
  args: { userId: ADMIN_USER_SELF.id },
  beforeEach: () => installAdmin(),
  play: async () => {
    await (await body()).findByText("这是你自己的账号，不能封禁或修改角色。");
    dropFocus();
  },
};

/** 封禁表单：原因未填时确认钮禁用。 */
export const BanForm: Story = {
  name: "封禁表单",
  args: { userId: ADMIN_USER_SPARSE.id },
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    const scope = await body();
    await userEvent.click(await scope.findByRole("button", { name: "封禁" }));
    await scope.findByLabelText("封禁原因");
    dropFocus();
  },
};

export const BanRunning: Story = {
  name: "封禁 · 执行中",
  args: { userId: ADMIN_USER_SPARSE.id },
  beforeEach: () => installAdmin({ "admin/users/ban": "pending" }),
  play: async ({ userEvent }) => {
    const scope = await body();
    await userEvent.click(await scope.findByRole("button", { name: "封禁" }));
    await userEvent.type(await scope.findByLabelText("封禁原因"), "刷屏广告");
    await userEvent.click(scope.getByRole("button", { name: "封禁并踢下线" }));
    dropFocus();
  },
};

/** 强制下线失败：失败说明出现在页脚上方。 */
export const ActionFailed: Story = {
  name: "强制下线 · 失败",
  args: { userId: ADMIN_USER_SPARSE.id },
  beforeEach: () => installAdmin({ "admin/users/revokeSessions": "error" }),
  play: async ({ userEvent }) => {
    const scope = await body();
    await userEvent.click(await scope.findByRole("button", { name: "强制下线" }));
    await scope.findByRole("alert");
    dropFocus();
  },
};

export const Loading: Story = {
  name: "加载中",
  beforeEach: () => installAdmin({ "admin/users/get": "pending" }),
};

export const Failed: Story = {
  name: "读取失败",
  beforeEach: () => installAdmin({ "admin/users/get": "error" }),
  play: async () => {
    await (await body()).findByText("用户详情加载失败");
  },
};
