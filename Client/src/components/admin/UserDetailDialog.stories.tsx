import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import {
  ADMIN_USER_FULL,
  ADMIN_USER_OWNER,
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

/** 强制下线先弹确认：写明对象与后果，确认之前不发请求。 */
export const ConfirmRevoke: Story = {
  name: "强制下线 · 确认",
  args: { userId: ADMIN_USER_SPARSE.id },
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    const scope = await body();
    await userEvent.click(await scope.findByRole("button", { name: "强制下线" }));
    await screen.findByRole("dialog", { name: "强制下线" });
    dropFocus();
  },
};

/** 强制下线确认后请求失败：失败原因留在确认框内。 */
export const ActionFailed: Story = {
  name: "强制下线 · 失败",
  args: { userId: ADMIN_USER_SPARSE.id },
  beforeEach: () => installAdmin({ "admin/users/revokeSessions": "error" }),
  play: async ({ userEvent }) => {
    const scope = await body();
    await userEvent.click(await scope.findByRole("button", { name: "强制下线" }));
    const confirm = within(await screen.findByRole("dialog", { name: "强制下线" }));
    await userEvent.click(confirm.getByRole("button", { name: "强制下线" }));
    await confirm.findByRole("alert");
    dropFocus();
  },
};

/** 确认请求在途：确认钮转圈、取消禁用。 */
export const ConfirmRunning: Story = {
  name: "强制下线 · 执行中",
  args: { userId: ADMIN_USER_SPARSE.id },
  beforeEach: () => installAdmin({ "admin/users/revokeSessions": "pending" }),
  play: async ({ userEvent }) => {
    const scope = await body();
    await userEvent.click(await scope.findByRole("button", { name: "强制下线" }));
    const confirm = within(await screen.findByRole("dialog", { name: "强制下线" }));
    await userEvent.click(confirm.getByRole("button", { name: "强制下线" }));
    dropFocus();
  },
};

/** 授予贡献者的确认：正向操作，确认钮不用危险色。 */
export const ConfirmGrant: Story = {
  name: "授予贡献者 · 确认",
  args: { userId: ADMIN_USER_SPARSE.id },
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    const scope = await body();
    await userEvent.click(await scope.findByRole("button", { name: "授予贡献者" }));
    await screen.findByRole("dialog", { name: "授予贡献者徽章" });
    dropFocus();
  },
};

/** 操作成功：详情里出现一行结果说明。 */
export const ActionDone: Story = {
  name: "设为管理员 · 成功",
  args: { userId: ADMIN_USER_SPARSE.id },
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    const scope = await body();
    await userEvent.click(await scope.findByRole("button", { name: "设为管理员" }));
    const confirm = within(await screen.findByRole("dialog", { name: "设为管理员" }));
    await userEvent.click(confirm.getByRole("button", { name: "设为管理员" }));
    await scope.findByText(/已把「.*」设为管理员/);
    dropFocus();
  },
};

/** 主理人账号：强制下线与取消管理员禁用，并写明原因。 */
export const OwnerLocked: Story = {
  name: "主理人账号",
  args: { userId: ADMIN_USER_OWNER.id },
  beforeEach: () => installAdmin(),
  play: async () => {
    await (await body()).findByText("主理人账号不能被强制下线或取消管理员。");
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
