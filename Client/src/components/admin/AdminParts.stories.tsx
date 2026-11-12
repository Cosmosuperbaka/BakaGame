import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen } from "storybook/test";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { AdminTable, AdminToolbar, ConfirmDialog, Pager, QueryState, RowButton, Stat, UserCell } from "./AdminParts";

/**
 * 管理后台各面板共用的零件：标题行、查询状态、表格、数字卡、分页与危险操作确认。
 * 面板本身各接一套后台接口，这里先把共用零件的每种状态单独截图。
 */
const meta = {
  title: "Admin/AdminParts",
  component: AdminToolbar,
  args: { title: "用户" },
  decorators: [
    (Story) => (
      <div className="w-[56rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AdminToolbar>;

export default meta;
type Story = StoryObj<typeof meta>;

const USERS = [
  { name: "小布丁", qqNumber: "123456789", image: null, role: "管理员", games: 128, created: "2026-09-01" },
  { name: "一个昵称起得非常非常长的玩家", qqNumber: "2345678901", image: null, role: "玩家", games: 3, created: "2026-10-12" },
  { name: "路人甲", qqNumber: "345678", image: null, role: "玩家", games: 0, created: "2026-12-30" },
];

/** 标题行 + 数字卡 + 表格（头像昵称、可点名字、角色徽章、右对齐数字）+ 分页。 */
export const TableWithData: Story = {
  name: "表格有数据",
  render: () => (
    <div>
      <AdminToolbar title="用户" count={1234} onReload={() => {}}>
        <Input placeholder="搜索昵称或 QQ 号" className="h-9 w-56" />
      </AdminToolbar>
      <div className="mb-4 grid grid-cols-3 gap-3">
        <Stat label="注册用户" value={1234} detail="近 7 天 +56" />
        <Stat label="今日活跃" value={87} />
        <Stat label="封禁" value={2} />
      </div>
      <AdminTable label="用户列表">
        <thead>
          <tr>
            <th>用户</th>
            <th>角色</th>
            <th className="text-right">对局</th>
            <th>注册于</th>
          </tr>
        </thead>
        <tbody>
          {USERS.map((user) => (
            <tr key={user.qqNumber}>
              <td>
                <RowButton onClick={() => {}}>
                  <UserCell user={user} />
                </RowButton>
              </td>
              <td>
                <Badge variant={user.role === "管理员" ? "secondary" : "outline"} size="xs">
                  {user.role}
                </Badge>
              </td>
              <td className="text-right font-mono tabular-nums">{user.games}</td>
              <td className="font-mono text-xs text-muted-foreground">{user.created}</td>
            </tr>
          ))}
          <tr>
            <td>
              <UserCell user={null} />
            </td>
            <td />
            <td className="text-right font-mono tabular-nums">7</td>
            <td className="font-mono text-xs text-muted-foreground">2026-08-20</td>
          </tr>
        </tbody>
      </AdminTable>
      <Pager offset={20} limit={20} total={1234} onChange={() => {}} />
    </div>
  ),
};

export const Loading: Story = {
  name: "首次加载",
  render: () => (
    <div>
      <AdminToolbar title="用户" count={null} onReload={() => {}} loading />
      <QueryState loading error={null} empty={false} hasData={false} onRetry={() => {}} emptyText="" />
    </div>
  ),
};

export const Empty: Story = {
  name: "空列表",
  render: () => (
    <div>
      <AdminToolbar title="反作弊复核" count={0} onReload={() => {}} />
      <QueryState
        loading={false}
        error={null}
        empty
        hasData={false}
        onRetry={() => {}}
        emptyText="没有待复核的对局"
      />
    </div>
  ),
};

export const Failed: Story = {
  name: "读取失败",
  render: () => (
    <div>
      <AdminToolbar title="对局" count={null} onReload={() => {}} />
      <QueryState
        loading={false}
        error="对局列表加载失败，请稍后重试"
        empty={false}
        hasData={false}
        onRetry={() => {}}
        emptyText=""
      />
    </div>
  ),
};

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
