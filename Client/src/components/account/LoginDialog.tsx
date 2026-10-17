import { useEffect, useState, type FormEvent } from "react";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { SettingTextField } from "@/components/common/room/SettingFields";
import { api, apiErrorMessage } from "@/lib/Api";
import type { OriginPoint } from "@/lib/Motion";
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
 * 输入框上方的头像格：QQ 号合法即按该号取 qlogo（此时 QQ 号就是用户自己刚输入的，见 Agents/Account.md §4），
 * 未填或取不到时是同一尺寸的占位，因此填号与切步都不改变弹窗高度。
 */
function LoginAvatar({ qq, failed, onFailed }: { qq: string; failed: boolean; onFailed: () => void }) {
  if (!QQ_NUMBER_PATTERN.test(qq) || failed) {
    return (
      <span aria-hidden="true" className="flex h-16 w-16 items-center justify-center rounded-md bg-muted/40 text-muted-foreground">
        <UserRound className="h-6 w-6" />
      </span>
    );
  }
  return (
    <img
      key={qq}
      src={qlogoUrlOf(qq)}
      alt={`QQ ${qq} 的头像`}
      referrerPolicy="no-referrer"
      onError={onFailed}
      className="h-16 w-16 rounded-md border border-border object-cover"
    />
  );
}

/**
 * 登录 / 注册弹窗（首次登录即注册，见 Agents/Account.md §1）。
 *
 * 两步共用上方那一格头像：第一步填 QQ 号，号一合法头像即换成该号的 qlogo，确认后向 `QQ号@qq.com` 发验证码；
 * 第二步填验证码，收信地址与有效期写在字段说明里。新号在头像下展示服务端查到的 QQ 昵称——账号昵称强制使用它
 * 且不可修改，昵称查询不可用时发码直接被拒（见 Agents/Account.md §4）。
 */
export function LoginDialog({ open, onOpenChange, origin }: { open: boolean; onOpenChange: (open: boolean) => void; origin?: OriginPoint | null }) {
  // QQ 号留在外层：关掉再打开仍保留上次输入；其余状态随弹窗内容每次打开重新开始。
  const [qq, setQq] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange} origin={origin}>
      <LoginDialogBody qq={qq} setQq={setQq} onDone={() => onOpenChange(false)} />
    </Dialog>
  );
}

function LoginDialogBody({ qq, setQq, onDone }: { qq: string; setQq: (value: string) => void; onDone: () => void }) {
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
  /** 新号注册后将使用的账号昵称；老号不查询昵称，头像下也就不展示。 */
  const registerName = isRegister ? step.qqName : null;
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
      setError(cause instanceof Error && /[一-鿿]/.test(cause.message) ? cause.message : "登录失败，请稍后重试");
    } finally {
      setBusy(null);
    }
  };

  return (
      <DialogContent className="max-w-sm">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{isRegister ? "注册账号" : "登录"}</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col items-center gap-2">
            <LoginAvatar qq={qq} failed={avatarFailed} onFailed={() => setAvatarFailed(true)} />
            {registerName ? (
              <div className="text-sm font-medium">
                <span className="sr-only">账号昵称</span>
                {registerName}
              </div>
            ) : null}
          </div>

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
              action={(
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
              )}
            />
          )}

          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            {step.kind === "code" ? (
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => { setStep({ kind: "qq" }); setError(null); }}>
                <ArrowLeft />
                换个 QQ 号
              </Button>
            ) : null}
            {step.kind === "qq" ? (
              <Button type="submit" disabled={!validQq || busy !== null} loading={busy === "send"}>发送验证码</Button>
            ) : (
              <Button type="submit" disabled={!canSignIn || (busy !== null && busy !== "sign-in")} loading={busy === "sign-in"}>
                {isRegister ? "注册并登录" : "登录"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
  );
}
