import { useState } from "react";
import {
  AdminFilterSelect,
  AdminTable,
  AdminToolbar,
  ListState,
  Pager,
  UserCell,
} from "@/components/admin/AdminParts";
import { Hint } from "@/components/ui/Tooltip";
import { useAdminList } from "@/hooks/UseAdminList";
import { api } from "@/lib/Api";
import { AUDIT_ACTION_LABELS, auditActionLabel, formatShortDateTime } from "@/lib/AdminFormat";

const LIMIT = 30;
const ACTION_FILTER = [
  { value: "", label: "全部操作" },
  ...Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ value, label })),
];

/** 审计详情是写操作时记下的参数，按「键：值」平铺。 */
const describeDetail = (detail: Record<string, unknown> | null) =>
  detail
    ? Object.entries(detail)
        .map(
          ([key, value]) => `${key}：${typeof value === "string" ? value : JSON.stringify(value)}`
        )
        .join(" · ")
    : "";

export function AuditPanel() {
  const [action, setAction] = useState("");
  const list = useAdminList({
    name: "audit",
    filters: action ? { action } : {},
    limit: LIMIT,
    fallback: "审计日志加载失败",
    fetch: (input) => api.admin.audit.list(input),
  });
  const { items } = list;

  return (
    <div>
      <AdminToolbar title="审计日志" {...list.toolbar}>
        <AdminFilterSelect
          width="w-40"
          label="操作"
          value={action}
          options={ACTION_FILTER}
          onChange={setAction}
        />
      </AdminToolbar>
      <ListState list={list} emptyText="没有审计记录" />
      {items.length ? (
        <AdminTable label="审计日志">
          <thead>
            <tr>
              <th scope="col">时间</th>
              <th scope="col">操作人</th>
              <th scope="col">操作</th>
              <th scope="col">对象</th>
              <th scope="col">详情</th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id}>
                <td className="whitespace-nowrap tabular-nums text-muted-foreground">
                  {formatShortDateTime(entry.createdAt)}
                </td>
                <td>
                  <UserCell user={entry.actor} fallback="系统" />
                </td>
                <td className="whitespace-nowrap">{auditActionLabel(entry.action)}</td>
                <Hint label={`${entry.targetType}:${entry.targetId}`}>
                  <td className="max-w-48 truncate font-mono text-xs">
                    {entry.targetType}:{entry.targetId}
                  </td>
                </Hint>
                {/* 详情最多两行、悬停看全文：长标题平铺会把整行撑到四五行高，手机上看不见这一列却留下大段空白。 */}
                <td className="text-xs text-muted-foreground">
                  {entry.detail ? (
                    <Hint label={describeDetail(entry.detail)}>
                      <span className="line-clamp-2 max-w-80 break-words">
                        {describeDetail(entry.detail)}
                      </span>
                    </Hint>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      ) : null}
      <Pager {...list.pager} />
    </div>
  );
}
