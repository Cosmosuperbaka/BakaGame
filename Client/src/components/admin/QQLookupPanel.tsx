import { useEffect, useState } from "react";
import { LogOut, QrCode, RefreshCw } from "lucide-react";
import type { QQLookupStatus } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { AdminToolbar, QueryState } from "@/components/admin/AdminParts";
import { useAdminAction, useAdminQuery } from "@/hooks/UseAdminQuery";
import { api, apiErrorMessage } from "@/lib/Api";
import { formatDateTime, formatNumber } from "@/lib/AdminFormat";

/** 与契约注释一致：扫码登录每 2 秒轮询一次。 */
const QQ_LOGIN_POLL_MS = 2_000;

type Login = { loginId: string; image: string; scanned: boolean };
type Notice = { tone: "info" | "error"; text: string };

const STATE_BADGE = {
  signedOut: { label: "未登录", variant: "subtle" },
  active: { label: "可用", variant: "matched" },
  expired: { label: "已失效", variant: "restricted" },
} as const;

function StatusSummary({ status }: { status: QQLookupStatus }) {
  const badge = STATE_BADGE[status.state];
  return (
    <div className="grid gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={badge.variant} size="xs">{badge.label}</Badge>
        {status.uin ? <span>{status.nickname ?? "查询号"} <span className="font-mono text-muted-foreground">{status.uin}</span></span> : <span className="text-muted-foreground">还没有登录查询号</span>}
      </div>
      {status.loggedInAt ? <div className="text-xs text-muted-foreground">登录于 {formatDateTime(status.loggedInAt)}</div> : null}
      {status.expiredAt ? <div className="text-xs text-destructive">{formatDateTime(status.expiredAt)} 起登录失效，请重新扫码</div> : null}
    </div>
  );
}

/**
 * QQ 昵称查询号：管理员扫码登录一个 QQ 号，服务端用它的登录态查注册用户的 QQ 昵称（见 Agents/Account.md §4）。
 * 二维码由服务端代取，浏览器不直接访问 QQ。
 */
export function QQLookupPanel() {
  const status = useAdminQuery("qq:status", () => api.admin.qq.status(), "查询号状态加载失败");
  const [login, setLogin] = useState<Login | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const action = useAdminAction();
  const loginId = login?.loginId ?? null;

  const reloadStatus = status.reload;

  // 上一次轮询回来后再排下一次，慢请求不会叠在一起。
  useEffect(() => {
    if (!loginId) return;
    let alive = true;
    let timer = 0;
    const tick = () => {
      api.admin.qq.pollLogin({ loginId }).then((result) => {
        if (!alive) return;
        if (result.state === "waiting" || result.state === "scanned") {
          if (result.state === "scanned") setLogin((current) => (current?.loginId === loginId ? { ...current, scanned: true } : current));
          timer = window.setTimeout(tick, QQ_LOGIN_POLL_MS);
          return;
        }
        setLogin(null);
        if (result.state === "success") {
          setNotice({ tone: "info", text: `已登录查询号 ${result.status.nickname ?? ""}（${result.status.uin ?? ""}）` });
          reloadStatus();
        } else {
          setNotice({ tone: "error", text: result.state === "expired" ? "二维码已失效，请重新获取" : result.message });
        }
      }, (cause: unknown) => {
        if (!alive) return;
        setLogin(null);
        setNotice({ tone: "error", text: apiErrorMessage(cause, "扫码状态查询失败") });
      });
    };
    timer = window.setTimeout(tick, QQ_LOGIN_POLL_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [loginId, reloadStatus]);

  const startLogin = () => {
    setNotice(null);
    void action.run("start", async () => setLogin({ ...(await api.admin.qq.startLogin()), scanned: false }), "二维码获取失败");
  };
  const logout = () => {
    setNotice(null);
    void action.run("logout", async () => {
      await api.admin.qq.logout();
      reloadStatus();
    });
  };
  const refresh = () => {
    setNotice(null);
    void action.run("refresh", async () => {
      const result = await api.admin.qq.refreshNames();
      const rest = result.remaining ? `，还有 ${formatNumber(result.remaining)} 个待查，可再次刷新` : "";
      setNotice({ tone: "info", text: `已检查 ${formatNumber(result.checked)} 个账号，更新 ${formatNumber(result.updated)} 个昵称${rest}` });
      reloadStatus();
    }, "刷新失败，请稍后重试");
  };

  const current = status.data;
  return (
    <div className="grid gap-4">
      <AdminToolbar title="QQ 昵称查询号" onReload={status.reload} loading={status.loading && Boolean(current)} />
      <p className="text-sm text-muted-foreground">
        扫码登录一个 QQ 号，服务端用它的 QQ 空间登录态查询注册用户的 QQ 昵称：新用户注册时预填账号昵称，后台用户列表展示。
        建议使用小号；登录态加密保存，查询有频率上限，失效后需要重新扫码。
      </p>
      <QueryState loading={status.loading} error={status.error} empty={false} hasData={Boolean(current)} onRetry={status.reload} emptyText="" />
      {current ? (
        <section aria-label="查询号状态" className="grid gap-4 rounded-md border bg-card p-4">
          <StatusSummary status={current} />
          {login ? (
            <div className="flex flex-wrap items-center gap-4">
              <img src={login.image} alt="QQ 登录二维码" className="size-36 rounded-md border bg-white p-1 [image-rendering:pixelated]" />
              <div className="grid gap-2 text-sm">
                <p role="status">{login.scanned ? "已扫码，请在手机 QQ 上确认登录" : "用手机 QQ 扫描二维码"}</p>
                <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => setLogin(null)}>取消</Button>
              </div>
            </div>
          ) : null}
          {notice ? <p role={notice.tone === "error" ? "alert" : "status"} className={notice.tone === "error" ? "text-sm text-destructive" : "text-sm"}>{notice.text}</p> : null}
          {action.error ? <p role="alert" className="text-sm text-destructive">{action.error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant={current.state === "active" ? "outline" : "default"} loading={action.busy === "start"} disabled={action.busy !== null || login !== null} onClick={startLogin}>
              <QrCode />
              {current.state === "signedOut" ? "扫码登录" : "重新扫码"}
            </Button>
            <Button type="button" variant="outline" loading={action.busy === "refresh"} disabled={action.busy !== null || current.state !== "active"} onClick={refresh}>
              <RefreshCw />
              刷新全部昵称
            </Button>
            {current.state !== "signedOut" ? (
              <Button type="button" variant="ghost" loading={action.busy === "logout"} disabled={action.busy !== null} onClick={logout}>
                <LogOut />
                退出查询号
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
