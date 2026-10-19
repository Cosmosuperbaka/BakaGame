import { useState } from "react";
import { RefreshCw, RotateCcw } from "lucide-react";
import type { QQLookupStatus } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { AdminToolbar, QueryState } from "@/components/admin/AdminParts";
import { useAdminAction, useAdminQuery } from "@/hooks/UseAdminQuery";
import { api } from "@/lib/Api";
import { formatDateTime, formatNumber } from "@/lib/AdminFormat";

type Notice = { tone: "info" | "error"; text: string };

const STATE_BADGE = {
  active: { label: "可用", variant: "matched" },
  unavailable: { label: "不可用", variant: "restricted" },
} as const;

function StatusSummary({ status }: { status: QQLookupStatus }) {
  const badge = STATE_BADGE[status.state];
  return (
    <div className="grid gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={badge.variant} size="xs">
          {badge.label}
        </Badge>
        {status.uin ? (
          <span>
            {status.nickname ?? "查询号"}{" "}
            <span className="font-mono text-muted-foreground">{status.uin}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">NapCat 没有在线账号</span>
        )}
      </div>
      {status.error ? <div className="text-xs text-destructive">{status.error}</div> : null}
      {status.checkedAt ? (
        <div className="text-xs text-muted-foreground">
          检测于 {formatDateTime(status.checkedAt)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * QQ 昵称来源：管理员自建的 NapCat 实例（OneBot 11）查询注册用户的 QQ 昵称（见 Server/docs/Account.md §4）。
 * 站点不再持有 QQ 登录态，这里只做状态探测与批量刷新。
 */
export function QQLookupPanel() {
  const status = useAdminQuery("qq:status", () => api.admin.qq.status(), "查询号状态加载失败");
  const [notice, setNotice] = useState<Notice | null>(null);
  const action = useAdminAction();

  const refresh = () => {
    setNotice(null);
    void action.run(
      "refresh",
      async () => {
        const result = await api.admin.qq.refreshNames();
        const rest = result.remaining
          ? `，还有 ${formatNumber(result.remaining)} 个待查，可再次刷新`
          : "";
        setNotice({
          tone: "info",
          text: `已检查 ${formatNumber(result.checked)} 个账号，更新 ${formatNumber(result.updated)} 个昵称${rest}`,
        });
        status.reload();
      },
      "刷新失败，请稍后重试"
    );
  };

  const current = status.data;
  return (
    <div className="grid gap-4">
      <AdminToolbar
        title="QQ 昵称来源"
        onReload={status.reload}
        loading={status.loading && Boolean(current)}
      />
      <p className="text-sm text-muted-foreground">
        昵称由管理员自建的 NapCat 实例（OneBot 11）提供：账号昵称强制取自 QQ
        昵称，查询不可用时暂停新账号注册。 站内不再保存 QQ 登录态，登录与掉线由 NapCat
        一侧负责，这里只反映它的在线状态。
      </p>
      <QueryState
        loading={status.loading}
        error={status.error}
        empty={false}
        hasData={Boolean(current)}
        onRetry={status.reload}
        emptyText=""
      />
      {current ? (
        <section aria-label="查询号状态" className="grid gap-4 rounded-md border bg-card p-4">
          <StatusSummary status={current} />
          {notice ? (
            <p
              role={notice.tone === "error" ? "alert" : "status"}
              className={notice.tone === "error" ? "text-sm text-destructive" : "text-sm"}
            >
              {notice.text}
            </p>
          ) : null}
          {action.error ? (
            <p role="alert" className="text-sm text-destructive">
              {action.error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              loading={action.busy === "refresh"}
              disabled={action.busy !== null || current.state !== "active"}
              onClick={refresh}
            >
              <RefreshCw />
              刷新全部昵称
            </Button>
            <Button
              type="button"
              variant="ghost"
              loading={status.loading}
              disabled={action.busy !== null}
              onClick={() => status.reload()}
            >
              <RotateCcw />
              重新检测
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
