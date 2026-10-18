/* eslint-disable react-refresh/only-export-components -- 打开登录弹窗与弹窗本体共用同一份入口状态，拆文件会让状态定义漂到别处。 */
import { useState, type MouseEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { create } from "zustand";
import { LogIn, LogOut, MessageSquareText, ShieldCheck, UserRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Hint } from "@/components/ui/Tooltip";
import { PlayerAvatar } from "@/components/common/PlayerAvatar";
import { PlayerActionButton } from "@/components/common/PlayerRow";
import { FeedbackDialog } from "@/components/account/FeedbackDialog";
import { LoginDialog } from "@/components/account/LoginDialog";
import { ProfileDialog } from "@/components/account/ProfileDialog";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { headerTappable, popover, pressable, type OriginPoint } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { useAccountStore, type AccountStatus } from "@/stores/UseAccountStore";

type DialogKind = "login" | "profile" | "feedback" | null;

/** 三个入口共用的弹窗状态：哪一个打开、从哪里展开、登录成功后接着打开什么。 */
const useEntryStore = create<{
  dialog: DialogKind;
  afterLogin: DialogKind;
  origin: OriginPoint | null;
}>(() => ({
  dialog: null,
  afterLogin: null,
  origin: null,
}));

const originOf = (event: MouseEvent<HTMLElement>): OriginPoint => {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

const openDialog = (
  dialog: DialogKind,
  origin: OriginPoint | null,
  afterLogin: DialogKind = null
) => useEntryStore.setState({ dialog, afterLogin, origin });

/**
 * 从非账号入口（如反作弊房被服务端要求登录）请求打开登录弹窗。
 * 依赖当前页挂载过 `<AccountDialogs/>`——CEE 布局与首页都挂了；账号系统未启用时它是空实现。
 */
export function requestLogin(): void {
  openDialog("login", null);
}

const isAvailable = (status: AccountStatus) => status === "guest" || status === "signedIn";

/** 未读回复的小红点：只作提示，数量由按钮的可访问名与菜单项读出。 */
function UnreadDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("h-2 w-2 rounded-full bg-destructive ring-2 ring-background", className)}
    />
  );
}

/**
 * 主页右上角的账号入口：游客为登录按钮，登录后为头像菜单（资料、反馈、后台、退出）。
 * 账号系统未启用或接口不可达时不渲染；首屏读取中只占位，页头不跳。
 */
export function AccountButton() {
  const status = useAccountStore((state) => state.status);
  const profile = useAccountStore((state) => state.profile);
  const unread = useAccountStore((state) => state.unreadFeedback);
  const signOut = useAccountStore((state) => state.signOut);
  const navigate = usePageNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // 菜单项被点时浮层已在关闭，弹窗从菜单按钮处展开。
  const [menuOrigin, setMenuOrigin] = useState<OriginPoint | null>(null);

  if (status === "loading") return <span aria-hidden="true" className="block h-9 w-20" />;
  if (status === "guest") {
    return (
      <Button variant="ghost" onClick={(event) => openDialog("login", originOf(event))}>
        <LogIn />
        登录
      </Button>
    );
  }
  if (status !== "signedIn" || !profile) return null;

  return (
    <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
      <Popover.Trigger asChild>
        <motion.button
          type="button"
          {...headerTappable}
          aria-label={`账号菜单：${profile.name}${unread ? `，${unread} 条未读回复` : ""}`}
          onClick={(event) => setMenuOrigin(originOf(event))}
          className="relative flex h-9 max-w-44 items-center gap-2 rounded-md px-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <PlayerAvatar name={profile.name} image={profile.image} className="h-7 w-7" />
          <span className="hidden truncate sm:inline">{profile.name}</span>
          {unread ? <UnreadDot className="absolute left-6 top-1" /> : null}
        </motion.button>
      </Popover.Trigger>
      <AnimatePresence>
        {menuOpen ? (
          <Popover.Portal forceMount>
            <Popover.Content
              forceMount
              side="bottom"
              align="end"
              sideOffset={6}
              collisionPadding={12}
              asChild
            >
              <motion.div
                variants={popover}
                initial="initial"
                animate="animate"
                exit="exit"
                className="z-popover w-56 origin-(--radix-popover-content-transform-origin) overflow-hidden floating-surface shadow-md"
              >
                <div className="border-b px-4 py-3">
                  <Hint label={profile.name}>
                    <div className="truncate font-semibold">{profile.name}</div>
                  </Hint>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    QQ <span className="font-mono">{profile.qqNumber}</span>
                  </div>
                </div>
                <div className="flex flex-col">
                  <PlayerActionButton
                    icon={<UserRound className="h-3.5 w-3.5" />}
                    label="账号资料"
                    onClick={() => openDialog("profile", menuOrigin)}
                  />
                  <PlayerActionButton
                    icon={<MessageSquareText className="h-3.5 w-3.5" />}
                    label={unread ? `我的反馈（${unread} 条新回复）` : "我的反馈"}
                    onClick={() => openDialog("feedback", menuOrigin)}
                  />
                  {profile.role === "admin" ? (
                    <PlayerActionButton
                      icon={<ShieldCheck className="h-3.5 w-3.5" />}
                      label="管理后台"
                      onClick={() => void navigate("/admin")}
                    />
                  ) : null}
                  <PlayerActionButton
                    icon={<LogOut className="h-3.5 w-3.5" />}
                    label="退出登录"
                    destructive
                    disabled={signingOut}
                    onClick={() => {
                      setSigningOut(true);
                      void signOut()
                        .catch(() => {})
                        .finally(() => setSigningOut(false));
                    }}
                  />
                </div>
              </motion.div>
            </Popover.Content>
          </Popover.Portal>
        ) : null}
      </AnimatePresence>
    </Popover.Root>
  );
}

/** 页脚的反馈入口：只对登录用户开放，游客点击先登录、登录成功后接着打开反馈。 */
export function FeedbackButton() {
  const status = useAccountStore((state) => state.status);
  const unread = useAccountStore((state) => state.unreadFeedback);
  if (!isAvailable(status)) return null;
  return (
    <motion.button
      type="button"
      {...pressable}
      onClick={(event) =>
        status === "signedIn"
          ? openDialog("feedback", originOf(event))
          : openDialog("login", originOf(event), "feedback")
      }
      className="relative flex min-h-8 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <MessageSquareText className="h-3.5 w-3.5" aria-hidden="true" />
      反馈
      {unread ? (
        <>
          <UnreadDot className="absolute right-0.5 top-0.5" />
          <span className="sr-only">（{unread} 条新回复）</span>
        </>
      ) : null}
    </motion.button>
  );
}

/** 账号入口共用的弹窗，每页挂一次。 */
export function AccountDialogs() {
  const status = useAccountStore((state) => state.status);
  const dialog = useEntryStore((state) => state.dialog);
  const origin = useEntryStore((state) => state.origin);
  if (!isAvailable(status)) return null;

  const close = (open: boolean) => {
    if (!open) useEntryStore.setState({ dialog: null, afterLogin: null });
  };
  const closeLogin = (open: boolean) => {
    if (open) return;
    // 登录成功后接着打开触发登录的那件事；取消则一并放弃。
    const { afterLogin } = useEntryStore.getState();
    const signedIn = useAccountStore.getState().status === "signedIn";
    useEntryStore.setState({ dialog: signedIn ? afterLogin : null, afterLogin: null });
  };

  return (
    <>
      <LoginDialog open={dialog === "login"} onOpenChange={closeLogin} origin={origin} />
      <ProfileDialog open={dialog === "profile"} onOpenChange={close} origin={origin} />
      <FeedbackDialog open={dialog === "feedback"} onOpenChange={close} origin={origin} />
    </>
  );
}
