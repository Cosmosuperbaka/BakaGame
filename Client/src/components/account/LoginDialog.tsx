import { useEffect, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, UserRound } from "lucide-react";
import {
  LOGIN_CODE_LENGTH,
  LOGIN_CODE_PATTERN,
  LOGIN_CODE_TTL_SECONDS,
  qlogoUrlOf,
  qqEmailOf,
  QQ_NUMBER_PATTERN,
} from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { CollapsibleRegion } from "@/components/ui/Collapsible";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/Dialog";
import { SettingTextField } from "@/components/common/room/SettingFields";
import { api, apiErrorMessage } from "@/lib/Api";
import { indicatorSlide, listItem, phaseSwap, readoutSwap, type OriginPoint } from "@/lib/Motion";
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
 * 登录 / 注册弹窗（首次登录即注册，见 Agents/Account.md §1）。
 *
 * 整块弹窗分两区：上方通栏身份区常驻——标题、圆头像、昵称与 QQ 号，两步共用，切步时身份不消失；
 * 下方操作区按步切换字段（QQ 号 → 验证码），新内容自后方推入、旧内容向前退出（`phaseSwap`）。
 * 昵称与 QQ 号各自按到达时机展开：号一合法先落 QQ 号，发码后昵称自它上方顶进来；
 * 两步的字段说明与页脚都预留同一高度，切步只换内容、不跳高度。
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange} origin={origin}>
      <LoginDialogBody qq={qq} setQq={setQq} onDone={() => onOpenChange(false)} />
    </Dialog>
  );
}

function LoginDialogBody({
  qq,
  setQq,
  onDone,
}: {
  qq: string;
  setQq: (value: string) => void;
  onDone: () => void;
}) {
  const signIn = useAccountStore((state) => state.signIn);
  const [step, setStep] = useState<Step>({ kind: "qq" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"send" | "resend" | "sign-in" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const countdown = useCountdown();

  const validQq = QQ_NUMBER_PATTERN.test(qq);

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
  /** 头像下的身份行：发码后服务端回传的昵称（新号为将注册的昵称，老号为库中最近同步的）。 */
  const identityName = step.kind === "code" ? step.qqName : null;
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

          <DialogFooter className="min-h-20 sm:min-h-9">
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
