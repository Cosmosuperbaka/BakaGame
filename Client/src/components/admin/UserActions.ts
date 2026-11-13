import type { AdminUserDetail } from "@bakagame/shared";
import { api } from "@/lib/Api";
import { invalidatePublicProfile } from "@/lib/ProfileCache";

/** 用户详情里需要二次确认的三类写操作。 */
export type UserActionKind = "revoke" | "role" | "badge";

export interface UserActionSpec {
  title: string;
  description: string;
  confirmLabel: string;
  /** 授予类是正向操作，确认钮不用危险色。 */
  destructive: boolean;
  /** 成功后在详情里显示的一句话。 */
  success: string;
  run: () => Promise<unknown>;
}

/** 主理人徽章与服务端的主理人判定同源（按配置的主理人账号自动授予）。 */
export const isOwnerAccount = (user: AdminUserDetail) =>
  user.badges.some((badge) => badge.kind === "owner");

const OWNER_LOCKED = "主理人账号不能被强制下线或取消管理员。";

/**
 * 服务端不允许别人对主理人强制下线或降级，也不允许把已封禁的账号设为管理员：
 * 这些操作在界面上直接禁用并写明原因，不等点了才报错。返回 null 表示可以操作。
 */
export function revokeBlockReason(user: AdminUserDetail, self: boolean): string | null {
  return isOwnerAccount(user) && !self ? OWNER_LOCKED : null;
}

export function roleBlockReason(user: AdminUserDetail): string | null {
  if (isOwnerAccount(user)) return OWNER_LOCKED;
  if (user.banned && user.role === "user") return "该账号已被封禁，需先解封才能设为管理员。";
  return null;
}

/** 点下按钮的那一刻按当时的账号状态定下确认框的文案与动作，退场动画里不随刷新后的数据变样。 */
export function userActionSpec(
  kind: UserActionKind,
  user: AdminUserDetail,
  self: boolean
): UserActionSpec {
  const who = `「${user.name}」`;
  if (kind === "revoke")
    return {
      title: "强制下线",
      description: `让${who}下线？该账号在所有设备上的登录会话会立即失效，需要重新登录${self ? "，包括你现在使用的这一台" : ""}；资料与封禁状态不变。操作会写入审计。`,
      confirmLabel: "强制下线",
      destructive: true,
      success: `已让${who}的全部登录会话失效。`,
      run: () => api.admin.users.revokeSessions({ userId: user.id }),
    };
  if (kind === "role") {
    const promote = user.role !== "admin";
    return {
      title: promote ? "设为管理员" : "取消管理员",
      description: promote
        ? `把${who}设为管理员？对方将能进入管理后台，封禁用户、关闭房间并修改运行期设置。操作会写入审计。`
        : `取消${who}的管理员身份？对方将立即失去管理后台的全部权限。操作会写入审计。`,
      confirmLabel: promote ? "设为管理员" : "取消管理员",
      destructive: true,
      success: promote ? `已把${who}设为管理员。` : `已取消${who}的管理员身份。`,
      run: () => api.admin.users.setRole({ userId: user.id, role: promote ? "admin" : "user" }),
    };
  }
  const grant = !user.badges.some((badge) => badge.kind === "contributor");
  const run = async () => {
    const input = { userId: user.id, badge: "contributor" } as const;
    await (grant ? api.admin.users.grantBadge(input) : api.admin.users.revokeBadge(input));
    invalidatePublicProfile(user.id);
  };
  return {
    title: grant ? "授予贡献者徽章" : "撤销贡献者徽章",
    description: grant
      ? `给${who}授予贡献者徽章？徽章会公开展示在对方的个人资料上。操作会写入审计。`
      : `收回${who}的贡献者徽章？对方的个人资料上将不再展示它。操作会写入审计。`,
    confirmLabel: grant ? "授予" : "撤销",
    destructive: !grant,
    success: grant ? `已授予${who}贡献者徽章。` : `已撤销${who}的贡献者徽章。`,
    run,
  };
}
