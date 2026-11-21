import { useEffect, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, KeyRound, UserRound } from "lucide-react";
import {
  ACCOUNT_NAME_MAX_LENGTH,
  LOGIN_CODE_LENGTH,
  LOGIN_CODE_PATTERN,
  LOGIN_CODE_TTL_SECONDS,
  normalizeAccountName,
  qlogoUrlOf,
  qqEmailOf,
  QQ_NUMBER_PATTERN,
} from "@bakagame/shared/values";
import { Button } from "@/components/ui/Button";
import { FormAlert } from "./FormAlert";
import { Collapsible, CollapsibleRegion } from "@/components/ui/Collapsible";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/Dialog";
import { SettingTextField } from "@/components/common/room/settings/TextFields";
import { IDLE_SEARCH_MS } from "@/hooks/UseIdleSearch";
import { ACCOUNT_NAME_COOLDOWN_DAYS } from "@/lib/AccountName";
import { api, apiErrorMessage, AuthRequestError } from "@/lib/Api";
import { listItem, phaseSwap } from "@/lib/motion/Choreography";
import { readoutSwap } from "@/lib/motion/NamedMoves";
import { type OriginPoint } from "@/lib/motion/Origin";
import { passkeyErrorMessage, passkeySupported } from "@/lib/Passkey";
import { useAccountStore } from "@/stores/UseAccountStore";

/** 头像框 80px：取 100 的小图已足够清晰，640 的大图只会白白多下载几十倍字节。 */
const AVATAR_PREVIEW_SIZE = 100;

type Step = { kind: "qq" } | { kind: "code"; registered: boolean };

/** 建号钩子对昵称的拒绝（缺昵称、命中敏感词）：落在昵称字段下方，不当作整体登录失败。 */
const NAME_ERROR_CODES = new Set(["ACCOUNT_NAME_REQUIRED", "TEXT_SENSITIVE"]);

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

/** 值停住 `ms` 之后才跟上：连续变化的中间态不触发依赖它的副作用（取图、请求）。 */
function useIdleValue<T>(value: T, ms: number): T {
  const [idle, setIdle] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setIdle(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return idle;
}

/**
 * 身份区的圆头像：QQ 号合法且停输后才按该号取 qlogo（此时 QQ 号就是用户自己刚输入的，见 Server/docs/Account.md §4），
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
      src={qlogoUrlOf(qq, AVATAR_PREVIEW_SIZE)}
      alt={`QQ ${qq} 的头像`}
      referrerPolicy="no-referrer"
      onError={onFailed}
      className="h-20 w-20 rounded-full border border-border object-cover shadow-sm"
    />
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
      {/* 展开的说明收进凹块：与设置面板「连接信息」同一种折叠区内容外框，不是一片贴着按钮的裸字。 */}
      <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
        <p>
          登录只用于少数需要身份验证的功能：云同步设置、查看自己反馈的回复、房间内显示你的头像。
        </p>
        <p>不登录也能游玩并匿名提交反馈；匿名反馈无法查看结果与回复。</p>
        <p>用 QQ 号作登录凭据仅是为了方便身份关联：我们不索要你的 QQ 密码和其它隐私信息。</p>
        <p>通行密钥在登录后的「账号资料」里添加，之后在这台设备上登录不必再收验证码。</p>
      </div>
    </Collapsible>
  );
}

/**
 * 登录 / 注册弹窗（首次登录即注册，见 Server/docs/Account.md §1）。
 *
 * 整块弹窗分两区：上方通栏身份区常驻——标题、圆头像、昵称与 QQ 号，两步共用，切步时身份不消失；
 * 下方操作区按步切换字段（QQ 号 → 验证码），新内容自后方推入、旧内容向前退出（`phaseSwap`）。
 * 号一合法先落 QQ 号；新号在验证码一步多一个账号昵称字段（玩家自填，注册必填），
 * 边填边在身份区的昵称行回显，读作「这张脸叫这个名字」。老号不再回显昵称，那一行留空。
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange} origin={origin}>
      <LoginDialogBody qq={qq} setQq={setQq} onDone={() => onOpenChange(false)} />
    </Dialog>
  );
}

/**
 * 注册时自填的账号昵称：与服务端同一口径清洗，只敲了空格或不可见字符不算填了昵称，
 * 按钮不亮，免得白白作废验证码。头像下的身份行注册时回显清洗后的昵称，登录时留空；
 * 老号登录不带 `name`。
 */
function accountNameDraft(
  isRegister: boolean,
  raw: string
): { identity: string; ready: boolean; payload: { name?: string } } {
  if (!isRegister) return { identity: "", ready: true, payload: {} };
  const name = normalizeAccountName(raw);
  return { identity: name, ready: name !== "", payload: { name } };
}

/** 登录失败的去向：建号钩子对昵称的拒绝落在昵称字段，其余（验证码错误、网络）归整个表单。 */
function signInFailure(cause: unknown): { name: string | null; form: string | null } {
  const message =
    cause instanceof Error && /[一-鿿]/.test(cause.message)
      ? cause.message
      : "登录失败，请稍后重试";
  return cause instanceof AuthRequestError && NAME_ERROR_CODES.has(cause.code)
    ? { name: message, form: null }
    : { name: null, form: message };
}

/** 新号注册必填的账号昵称：发码后出现在验证码之上并先获得焦点；老号登录不出现。 */
function AccountNameField({
  visible,
  value,
  error,
  onChange,
}: {
  visible: boolean;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
}) {
  if (!visible) return null;
  return (
    <SettingTextField
      label="账号昵称"
      value={value}
      onChange={onChange}
      placeholder="给自己取个名字"
      description={`注册后可在账号资料里修改，每 ${ACCOUNT_NAME_COOLDOWN_DAYS} 天一次`}
      maxLength={ACCOUNT_NAME_MAX_LENGTH}
      error={error}
      autoFocus
      inputClassName="h-10"
    />
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
  const signInWithPasskey = useAccountStore((state) => state.signInWithPasskey);
  // 不支持 WebAuthn 的浏览器（老旧内核、非安全上下文）连系统弹窗都调不起来，入口整段不出现。
  const [supportsPasskey] = useState(passkeySupported);
  const [step, setStep] = useState<Step>({ kind: "qq" });
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"send" | "resend" | "sign-in" | "passkey" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const countdown = useCountdown();

  const validQq = QQ_NUMBER_PATTERN.test(qq);
  // 头像在号停输后才取；号被删到不合法时立刻回占位圆，不为等防抖留着上一张脸。
  const idleQq = useIdleValue(qq, IDLE_SEARCH_MS);

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

  const isRegister = step.kind === "code" && !step.registered;
  const title = isRegister ? "注册账号" : "登录";
  const draft = accountNameDraft(isRegister, name);
  const identityName = draft.identity;
  const canSignIn = LOGIN_CODE_PATTERN.test(code) && draft.ready;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // 按钮的转圈只拦得住点击，回车触发的隐式提交要在这里拦：验证码一次性，重复提交只会作废它。
    if (busy !== null) return;
    if (step.kind === "qq") {
      if (validQq) await sendCode("send");
      return;
    }
    if (!canSignIn) return;
    setBusy("sign-in");
    setError(null);
    setNameError(null);
    try {
      await signIn({ email: qqEmailOf(qq), otp: code, ...draft.payload });
      onDone();
    } catch (cause) {
      const failure = signInFailure(cause);
      setNameError(failure.name);
      setError(failure.form);
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
    <DialogContent data-agent-sensitive className="max-w-sm" bodyClassName="gap-0 p-0">
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
          <LoginAvatar
            qq={validQq ? idleQq : ""}
            failed={avatarFailed}
            onFailed={() => setAvatarFailed(true)}
          />
          <div className="flex w-full flex-col items-center gap-0.5">
            <span className="flex h-6 max-w-full items-center justify-center">
              {/* 昵称是边打边回显的：键固定，只在昵称出现时入场一次，不为每次按键重播。 */}
              {identityName ? (
                <motion.span
                  key="account-name"
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
                <>
                  <AccountNameField
                    visible={isRegister}
                    value={name}
                    error={nameError}
                    onChange={(value) => {
                      setName(value);
                      setNameError(null);
                    }}
                  />
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
                    autoFocus={!isRegister}
                    inputClassName="h-10 font-mono tracking-code placeholder:tracking-normal"
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
                </>
              )}
              <CollapsibleRegion open={Boolean(error)}>
                <FormAlert>{error}</FormAlert>
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
                {/* 读取中由按钮的转圈表示，钥匙图标让位，不并排两枚图标。 */}
                {busy === "passkey" ? null : <KeyRound />}
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
