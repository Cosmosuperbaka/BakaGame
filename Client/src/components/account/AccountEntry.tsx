/* eslint-disable react-refresh/only-export-components -- 打开登录弹窗与弹窗本体共用同一份入口状态，拆文件会让状态定义漂到别处。 */
import { useEffect, useState, type MouseEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { create } from "zustand";
import { LogOut, MessageSquareText, ShieldCheck, UserRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Hint } from "@/components/ui/Tooltip";
import { PlayerAvatar } from "@/components/common/PlayerAvatar";
import { PlayerActionButton } from "@/components/common/PlayerRow";
import { SoundToggle } from "@/components/common/SoundToggle";
import { ThemeToggle } from "@/components/common/ThemeToggle";
import { FeedbackDialog, type FeedbackDraft } from "@/components/account/FeedbackDialog";
import { LoginDialog } from "@/components/account/LoginDialog";
import { ProfileDialog } from "@/components/account/ProfileDialog";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { headerTappable, popover, type OriginPoint } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { useAccountStore } from "@/stores/UseAccountStore";

type DialogKind = "login" | "profile" | "feedback" | null;

/** 三个入口共用的弹窗状态，以及游客「登录并提交」时跨弹窗保留的反馈草稿。 */
const useEntryStore = create<{
  dialog: DialogKind;
  origin: OriginPoint | null;
  /** 登录成功后接着打开的弹窗。 */
  afterLogin: DialogKind;
  feedbackDraft: FeedbackDraft | null;
  /** 登录成功后自动提交草稿；取消登录时为 false，草稿回填到匿名表单。 */
  submitAfterLogin: boolean;
}>(() => ({
  dialog: null,
  origin: null,
  afterLogin: null,
  feedbackDraft: null,
  submitAfterLogin: false,
}));

const originOf = (event: MouseEvent<HTMLElement>): OriginPoint => {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

const openDialog = (dialog: DialogKind, origin: OriginPoint | null) =>
  useEntryStore.setState({
    dialog,
    origin,
    afterLogin: null,
    feedbackDraft: null,
    submitAfterLogin: false,
  });

const loginForFeedback = (draft: FeedbackDraft) =>
  useEntryStore.setState({
    dialog: "login",
    afterLogin: "feedback",
    feedbackDraft: draft,
    submitAfterLogin: false,
  });

const clearFeedbackDraft = () =>
  useEntryStore.setState({ feedbackDraft: null, submitAfterLogin: false });

/**
 * 从非账号入口（如反作弊房被服务端要求登录）请求打开登录弹窗。
 * 依赖当前页挂载过 `<AccountDialogs/>`——CEE 布局与首页都挂了；账号服务不可用时弹窗照常打开，
 * 由登录接口给出错误提示。
 */
export function requestLogin(): void {
  openDialog("login", null);
}

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
 * 主页右上角的账号入口：未登录为「账号」按钮（点了才谈登录），登录后为头像菜单
 * （资料、反馈、后台、退出）。账号服务不可用时入口照常可见，登录失败由接口给出提示；
 * 首屏读取中用同尺寸的禁用按钮占位，页头不跳。
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

  return (
    <>
      <ThemeToggle />
      <SoundToggle />
      {status === "signedIn" && profile ? (
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
      ) : (
        <Button
          variant="ghost"
          disabled={status === "loading"}
          onClick={(event) => openDialog("login", originOf(event))}
        >
          <UserRound />
          账号
        </Button>
      )}
    </>
  );
}

/** 顶栏的反馈入口：始终可见；未登录也能提交匿名反馈。 */
export function FeedbackButton() {
  const unread = useAccountStore((state) => state.unreadFeedback);
  return (
    <Button
      variant="ghost"
      className="relative"
      aria-label={unread ? `反馈（${unread} 条新回复）` : "反馈"}
      onClick={(event) => openDialog("feedback", originOf(event))}
    >
      <MessageSquareText aria-hidden="true" />
      {/* 矮屏（横屏手机）上页头本来就挤，这一排又贴着标题的位置：只留图标，名称走 aria-label。 */}
      <span className="[@media(max-height:680px)]:hidden">反馈</span>
      {unread ? <UnreadDot className="absolute right-1 top-1" /> : null}
    </Button>
  );
}

/** 账号入口共用的弹窗，每页挂一次；账号服务不可用时仍要挂反馈弹窗。 */
export function AccountDialogs() {
  const dialog = useEntryStore((state) => state.dialog);
  const origin = useEntryStore((state) => state.origin);
  const feedbackDraft = useEntryStore((state) => state.feedbackDraft);
  const submitAfterLogin = useEntryStore((state) => state.submitAfterLogin);
  // 切到没有这一层的页面时一并关掉，避免回到首页又弹出上一次的弹窗。
  useEffect(
    () => () =>
      useEntryStore.setState({
        dialog: null,
        afterLogin: null,
        feedbackDraft: null,
        submitAfterLogin: false,
      }),
    []
  );
  const close = (open: boolean) => {
    if (!open)
      useEntryStore.setState({
        dialog: null,
        afterLogin: null,
        feedbackDraft: null,
        submitAfterLogin: false,
      });
  };
  const closeLogin = (open: boolean) => {
    if (open) return;
    const { afterLogin } = useEntryStore.getState();
    if (!afterLogin) {
      close(false);
      return;
    }
    // 登录成功才自动提交；取消则回到反馈表单，保留草稿。
    const signedIn = useAccountStore.getState().status === "signedIn";
    useEntryStore.setState({
      dialog: afterLogin,
      afterLogin: null,
      submitAfterLogin: signedIn,
    });
  };

  return (
    <>
      <LoginDialog open={dialog === "login"} onOpenChange={closeLogin} origin={origin} />
      <ProfileDialog open={dialog === "profile"} onOpenChange={close} origin={origin} />
      <FeedbackDialog
        open={dialog === "feedback"}
        onOpenChange={close}
        origin={origin}
        draft={feedbackDraft}
        autoSubmit={submitAfterLogin && feedbackDraft !== null}
        onAutoSubmitted={clearFeedbackDraft}
        onRequestLogin={loginForFeedback}
      />
    </>
  );
}
