import { useEffect, useState } from "react";
import type { AdminUser } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { SettingSelect, SettingTextField } from "@/components/common/room/SettingFields";
import {
  AdminTable,
  AdminToolbar,
  Pager,
  QueryState,
  RowButton,
  UserCell,
} from "@/components/admin/AdminParts";
import { UserDetailDialog } from "@/components/admin/UserDetailDialog";
import { useAdminQuery } from "@/hooks/UseAdminQuery";
import { IDLE_SEARCH_MS } from "@/hooks/UseIdleSearch";
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
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("");
  const [ban, setBan] = useState("");
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  // 停止输入后再查，连续敲字不逐字请求。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(keyword.trim());
      setOffset(0);
    }, IDLE_SEARCH_MS);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  const input = {
    ...(query ? { query } : {}),
    ...(role ? { role: role as AdminUser["role"] } : {}),
    ...(ban ? { banned: ban === "banned" } : {}),
    limit: LIMIT,
    offset,
  };
  const users = useAdminQuery(
    `users:${JSON.stringify(input)}`,
    () => api.admin.users.list(input),
    "用户列表加载失败"
  );
  const items = users.data?.items ?? [];

  return (
    <div>
      <AdminToolbar
        title="用户"
        count={users.data?.total ?? null}
        onReload={users.reload}
        loading={users.loading && Boolean(users.data)}
      >
        <div className="w-56">
          <SettingTextField
            label="搜索"
            value={keyword}
            onChange={setKeyword}
            placeholder="QQ 号前缀或昵称"
          />
        </div>
        <div className="w-32">
          <SettingSelect
            label="角色"
            value={role}
            options={ROLE_FILTER}
            onChange={(value) => {
              setRole(value);
              setOffset(0);
            }}
          />
        </div>
        <div className="w-32">
          <SettingSelect
            label="状态"
            value={ban}
            options={BAN_FILTER}
            onChange={(value) => {
              setBan(value);
              setOffset(0);
            }}
          />
        </div>
      </AdminToolbar>
      <QueryState
        loading={users.loading}
        error={users.error}
        empty={Boolean(users.data) && !items.length}
        hasData={Boolean(users.data)}
        onRetry={users.reload}
        emptyText="没有符合条件的用户"
      />
      {items.length ? (
        <AdminTable label="用户列表">
          <thead>
            <tr>
              <th scope="col">账号</th>
              <th scope="col">QQ 昵称</th>
              <th scope="col">角色</th>
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
                    ROLE_LABELS.user
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
      <Pager offset={offset} limit={LIMIT} total={users.data?.total ?? 0} onChange={setOffset} />
      <UserDetailDialog
        userId={openId}
        onOpenChange={(open) => {
          if (!open) setOpenId(null);
        }}
        onChanged={users.reload}
      />
    </div>
  );
}
