import { useState, type FormEvent, type ReactNode } from "react";
import { ACCOUNT_NAME_MAX_LENGTH, normalizeAccountName } from "@bakagame/shared";
import type { AdminUserDetail } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { SettingSelect, SettingTextField, SettingsFields } from "@/components/common/room/SettingFields";
import { QueryState, UserCell } from "@/components/admin/AdminParts";
import { useAdminAction, useAdminQuery } from "@/hooks/UseAdminQuery";
import { api } from "@/lib/Api";
import { BAN_DURATIONS, GAME_LABELS, ROLE_LABELS, formatDateTime, formatShortDateTime } from "@/lib/AdminFormat";
import { useAccountStore } from "@/stores/UseAccountStore";

type Mode = "view" | "ban" | "rename";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function UserDetailBody({ user, onChanged }: { user: AdminUserDetail; onChanged: () => void }) {
  const selfId = useAccountStore((state) => state.profile?.id);
  const self = selfId === user.id;
  const [mode, setMode] = useState<Mode>("view");
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState("24");
  const [name, setName] = useState(user.name);
  const action = useAdminAction();
  const after = (ok: boolean) => {
    if (!ok) return;
    setMode("view");
    onChanged();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === "ban" && reason.trim()) {
      after(await action.run("ban", () => api.admin.users.ban({ userId: user.id, reason: reason.trim(), ...(hours !== "0" ? { expiresInHours: Number(hours) } : {}) })));
    } else if (mode === "rename" && normalizeAccountName(name)) {
      after(await action.run("rename", () => api.admin.users.rename({ userId: user.id, name: normalizeAccountName(name) })));
    }
  };

  return (
    <div className="grid gap-4">
      <dl className="grid gap-2">
        <Field label="账号"><UserCell user={user} /></Field>
        <Field label="QQ 昵称">{user.qqName ?? "未查到"}</Field>
        <Field label="角色">{ROLE_LABELS[user.role]}</Field>
        <Field label="状态">
          {user.banned ? `封禁中（${user.banReason ?? "未写原因"}，${user.banExpires ? `${formatDateTime(user.banExpires)} 解除` : "永久"}）` : "正常"}
        </Field>
        <Field label="公开 QQ">{user.showQq ? "已公开" : "不公开"}</Field>
        <Field label="注册时间">{formatDateTime(user.createdAt)}</Field>
        <Field label="反馈">{user.feedbackCount} 条</Field>
      </dl>

      <section aria-label="最近对局" className="grid gap-2">
        <h3 className="text-sm font-semibold">最近对局</h3>
        {user.recentGames.length ? (
          <ul className="grid gap-1 text-sm">
            {user.recentGames.map((game) => (
              <li key={game.id} className="flex flex-wrap gap-x-2 text-muted-foreground">
                <Badge variant="outline" size="xs">{GAME_LABELS[game.game]}</Badge>
                <span className="font-mono">{game.roomId}</span>
                <span>第 {game.roundNumber} 局</span>
                <span>{formatShortDateTime(game.endedAt)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">近 7 天没有对局</p>}
      </section>

      {mode !== "view" ? (
        <form onSubmit={(event) => void submit(event)} className="grid gap-3 rounded-md border bg-card p-3">
          <SettingsFields>
            {mode === "ban" ? (
              <>
                <SettingTextField label="封禁原因" value={reason} onChange={setReason} placeholder="用户与审计里都能看到" maxLength={200} autoFocus inputClassName="h-10" />
                <SettingSelect label="时长" value={hours} options={BAN_DURATIONS} onChange={setHours} />
              </>
            ) : (
              <SettingTextField label="新的账号昵称" value={name} onChange={setName} placeholder="替换违规昵称" maxLength={ACCOUNT_NAME_MAX_LENGTH} autoFocus inputClassName="h-10" />
            )}
          </SettingsFields>
          {action.error ? <p role="alert" className="text-sm text-destructive">{action.error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={action.busy !== null} onClick={() => { setMode("view"); action.clearError(); }}>取消</Button>
            {mode === "ban" ? (
              <Button type="submit" variant="destructive" disabled={!reason.trim()} loading={action.busy === "ban"}>封禁并踢下线</Button>
            ) : (
              <Button type="submit" disabled={!normalizeAccountName(name) || normalizeAccountName(name) === user.name} loading={action.busy === "rename"}>保存昵称</Button>
            )}
          </div>
        </form>
      ) : (
        <>
          {action.error ? <p role="alert" className="text-sm text-destructive">{action.error}</p> : null}
          {self ? <p className="text-xs text-muted-foreground">这是你自己的账号，不能封禁或修改角色。</p> : null}
          <DialogFooter className="flex-wrap">
            <Button type="button" variant="outline" disabled={action.busy !== null} onClick={() => setMode("rename")}>改昵称</Button>
            <Button type="button" variant="outline" loading={action.busy === "revoke"} disabled={action.busy !== null} onClick={() => void action.run("revoke", () => api.admin.users.revokeSessions({ userId: user.id })).then(after)}>强制下线</Button>
            {self ? null : (
              <Button
                type="button"
                variant="outline"
                loading={action.busy === "role"}
                disabled={action.busy !== null || (user.banned && user.role === "user")}
                onClick={() => void action.run("role", () => api.admin.users.setRole({ userId: user.id, role: user.role === "admin" ? "user" : "admin" })).then(after)}
              >
                {user.role === "admin" ? "取消管理员" : "设为管理员"}
              </Button>
            )}
            {self || user.role === "admin" ? null : user.banned ? (
              <Button type="button" variant="outline" loading={action.busy === "unban"} disabled={action.busy !== null} onClick={() => void action.run("unban", () => api.admin.users.unban({ userId: user.id })).then(after)}>解封</Button>
            ) : (
              <Button type="button" variant="destructive" disabled={action.busy !== null} onClick={() => setMode("ban")}>封禁</Button>
            )}
          </DialogFooter>
        </>
      )}
    </div>
  );
}

/** 用户详情与管理操作；每次操作都由服务端先写审计（见 Agents/Account.md §8）。 */
export function UserDetailDialog({ userId, onOpenChange, onChanged }: { userId: string | null; onOpenChange: (open: boolean) => void; onChanged: () => void }) {
  return (
    <Dialog open={userId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>用户详情</DialogTitle>
          <DialogDescription>封禁、改角色、强制下线与改昵称都会写入审计。</DialogDescription>
        </DialogHeader>
        {userId ? <UserDetailLoader key={userId} userId={userId} onChanged={onChanged} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function UserDetailLoader({ userId, onChanged }: { userId: string; onChanged: () => void }) {
  const detail = useAdminQuery(`user:${userId}`, () => api.admin.users.get({ userId }), "用户详情加载失败");
  return (
    <>
      <QueryState loading={detail.loading} error={detail.error} empty={false} hasData={Boolean(detail.data)} onRetry={detail.reload} emptyText="" />
      {detail.data ? <UserDetailBody key={`${detail.data.role}:${detail.data.banned}:${detail.data.name}`} user={detail.data} onChanged={() => { detail.reload(); onChanged(); }} /> : null}
    </>
  );
}
