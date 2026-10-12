import { create } from "zustand";
import type { AccountProfile } from "@/types";
import { api, isAccountDisabled, signInWithCode, signOut as requestSignOut } from "@/lib/Api";
import { captureClientLog } from "@/lib/Sentry";
import { refreshSocketIdentities } from "@/lib/WebsocketClient";

/**
 * 站点账号状态。
 *
 * - `loading`：首屏 `account.me` 未返回；
 * - `unavailable`：账号系统未启用或接口不可达，隐藏全部账号入口，游客照常游玩；
 * - `guest` / `signedIn`：可登录 / 已登录。
 *
 * 每次访问只调一次 `account.me`（服务端顺带按节流刷新 QQ 头像，见 Agents/Account.md §4）；
 * 登录、退出后重连游戏 WebSocket，让握手重新解析会话 Cookie。
 */
export type AccountStatus = "loading" | "unavailable" | "guest" | "signedIn";

interface AccountState {
  status: AccountStatus;
  profile: AccountProfile | null;
  /** 未读的反馈回复数；由反馈弹窗与登录后的首次拉取维护。 */
  unreadFeedback: number;
  load: () => Promise<void>;
  signIn: (input: { email: string; otp: string; name?: string }) => Promise<void>;
  signOut: () => Promise<void>;
  setProfile: (profile: AccountProfile) => void;
  setUnreadFeedback: (count: number) => void;
}

let loading: Promise<void> | null = null;

const fetchProfile = async (): Promise<Pick<AccountState, "status" | "profile">> => {
  try {
    const profile = await api.account.me();
    return profile ? { status: "signedIn", profile } : { status: "guest", profile: null };
  } catch (error) {
    // 停用（`ACCOUNT_DISABLED`）是确定状态；网络与网关失败本次访问同样按不可用处理，只是不必上报。
    if (!isAccountDisabled(error)) captureClientLog("账号接口不可用", "warning", { error: error instanceof Error ? error.message : String(error) });
    return { status: "unavailable", profile: null };
  }
};

const refreshUnread = (set: (patch: Partial<AccountState>) => void) => {
  api.feedback.listMine()
    .then(({ unread }) => set({ unreadFeedback: unread }))
    .catch(() => {});
};

export const useAccountStore = create<AccountState>((set, get) => ({
  status: "loading",
  profile: null,
  unreadFeedback: 0,

  load: () => {
    loading ??= fetchProfile().then((next) => {
      set(next);
      if (next.status === "signedIn") refreshUnread(set);
    });
    return loading;
  },

  signIn: async (input) => {
    await signInWithCode(input);
    const next = await fetchProfile();
    set({ ...next, unreadFeedback: 0 });
    if (next.status === "signedIn") refreshUnread(set);
    refreshSocketIdentities();
  },

  signOut: async () => {
    await requestSignOut();
    set({ status: get().status === "unavailable" ? "unavailable" : "guest", profile: null, unreadFeedback: 0 });
    refreshSocketIdentities();
  },

  setProfile: (profile) => set({ profile }),
  setUnreadFeedback: (count) => set({ unreadFeedback: count }),
}));

/** 仅测试使用：清掉模块级的单次加载缓存。 */
export const resetAccountStoreForTest = () => {
  loading = null;
  useAccountStore.setState({ status: "loading", profile: null, unreadFeedback: 0 });
};
