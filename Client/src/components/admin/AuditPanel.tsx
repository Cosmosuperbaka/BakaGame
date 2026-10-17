import { useState } from "react";
import { SettingSelect } from "@/components/common/room/SettingFields";
import { AdminTable, AdminToolbar, Pager, QueryState, UserCell } from "@/components/admin/AdminParts";
import { Hint } from "@/components/ui/Tooltip";
import { useAdminQuery } from "@/hooks/UseAdminQuery";
import { api } from "@/lib/Api";
import { AUDIT_ACTION_LABELS, auditActionLabel, formatShortDateTime } from "@/lib/AdminFormat";

const LIMIT = 30;
const ACTION_FILTER = [{ value: "", label: "全部操作" }, ...Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ value, label }))];

/** 审计详情是写操作时记下的参数，按「键：值」平铺。 */
const describeDetail = (detail: Record<string, unknown> | null) =>
  detail ? Object.entries(detail).map(([key, value]) => `${key}：${typeof value === "string" ? value : JSON.stringify(value)}`).join(" · ") : "";

export function AuditPanel() {
  const [action, setAction] = useState("");
  const [offset, setOffset] = useState(0);
  const input = { ...(action ? { action } : {}), limit: LIMIT, offset };
  const list = useAdminQuery(`audit:${JSON.stringify(input)}`, () => api.admin.audit.list(input), "审计日志加载失败");
  const items = list.data?.items ?? [];

  return (
    <div>
      <AdminToolbar title="审计日志" count={list.data?.total ?? null} onReload={list.reload} loading={list.loading && Boolean(list.data)}>
        <div className="w-40"><SettingSelect label="操作" value={action} options={ACTION_FILTER} onChange={(value) => { setAction(value); setOffset(0); }} /></div>
      </AdminToolbar>
      <QueryState loading={list.loading} error={list.error} empty={Boolean(list.data) && !items.length} hasData={Boolean(list.data)} onRetry={list.reload} emptyText="没有审计记录" />
      {items.length ? (
        <AdminTable label="审计日志">
          <thead><tr><th scope="col">时间</th><th scope="col">操作人</th><th scope="col">操作</th><th scope="col">对象</th><th scope="col">详情</th></tr></thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id}>
                <td className="whitespace-nowrap tabular-nums text-muted-foreground">{formatShortDateTime(entry.createdAt)}</td>
                <td><UserCell user={entry.actor} fallback="系统" /></td>
                <td className="whitespace-nowrap">{auditActionLabel(entry.action)}</td>
                <Hint label={`${entry.targetType}:${entry.targetId}`}>
                  <td className="max-w-48 truncate font-mono text-xs">{entry.targetType}:{entry.targetId}</td>
                </Hint>
                <td className="max-w-80 break-words text-xs text-muted-foreground">{describeDetail(entry.detail)}</td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      ) : null}
      <Pager offset={offset} limit={LIMIT} total={list.data?.total ?? 0} onChange={setOffset} />
    </div>
  );
}
