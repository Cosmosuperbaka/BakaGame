import { useEffect, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, KeyRound, UserRound } from "lucide-react";
import {
  LOGIN_CODE_LENGTH,
  LOGIN_CODE_PATTERN,
  LOGIN_CODE_TTL_SECONDS,
  qlogoUrlOf,
  qqEmailOf,
  QQ_NUMBER_PATTERN,
} from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { Collapsible, CollapsibleRegion } from "@/components/ui/Collapsible";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/Dialog";
import { SettingTextField } from "@/components/common/room/SettingFields";
import { IDLE_SEARCH_MS } from "@/hooks/UseIdleSearch";
import { api, apiErrorMessage } from "@/lib/Api";
import { createQueryReuseCache, exactQueryKey, type QueryReuseCache } from "@/lib/QueryReuse";
import { indicatorSlide, listItem, phaseSwap, readoutSwap, type OriginPoint } from "@/lib/Motion";
import { passkeyErrorMessage, passkeySupported } from "@/lib/Passkey";
import { useAccountStore } from "@/stores/UseAccountStore";

type Step = { kind: "qq" } | { kind: "code"; registered: boolean; qqName: string | null };

/** 重发倒计时：只记到期时刻，每秒重渲染一次。 */
function useCountdown() {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= now) return;
    const timer = window.setTimeout(() => setNow(Date.now()), 1_000);
    return () => window.clearTimeout(timer);
  }, [until, now]);
  return {
    seconds: Math.max(0, Math.ceil((until - now) / 1_000)),
    start: (seconds: number) => {
      const current = Date.now();
      setNow(current);
      setUntil(current + seconds * 1_000);
    },
  };
}

/**
 * QQ 号一输完就去查昵称，不等发码。停输 `IDLE_SEARCH_MS` 再查，避免逐位敲字各打一次；
 * 查不到（号不存在、查询号掉线、超出配额、网络失败）一律当作没有昵称，空着不挡住发码。
 * 结果按所属 QQ 号存：号一改立刻不显示上一号的名字，宁可空着也不把别人的昵称安在这个号上。
 * 取到的值经 `qqNames` 复用：服务端这个入口按客户端地址限流（12 次/分钟），
 * 关掉再打开弹窗、退回重输同一个号都不该再打一次。
 */
function useQQName(qq: string, qqNames: QueryReuseCache<string | null>): string | null {
  const valid = QQ_NUMBER_PATTERN.test(qq);
  const [shown, setShown] = useState<{ qq: string; name: string | null } | null>(null);
  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void qqNames
        .run(qq, () => api.account.qqName({ qqNumber: qq }))
        .then((name) => !cancelled && setShown({ qq, name }))
        .catch(() => !cancelled && setShown({ qq, name: null }));
    }, IDLE_SEARCH_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [valid, qq, qqNames]);
  return valid && shown?.qq === qq ? shown.name : null;
}

/**
 * 身份区的圆头像：QQ 号合法即按该号取 qlogo（此时 QQ 号就是用户自己刚输入的，见 Agents/Account.md §4），
 * 未填或取不到时是同一尺寸的占位圆，号一变新头像自原位缩放接手，读作「换了一张脸」而不是闪一下。
 */
function LoginAvatar({
  qq,
  failed,
  onFailed,
}: {
  qq: string;
  failed: boolean;
  onFailed: () => void;
}) {
  if (!QQ_NUMBER_PATTERN.test(qq) || failed) {
    return (
      <span
        aria-hidden="true"
        className="flex h-20 w-20 items-center justify-center rounded-full border border-border bg-background text-muted-foreground"
      >
        <UserRound className="h-7 w-7" />
      </span>
    );
  }
  return (
    <motion.img
      key={qq}
      variants={listItem}
      initial="initial"
      animate="animate"
      src={qlogoUrlOf(qq)}
      alt={`QQ ${qq} 的头像`}
      referrerPolicy="no-referrer"
      onError={onFailed}
      className="h-20 w-20 rounded-full border border-border object-cover shadow-sm"
    />
  );
}

/** 两步的进度点：当前一步是一枚长条，切步时沿 indicatorSlide 滑到另一格。 */
function StepDots({ active }: { active: 0 | 1 }) {
  return (
    <div aria-hidden="true" className="flex items-center justify-center gap-1.5">
      {[0, 1].map((index) => (
        <span key={index} className="flex h-1 w-4 justify-center">
          {index === active ? (
            <motion.span
              layoutId="login-step"
              className="h-1 w-4 rounded-full bg-foreground/45"
              transition={indicatorSlide}
            />
          ) : (
            <span className="h-1 w-1 rounded-full bg-border" />
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * 登录的用途与 QQ 号边界：默认收起，第一段话只回答访客最可能的两个顾虑——
 * 不登录能不能玩、要不要交出 QQ 密码。验证码投递到哪由字段说明就地写明（发完后仍常驻），
 * 通行密钥从哪来写在最后一段（页脚那个按钮只有一枚图标加四个字，说不清来路）。
 */
function LoginNotice() {
  return (
    <Collapsible title="登录说明" size="sm">
      <div className="space-y-1.5 text-xs text-muted-foreground">
        <p>登录只用于少数需要身份验证的功能：云同步设置、提交反馈、房间内显示你的头像。</p>
        <p>不登录不影响绝大部分功能的正常游玩。</p>
        <p>用 QQ 号作登录凭据仅是为了方便身份关联：我们不索要你的 QQ 密码和其它隐私信息。</p>
        <p>通行密钥在登录后的「账号资料」里添加，之后在这台设备上登录不必再收验证码。</p>
      </div>
    </Collapsible>
  );
}

/**
 * 登录 / 注册弹窗（首次登录即注册，见 Agents/Account.md §1）。
 *
 * 整块弹窗分两区：上方通栏身份区常驻——标题、圆头像、昵称与 QQ 号，两步共用，切步时身份不消失；
 * 下方操作区按步切换字段（QQ 号 → 验证码），新内容自后方推入、旧内容向前退出（`phaseSwap`）。
 * 昵称与 QQ 号各自按到达时机展开：号一合法先落 QQ 号，紧接着输完号查到的昵称自它上方顶进来，
 * 发码后再以服务端回传值为准；
 * 两步的字段说明与页脚都预留同一高度，切步只换内容、不跳高度：页脚两步各放两枚按钮
 * （第一步「通行密钥 + 发送验证码」，第二步「换个 QQ 号 + 登录」）。
 * 操作区底部常驻一段收起的登录说明（用途、QQ 号边界、验证码投递、通行密钥来路），两步共用、不随切步跳动。
 */
export function LoginDialog({
  open,
  onOpenChange,
  origin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  origin?: OriginPoint | null;
}) {
  // QQ 号留在外层：关掉再打开仍保留上次输入；其余状态随弹窗内容每次打开重新开始。
  const [qq, setQq] = useState("");
  // 昵称窗口也留在外层：本组件随页面常驻，关掉再打开、退回重输同一个号都不再打一次限流接口。
  const [qqNames] = useState(() => createQueryReuseCache<string | null>(exactQueryKey));
  return (
    <Dialog open={open} onOpenChange={onOpenChange} origin={origin}>
      <LoginDialogBody qq={qq} setQq={setQq} qqNames={qqNames} onDone={() => onOpenChange(false)} />
    </Dialog>
  );
}

function LoginDialogBody({
  qq,
  setQq,
  qqNames,
  onDone,
}: {
  qq: string;
  setQq: (value: string) => void;
  qqNames: QueryReuseCache<string | null>;
  onDone: () => void;
}) {
  const signIn = useAccountStore((state) => state.signIn);
  const signInWithPasskey = useAccountStore((state) => state.signInWithPasskey);
  // 不支持 WebAuthn 的浏览器（老旧内核、非安全上下文）连系统弹窗都调不起来，入口整段不出现。
  const [supportsPasskey] = useState(passkeySupported);
  const [step, setStep] = useState<Step>({ kind: "qq" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"send" | "resend" | "sign-in" | "passkey" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const countdown = useCountdown();

  const validQq = QQ_NUMBER_PATTERN.test(qq);
  const lookedUpName = useQQName(qq, qqNames);

  const sendCode = async (mode: "send" | "resend") => {
    setBusy(mode);
    setError(null);
    try {
      const result = await api.account.requestLoginCode({ qqNumber: qq });
      countdown.start(result.resendAfterSeconds);
      setStep({ kind: "code", registered: result.registered, qqName: result.qqName });
    } catch (cause) {
      setError(apiErrorMessage(cause, "验证码发送失败，请稍后重试"));
    } finally {
      setBusy(null);
    }
  };

  const isRegister = step.kind === "code" && !step.registered;
  const title = isRegister ? "注册账号" : "登录";
  /**
   * 头像下的身份行：号一输完就回显查到的昵称；发码后改用服务端回传值
   * （新号为刚落库的昵称，老号为库中最近同步的），它为空时仍用回显值兜住。
   */
  const identityName = step.kind === "code" ? (step.qqName ?? lookedUpName) : lookedUpName;
  const canSignIn = LOGIN_CODE_PATTERN.test(code);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (step.kind === "qq") {
      if (validQq) await sendCode("send");
      return;
    }
    if (!canSignIn) return;
    setBusy("sign-in");
    setError(null);
    try {
      await signIn({ email: qqEmailOf(qq), otp: code });
      onDone();
    } catch (cause) {
      setError(
        cause instanceof Error && /[一-鿿]/.test(cause.message)
          ? cause.message
          : "登录失败，请稍后重试"
      );
    } finally {
      setBusy(null);
    }
  };

  /** 通行密钥与验证码并列：它不查 QQ 号、不发邮件，凭据由本机保管。 */
  const signInByPasskey = async () => {
    setBusy("passkey");
    setError(null);
    try {
      await signInWithPasskey();
      onDone();
    } catch (cause) {
      setError(passkeyErrorMessage(cause, "通行密钥登录失败，请改用验证码"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <DialogContent className="max-w-sm gap-0 p-0">
      <form onSubmit={(event) => void submit(event)} className="grid">
        <div className="flex flex-col items-center gap-3 rounded-t-md border-b border-border/60 bg-muted/40 px-6 pb-5 pt-8">
          <DialogTitle className="text-center">
            <motion.span
              key={title}
              variants={readoutSwap}
              initial="initial"
              animate="animate"
              className="block"
            >
              {title}
            </motion.span>
          </DialogTitle>
          <LoginAvatar qq={qq} failed={avatarFailed} onFailed={() => setAvatarFailed(true)} />
          <div className="flex w-full flex-col items-center gap-0.5">
            <span className="flex h-6 max-w-full items-center justify-center">
              {identityName ? (
                <motion.span
                  key={identityName}
                  variants={readoutSwap}
                  initial="initial"
                  animate="animate"
                  className="max-w-full truncate text-base font-semibold"
                >
                  {identityName}
                </motion.span>
              ) : null}
            </span>
            <CollapsibleRegion open={validQq}>
              <p className="text-center font-mono text-xs text-muted-foreground">QQ {qq}</p>
            </CollapsibleRegion>
          </div>
        </div>

        <div className="grid gap-4 p-6 pt-5">
          <StepDots active={step.kind === "code" ? 1 : 0} />
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step.kind}
              variants={phaseSwap}
              initial="initial"
              animate="animate"
              exit="exit"
              className="grid gap-4"
            >
              {step.kind === "qq" ? (
                <SettingTextField
                  label="QQ 号"
                  value={qq}
                  onChange={(value) => {
                    setQq(value.replace(/\D/g, "").slice(0, 11));
                    setAvatarFailed(false);
                    setError(null);
                  }}
                  placeholder="输入你的 QQ 号"
                  description={
                    validQq ? `验证码将发送至 ${qqEmailOf(qq)}` : "验证码将发送至对应的 QQ 邮箱"
                  }
                  inputMode="numeric"
                  maxLength={11}
                  autoFocus
                  inputClassName="h-10"
                />
              ) : (
                <SettingTextField
                  label="验证码"
                  value={code}
                  onChange={(value) => {
                    setCode(value.replace(/\D/g, "").slice(0, LOGIN_CODE_LENGTH));
                    setError(null);
                  }}
                  placeholder={`${LOGIN_CODE_LENGTH} 位数字`}
                  description={`已发送至 ${qqEmailOf(qq)}，${LOGIN_CODE_TTL_SECONDS / 60} 分钟内有效`}
                  inputMode="numeric"
                  maxLength={LOGIN_CODE_LENGTH}
                  autoFocus
                  inputClassName="h-10 font-mono tracking-widest"
                  action={
                    <Button
                      type="button"
                      variant="outline"
                      className="h-10 shrink-0"
                      disabled={countdown.seconds > 0 || busy !== null}
                      loading={busy === "resend"}
                      onClick={() => void sendCode("resend")}
                    >
                      {countdown.seconds > 0 ? `${countdown.seconds} 秒后重发` : "重新发送"}
                    </Button>
                  }
                />
              )}
              <CollapsibleRegion open={Boolean(error)}>
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              </CollapsibleRegion>
            </motion.div>
          </AnimatePresence>

          <LoginNotice />

          <DialogFooter className="min-h-20 sm:min-h-9">
            {step.kind === "qq" && supportsPasskey ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy !== null}
                loading={busy === "passkey"}
                onClick={() => void signInByPasskey()}
              >
                <KeyRound />
                通行密钥
              </Button>
            ) : null}
            {step.kind === "code" ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy !== null}
                onClick={() => {
                  setStep({ kind: "qq" });
                  setError(null);
                }}
              >
                <ArrowLeft />
                换个 QQ 号
              </Button>
            ) : null}
            {step.kind === "qq" ? (
              <Button type="submit" disabled={!validQq || busy !== null} loading={busy === "send"}>
                发送验证码
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={!canSignIn || (busy !== null && busy !== "sign-in")}
                loading={busy === "sign-in"}
              >
                {isRegister ? "注册并登录" : "登录"}
              </Button>
            )}
          </DialogFooter>
        </div>
      </form>
    </DialogContent>
  );
}
