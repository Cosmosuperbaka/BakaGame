import { useState } from "react";
import type { AdminUser } from "@bakagame/shared";
import { Badge } from "@/components/ui/Badge";
import { BadgeList } from "@/components/common/BadgeList";
import { SettingTextField } from "@/components/common/room/settings/TextFields";
import {
  AdminFilterSelect,
  AdminTable,
  AdminToolbar,
  ListState,
  Pager,
  RowButton,
  UserCell,
} from "@/components/admin/AdminParts";
import { UserDetailDialog } from "@/components/admin/UserDetailDialog";
import { useAdminList, useDebouncedValue } from "@/hooks/UseAdminList";
import { api } from "@/lib/Api";
import { ROLE_LABELS, formatShortDateTime } from "@/lib/AdminFormat";

const LIMIT = 20;
const ROLE_FILTER = [
  { value: "", label: "全部角色" },
  { value: "user", label: ROLE_LABELS.user },
  { value: "admin", label: ROLE_LABELS.admin },
];
const BAN_FILTER = [
  { value: "", label: "全部状态" },
  { value: "banned", label: "封禁中" },
  { value: "normal", label: "正常" },
];

export function UserStatusBadge({ user }: { user: AdminUser }) {
  if (user.banned)
    return (
      <Badge variant="restricted" size="xs">
        封禁中
      </Badge>
    );
  return (
    <Badge variant="matched" size="xs">
      正常
    </Badge>
  );
}

export function UsersPanel() {
  const [keyword, setKeyword] = useState("");
  const [role, setRole] = useState("");
  const [ban, setBan] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  // 停止输入后再查，连续敲字不逐字请求。
  const query = useDebouncedValue(keyword.trim());

  const users = useAdminList({
    name: "users",
    filters: {
      ...(query ? { query } : {}),
      ...(role ? { role: role as AdminUser["role"] } : {}),
      ...(ban ? { banned: ban === "banned" } : {}),
    },
    limit: LIMIT,
    fallback: "用户列表加载失败",
    fetch: (input) => api.admin.users.list(input),
  });
  const { items } = users;

  return (
    <div>
      <AdminToolbar title="用户" {...users.toolbar}>
        <div className="w-56">
          <SettingTextField
            label="搜索"
            value={keyword}
            onChange={setKeyword}
            placeholder="QQ 号前缀或昵称"
          />
        </div>
        <AdminFilterSelect
          width="w-32"
          label="角色"
          value={role}
          options={ROLE_FILTER}
          onChange={setRole}
        />
        <AdminFilterSelect
          width="w-32"
          label="状态"
          value={ban}
          options={BAN_FILTER}
          onChange={setBan}
        />
      </AdminToolbar>
      <ListState list={users} emptyText="没有符合条件的用户" />
      {items.length ? (
        <AdminTable label="用户列表">
          <thead>
            <tr>
              <th scope="col">账号</th>
              <th scope="col">QQ 昵称</th>
              <th scope="col">角色</th>
              <th scope="col">徽章</th>
              <th scope="col">状态</th>
              <th scope="col">注册时间</th>
            </tr>
          </thead>
          <tbody>
            {items.map((user) => (
              <tr key={user.id}>
                <td>
                  <RowButton onClick={() => setOpenId(user.id)}>
                    <UserCell user={user} />
                  </RowButton>
                </td>
                <td className="max-w-40 truncate text-muted-foreground">{user.qqName ?? "—"}</td>
                <td>
                  {user.role === "admin" ? (
                    <Badge variant="active" size="xs">
                      {ROLE_LABELS.admin}
                    </Badge>
                  ) : (
                    // 普通用户是常态，弱化成灰字；只有管理员用徽章突出。
                    <span className="text-muted-foreground">{ROLE_LABELS.user}</span>
                  )}
                </td>
                <td>
                  {user.badges.length ? (
                    <BadgeList badges={user.badges} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td>
                  <UserStatusBadge user={user} />
                </td>
                <td className="whitespace-nowrap tabular-nums text-muted-foreground">
                  {formatShortDateTime(user.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      ) : null}
      <Pager {...users.pager} />
      <UserDetailDialog
        userId={openId}
        onOpenChange={(open) => {
          if (!open) setOpenId(null);
        }}
        onChanged={users.query.reload}
      />
    </div>
  );
}
