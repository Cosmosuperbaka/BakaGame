import type { AdminUserDetail } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { DialogFooter } from "@/components/ui/Dialog";
import {
  revokeBlockReason,
  roleBlockReason,
  type UserActionKind,
} from "@/components/admin/UserActions";

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

/**
 * 用户详情底部的操作条。强制下线、改角色只打开确认框，真正的请求在确认之后；
 * 服务端一定会拒绝的操作直接禁用，并在按钮上方写明原因。
 */
export function UserActionBar({
  user,
  self,
  busy,
  onAsk,
  onUnban,
  onBan,
}: {
  user: AdminUserDetail;
  self: boolean;
  /** 封禁或解封请求在途时为对应名字。 */
  busy: string | null;
  onAsk: (kind: UserActionKind) => void;
  onUnban: () => void;
  onBan: () => void;
}) {
  const revokeBlocked = revokeBlockReason(user, self);
  const roleBlocked = self ? null : roleBlockReason(user);
  const hints = new Set<string>();
  if (self) hints.add("这是你自己的账号，不能封禁或修改角色。");
  if (revokeBlocked) hints.add(revokeBlocked);
  if (roleBlocked) hints.add(roleBlocked);
  return (
    <>
      {[...hints].map((hint) => (
        <p key={hint} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ))}
      <DialogFooter className="flex-wrap">
        <Button
          type="button"
          variant="outline"
          disabled={busy !== null || revokeBlocked !== null}
          onClick={() => onAsk("revoke")}
        >
          强制下线
        </Button>
        {self ? null : (
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null || roleBlocked !== null}
            onClick={() => onAsk("role")}
          >
            {user.role === "admin" ? "取消管理员" : "设为管理员"}
          </Button>
        )}
        <BanActionButton
          self={self}
          role={user.role}
          banned={user.banned}
          disabled={busy !== null}
          unbanLoading={busy === "unban"}
          onUnban={onUnban}
          onBan={onBan}
        />
      </DialogFooter>
    </>
  );
}
