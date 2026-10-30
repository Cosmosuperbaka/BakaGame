import { useState, type FormEvent, type ReactNode } from "react";
import { badgeDescriptionOf, PIONEER_BADGE_LIMIT } from "@bakagame/shared/values";
import type { AdminUserDetail } from "@bakagame/shared";
import { Badge } from "@/components/ui/Badge";
import { BadgeChip } from "@/components/common/BadgeList";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import {
  SettingSelect,
  SettingTextField,
  SettingsFields,
} from "@/components/common/room/SettingFields";
import { QueryState, UserCell } from "@/components/admin/AdminParts";
import { useAdminAction, useAdminQuery } from "@/hooks/UseAdminQuery";
import { api } from "@/lib/Api";
import { invalidatePublicProfile } from "@/lib/ProfileCache";
import {
  BAN_DURATIONS,
  GAME_LABELS,
  ROLE_LABELS,
  formatDateTime,
  formatShortDateTime,
} from "@/lib/AdminFormat";
import { useAccountStore } from "@/stores/UseAccountStore";

type Mode = "view" | "ban";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** 状态行：封禁中带上原因与解除时间，没有到期时间即永久。 */
const banStatusText = (user: AdminUserDetail) => {
  if (!user.banned) return "正常";
  const until = user.banExpires ? `${formatDateTime(user.banExpires)} 解除` : "永久";
  return `封禁中（${user.banReason ?? "未写原因"}，${until}）`;
};

/** 封禁与解封共用一个入口位：自己的账号与管理员都不给，已封禁时反转为解封。 */
function BanActionButton({
  self,
  role,
  banned,
  disabled,
  unbanLoading,
  onUnban,
  onBan,
}: {
  self: boolean;
  role: AdminUserDetail["role"];
  banned: boolean;
  disabled: boolean;
  unbanLoading: boolean;
  onUnban: () => void;
  onBan: () => void;
}) {
  if (self || role === "admin") return null;
  if (banned)
    return (
      <Button
        type="button"
        variant="outline"
        loading={unbanLoading}
        disabled={disabled}
        onClick={onUnban}
      >
        解封
      </Button>
    );
  return (
    <Button type="button" variant="destructive" disabled={disabled} onClick={onBan}>
      封禁
    </Button>
  );
}

function UserDetailBody({ user, onChanged }: { user: AdminUserDetail; onChanged: () => void }) {
  const selfId = useAccountStore((state) => state.profile?.id);
  const self = selfId === user.id;
  const [mode, setMode] = useState<Mode>("view");
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState("24");
  const action = useAdminAction();
  const hasContributor = user.badges.some((badge) => badge.kind === "contributor");
  const after = (ok: boolean) => {
    if (!ok) return;
    setMode("view");
    onChanged();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === "ban" && reason.trim()) {
      after(
        await action.run("ban", () =>
          api.admin.users.ban({
            userId: user.id,
            reason: reason.trim(),
            ...(hours !== "0" ? { expiresInHours: Number(hours) } : {}),
          })
        )
      );
    }
  };

  return (
    <div className="grid gap-4">
      <dl className="grid gap-2">
        <Field label="账号">
          <UserCell user={user} />
        </Field>
        <Field label="QQ 昵称">{user.qqName ?? "未查到"}</Field>
        <Field label="角色">{ROLE_LABELS[user.role]}</Field>
        <Field label="状态">{banStatusText(user)}</Field>
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
                <Badge variant="outline" size="xs">
                  {GAME_LABELS[game.game]}
                </Badge>
                <span className="font-mono">{game.roomId}</span>
                <span>{game.roundCount} 回合</span>
                <span>{formatShortDateTime(game.endedAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">还没有对局记录</p>
        )}
      </section>

      <section aria-label="身份徽章" className="grid gap-2">
        <h3 className="text-sm font-semibold">身份徽章</h3>
        {user.badges.length ? (
          <ul className="grid gap-1 text-sm">
            {user.badges.map((badge) => (
              <li key={badge.kind} className="flex flex-wrap items-center gap-2">
                <BadgeChip badge={badge} />
                <span className="text-xs text-muted-foreground">{badgeDescriptionOf(badge)}</span>
                {user.equippedBadge === badge.kind ? (
                  <span className="text-xs text-muted-foreground">佩戴中</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">还没有徽章</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={hasContributor ? "outline" : "default"}
            size="sm"
            loading={action.busy === "badge"}
            disabled={action.busy !== null}
            onClick={() =>
              void action
                .run("badge", () =>
                  hasContributor
                    ? api.admin.users.revokeBadge({ userId: user.id, badge: "contributor" })
                    : api.admin.users.grantBadge({ userId: user.id, badge: "contributor" })
                )
                .then((ok) => {
                  if (ok) invalidatePublicProfile(user.id);
                  after(ok);
                })
            }
          >
            {hasContributor ? "撤销贡献者" : "授予贡献者"}
          </Button>
          <p className="text-xs text-muted-foreground">
            主理人由系统自动授予最高管理员，先行者按注册顺序自动授予前 {PIONEER_BADGE_LIMIT}
            位，均不可手动修改。
          </p>
        </div>
      </section>

      {mode === "ban" ? (
        <form
          onSubmit={(event) => void submit(event)}
          className="grid gap-3 rounded-md border bg-card p-3"
        >
          <SettingsFields>
            <SettingTextField
              label="封禁原因"
              value={reason}
              onChange={setReason}
              placeholder="用户与审计里都能看到"
              maxLength={200}
              autoFocus
              inputClassName="h-10"
            />
            <SettingSelect label="时长" value={hours} options={BAN_DURATIONS} onChange={setHours} />
          </SettingsFields>
          {action.error ? (
            <p role="alert" className="text-sm text-destructive">
              {action.error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={action.busy !== null}
              onClick={() => {
                setMode("view");
                action.clearError();
              }}
            >
              取消
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={!reason.trim()}
              loading={action.busy === "ban"}
            >
              封禁并踢下线
            </Button>
          </div>
        </form>
      ) : (
        <>
          {action.error ? (
            <p role="alert" className="text-sm text-destructive">
              {action.error}
            </p>
          ) : null}
          {self ? (
            <p className="text-xs text-muted-foreground">这是你自己的账号，不能封禁或修改角色。</p>
          ) : null}
          <DialogFooter className="flex-wrap">
            <Button
              type="button"
              variant="outline"
              loading={action.busy === "revoke"}
              disabled={action.busy !== null}
              onClick={() =>
                void action
                  .run("revoke", () => api.admin.users.revokeSessions({ userId: user.id }))
                  .then(after)
              }
            >
              强制下线
            </Button>
            {self ? null : (
              <Button
                type="button"
                variant="outline"
                loading={action.busy === "role"}
                disabled={action.busy !== null || (user.banned && user.role === "user")}
                onClick={() =>
                  void action
                    .run("role", () =>
                      api.admin.users.setRole({
                        userId: user.id,
                        role: user.role === "admin" ? "user" : "admin",
                      })
                    )
                    .then(after)
                }
              >
                {user.role === "admin" ? "取消管理员" : "设为管理员"}
              </Button>
            )}
            <BanActionButton
              self={self}
              role={user.role}
              banned={user.banned}
              disabled={action.busy !== null}
              unbanLoading={action.busy === "unban"}
              onUnban={() =>
                void action
                  .run("unban", () => api.admin.users.unban({ userId: user.id }))
                  .then(after)
              }
              onBan={() => setMode("ban")}
            />
          </DialogFooter>
        </>
      )}
    </div>
  );
}

/** 用户详情与管理操作；每次操作都由服务端先写审计（见 Server/docs/Account.md §8）。 */
export function UserDetailDialog({
  userId,
  onOpenChange,
  onChanged,
}: {
  userId: string | null;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  return (
    <Dialog open={userId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>用户详情</DialogTitle>
          <DialogDescription>
            封禁、改角色、徽章与强制下线都会写入审计。账号昵称取自 QQ 昵称，不可修改。
          </DialogDescription>
        </DialogHeader>
        {userId ? <UserDetailLoader key={userId} userId={userId} onChanged={onChanged} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function UserDetailLoader({ userId, onChanged }: { userId: string; onChanged: () => void }) {
  const detail = useAdminQuery(
    `user:${userId}`,
    () => api.admin.users.get({ userId }),
    "用户详情加载失败"
  );
  return (
    <>
      <QueryState
        loading={detail.loading}
        error={detail.error}
        empty={false}
        hasData={Boolean(detail.data)}
        onRetry={detail.reload}
        emptyText=""
      />
      {detail.data ? (
        <UserDetailBody
          key={`${detail.data.role}:${detail.data.banned}:${detail.data.name}`}
          user={detail.data}
          onChanged={() => {
            detail.reload();
            onChanged();
          }}
        />
      ) : null}
    </>
  );
}
