import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { badgeDescriptionOf, PIONEER_BADGE_LIMIT } from "@bakagame/shared/values";
import type { AdminUserDetail } from "@bakagame/shared";
import { FormAlert } from "@/components/account/FormAlert";
import { Badge } from "@/components/ui/Badge";
import { BadgeChip } from "@/components/common/BadgeList";
import { Button } from "@/components/ui/Button";
import { SettingsFields } from "@/components/common/room/settings/Layout";
import { SettingSelect } from "@/components/common/room/settings/ChoiceFields";
import { SettingTextField } from "@/components/common/room/settings/TextFields";
import {
  AdminDetailDialog,
  AdminNotice,
  ConfirmDialog,
  QueryStatus,
  UserCell,
} from "@/components/admin/AdminParts";
import { UserActionBar } from "@/components/admin/UserActionBar";
import {
  userActionSpec,
  type UserActionKind,
  type UserActionSpec,
} from "@/components/admin/UserActions";
import { useAdminAction, useAdminQuery } from "@/hooks/UseAdminQuery";
import { api, apiErrorMessage } from "@/lib/Api";
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

function UserDetailBody({ user, onChanged }: { user: AdminUserDetail; onChanged: () => void }) {
  const selfId = useAccountStore((state) => state.profile?.id);
  const self = selfId === user.id;
  const [mode, setMode] = useState<Mode>("view");
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState("24");
  const action = useAdminAction();
  // 确认框的文案在点下按钮时定稿（见 userActionSpec），open 与 spec 分开存：关闭后文案保留到退场动画结束。
  const [confirm, setConfirm] = useState<{ spec: UserActionSpec; open: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const hasContributor = user.badges.some((badge) => badge.kind === "contributor");
  const banFormRef = useRef<HTMLFormElement>(null);
  // 封禁表单接在长弹窗末尾，弹窗滚动条是隐藏的：展开后把整张表单（含确认按钮）滚进可见范围。
  // jsdom 没有 scrollIntoView，按可选调用处理。
  useEffect(() => {
    if (mode === "ban") banFormRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [mode]);
  const after = (ok: boolean, success: string) => {
    if (!ok) return;
    setMode("view");
    setReason("");
    setHours("24");
    setNotice(success);
    onChanged();
  };
  const ask = (kind: UserActionKind) => {
    setNotice(null);
    action.clearError();
    setConfirm({ spec: userActionSpec(kind, user, self), open: true });
  };
  const confirmed = async () => {
    if (!confirm) return null;
    try {
      await confirm.spec.run();
    } catch (cause) {
      return apiErrorMessage(cause, "操作失败，请稍后重试");
    }
    setNotice(confirm.spec.success);
    onChanged();
    return null;
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
        ),
        `已封禁「${user.name}」并踢下线。`
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
              <li
                key={game.id}
                className="flex flex-wrap items-center gap-x-2 text-muted-foreground"
              >
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
                {/* 佩戴状态是一枚标记，不是说明句的延续：裸灰字紧跟在说明后面会读成同一句话。 */}
                {user.equippedBadge === badge.kind ? (
                  <Badge variant="active" size="xs">
                    佩戴中
                  </Badge>
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
            // 授予与撤销同为描边：实心主色在一屏操作里比「封禁」还抢眼，状态由按钮文字表达。
            variant="outline"
            size="sm"
            disabled={action.busy !== null}
            onClick={() => ask("badge")}
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
          ref={banFormRef}
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
          {action.error ? <FormAlert>{action.error}</FormAlert> : null}
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
          {action.error ? <FormAlert>{action.error}</FormAlert> : null}
          {notice ? <AdminNotice>{notice}</AdminNotice> : null}
          <UserActionBar
            user={user}
            self={self}
            busy={action.busy}
            onAsk={ask}
            onUnban={() =>
              void action
                .run("unban", () => api.admin.users.unban({ userId: user.id }))
                .then((ok) => after(ok, `已解封「${user.name}」。`))
            }
            onBan={() => {
              setNotice(null);
              setMode("ban");
            }}
          />
        </>
      )}
      {confirm ? (
        <ConfirmDialog
          open={confirm.open}
          onOpenChange={(open) => setConfirm((current) => current && { ...current, open })}
          title={confirm.spec.title}
          description={confirm.spec.description}
          confirmLabel={confirm.spec.confirmLabel}
          destructive={confirm.spec.destructive}
          onConfirm={confirmed}
        />
      ) : null}
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
    <AdminDetailDialog
      open={userId !== null}
      onClose={() => onOpenChange(false)}
      title="用户详情"
      description="封禁、改角色、徽章与强制下线都会写入审计。账号昵称取自 QQ 昵称，不可修改。"
      contentClassName="sm:max-w-xl"
    >
      {userId ? <UserDetailLoader key={userId} userId={userId} onChanged={onChanged} /> : null}
    </AdminDetailDialog>
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
      <QueryStatus query={detail} />
      {detail.data ? (
        // 不按角色与封禁状态换 key：操作成功后详情重读，重挂载会吞掉成功说明、切断确认框的退场动画。
        <UserDetailBody
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
