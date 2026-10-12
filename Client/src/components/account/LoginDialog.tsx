import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft } from "lucide-react";
import {
  ACCOUNT_NAME_MAX_LENGTH,
  LOGIN_CODE_LENGTH,
  LOGIN_CODE_PATTERN,
  LOGIN_CODE_TTL_SECONDS,
  normalizeAccountName,
  qlogoUrlOf,
  qqEmailOf,
  QQ_NUMBER_PATTERN,
} from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { SettingTextField, SettingsFields } from "@/components/common/room/SettingFields";
import { api, apiErrorMessage } from "@/lib/Api";
import type { OriginPoint } from "@/lib/Motion";
import { useAccountStore } from "@/stores/UseAccountStore";

type Step = { kind: "qq" } | { kind: "code"; registered: boolean };

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
 * 登录 / 注册弹窗（首次登录即注册，见 Agents/Account.md §1）。
 *
 * 第一步填 QQ 号并直接展示 qlogo 头像请用户确认「是不是你」——此时 QQ 号就是用户自己刚输入的；
 * 确认后向 `QQ号@qq.com` 发验证码。第二步填验证码，新账号同时填写账号昵称（与游戏昵称互不捆绑）。
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
  const [name, setName] = useState("");
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
      setStep({ kind: "code", registered: result.registered });
    } catch (cause) {
      setError(apiErrorMessage(cause, "验证码发送失败，请稍后重试"));
    } finally {
      setBusy(null);
    }
  };

  const needName = step.kind === "code" && !step.registered;
  const canSignIn = LOGIN_CODE_PATTERN.test(code) && (!needName || normalizeAccountName(name).length > 0);

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
      await signIn({ email: qqEmailOf(qq), otp: code, ...(needName ? { name: normalizeAccountName(name) } : {}) });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error && /[一-鿿]/.test(cause.message) ? cause.message : "登录失败，请稍后重试");
    } finally {
      setBusy(null);
    }
  };

  return (
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{step.kind === "code" && !step.registered ? "注册账号" : "登录"}</DialogTitle>
            <DialogDescription>
              {step.kind === "qq"
                ? "用 QQ 邮箱接收验证码，首次登录即注册。不登录也能照常游玩。"
                : `验证码已发送至 ${qqEmailOf(qq)}，${LOGIN_CODE_TTL_SECONDS / 60} 分钟内有效。`}
            </DialogDescription>
          </DialogHeader>

          {step.kind === "qq" ? (
            <SettingsFields>
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
              {validQq ? (
                <div className="flex items-center gap-4 rounded-md border bg-card p-3">
                  {avatarFailed ? (
                    <span aria-hidden="true" className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">无头像</span>
                  ) : (
                    <img
                      key={qq}
                      src={qlogoUrlOf(qq)}
                      alt={`QQ ${qq} 的头像`}
                      referrerPolicy="no-referrer"
                      draggable={false}
                      onError={() => setAvatarFailed(true)}
                      className="h-16 w-16 shrink-0 rounded-md border border-border object-cover"
                    />
                  )}
                  <div className="min-w-0 text-sm">
                    <div className="font-semibold">这是你的 QQ 吗？</div>
                    <div className="mt-1 text-xs text-muted-foreground">确认后验证码会发到 <span className="font-mono">{qqEmailOf(qq)}</span></div>
                  </div>
                </div>
              ) : null}
            </SettingsFields>
          ) : (
            <SettingsFields>
              <SettingTextField
                label="验证码"
                value={code}
                onChange={(value) => {
                  setCode(value.replace(/\D/g, "").slice(0, LOGIN_CODE_LENGTH));
                  setError(null);
                }}
                placeholder={`${LOGIN_CODE_LENGTH} 位数字`}
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
              {needName ? (
                <SettingTextField
                  label="账号昵称"
                  value={name}
                  onChange={setName}
                  placeholder="显示在资料卡上，与游戏内昵称无关"
                  maxLength={ACCOUNT_NAME_MAX_LENGTH}
                  inputClassName="h-10"
                />
              ) : null}
            </SettingsFields>
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
              <Button type="submit" disabled={!validQq || busy !== null} loading={busy === "send"}>是我，发送验证码</Button>
            ) : (
              <Button type="submit" disabled={!canSignIn || (busy !== null && busy !== "sign-in")} loading={busy === "sign-in"}>
                {needName ? "注册并登录" : "登录"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
  );
}
