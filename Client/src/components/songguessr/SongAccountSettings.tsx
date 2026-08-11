import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  ChevronDown,
  LoaderCircle,
  LogOut,
  Mail,
  QrCode,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  clearStoredSongMusicSession,
  getStoredSongMusicSession,
  saveSongMusicSession,
  SONG_MUSIC_SESSION_CHANGED,
  type StoredSongMusicSession,
} from "@/lib/songguessrMusicSession";
import { collapsible, pressable, spring } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useSongGuessrStore } from "@/stores/useSongGuessrStore";
import type { SongGuessrMusicAccount, SongGuessrRoomSnapshot } from "@/types";

type LoginMode = "qr" | "phone" | "email";
type PhoneMethod = "captcha" | "password";

interface LoginResponse extends Record<string, unknown> {
  cookie: string;
  account: SongGuessrMusicAccount;
}

interface QrCreateResponse extends Record<string, unknown> {
  key: string;
  qrUrl: string;
  qrImage: string;
}

interface QrCheckResponse extends Record<string, unknown> {
  status: "waiting" | "scanned" | "expired" | "authorized";
  message: string;
  cookie?: string;
  account?: SongGuessrMusicAccount;
}

interface LoginError {
  code?: string;
  message?: string;
  details?: {
    redirectUrl?: string;
    retryAfterMs?: number;
  };
}

const readRiskVerificationUrl = (error: unknown): string | undefined => {
  const candidate = (error as LoginError | null)?.details?.redirectUrl;
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".163.com")) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
};

export function SongAccountSettings({ snapshot }: { snapshot: SongGuessrRoomSnapshot }) {
  const sendCommand = useSongGuessrStore((state) => state.sendCommand);
  const setNotice = useSongGuessrStore((state) => state.setNotice);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<LoginMode>("qr");
  const [remember, setRemember] = useState(() => getStoredSongMusicSession()?.persistent ?? true);
  const [storedSession, setStoredSession] = useState<StoredSongMusicSession | null>(
    getStoredSongMusicSession,
  );
  const [busy, setBusy] = useState(false);
  const [riskVerificationUrl, setRiskVerificationUrl] = useState<string | null>(null);
  const [qr, setQr] = useState<QrCreateResponse | null>(null);
  const [qrStatus, setQrStatus] = useState("点击下方按钮生成二维码");
  const qrCheckingRef = useRef(false);
  const [phone, setPhone] = useState("");
  const [countryCode, setCountryCode] = useState("86");
  const [phoneMethod, setPhoneMethod] = useState<PhoneMethod>("captcha");
  const [phoneSecret, setPhoneSecret] = useState("");
  const [captchaSending, setCaptchaSending] = useState(false);
  const [captchaCooldownUntil, setCaptchaCooldownUntil] = useState<number | null>(null);
  const [captchaClock, setCaptchaClock] = useState(() => Date.now());
  const [email, setEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");

  useEffect(() => {
    const sync = () => setStoredSession(getStoredSongMusicSession());
    window.addEventListener(SONG_MUSIC_SESSION_CHANGED, sync);
    return () => window.removeEventListener(SONG_MUSIC_SESSION_CHANGED, sync);
  }, []);

  useEffect(() => {
    if (captchaCooldownUntil === null) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setCaptchaClock(now);
      if (now >= captchaCooldownUntil) setCaptchaCooldownUntil(null);
    }, 250);
    return () => window.clearInterval(timer);
  }, [captchaCooldownUntil]);

  const completeLogin = useCallback((session: LoginResponse) => {
    saveSongMusicSession(session, remember);
    setStoredSession({ ...session, persistent: remember });
    setPhoneSecret("");
    setEmailPassword("");
    setEditing(false);
    setQr(null);
    setRiskVerificationUrl(null);
    setQrStatus("登录成功");
    setNotice("网易云账号已加载到当前房间", "success");
  }, [remember, setNotice]);

  const checkQr = useCallback(async () => {
    if (!qr || qrCheckingRef.current) return;
    qrCheckingRef.current = true;
    try {
      const result = await sendCommand<QrCheckResponse>("song.auth.qr.check", { key: qr.key });
      setQrStatus(result.message || "等待扫码");
      if (result.status === "expired") {
        setQr(null);
        setQrStatus("二维码已过期，请重新生成");
      } else if (result.status === "authorized" && result.cookie && result.account) {
        completeLogin({ cookie: result.cookie, account: result.account });
      }
    } catch (error) {
      setRiskVerificationUrl(readRiskVerificationUrl(error) ?? null);
      setQrStatus((error as { message?: string }).message ?? "扫码状态检查失败");
    } finally {
      qrCheckingRef.current = false;
    }
  }, [completeLogin, qr, sendCommand]);

  useEffect(() => {
    if (!qr || mode !== "qr") return;
    const timer = window.setInterval(() => void checkQr(), 2_000);
    return () => window.clearInterval(timer);
  }, [checkQr, mode, qr]);

  const createQr = async () => {
    setBusy(true);
    try {
      const result = await sendCommand<QrCreateResponse>("song.auth.qr.create");
      setQr(result);
      setQrStatus("请使用网易云音乐 App 扫码");
    } catch (error) {
      setRiskVerificationUrl(readRiskVerificationUrl(error) ?? null);
      setNotice((error as { message?: string }).message ?? "二维码生成失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const sendCaptcha = async () => {
    if (!phone.trim()) {
      setNotice("请输入手机号", "error");
      return;
    }
    if (captchaCooldownUntil !== null && captchaCooldownUntil > Date.now()) return;
    setCaptchaSending(true);
    try {
      await sendCommand("song.auth.phone.sendCaptcha", {
        phone: phone.trim(),
        countryCode: countryCode.trim() || "86",
      });
      setCaptchaCooldownUntil(Date.now() + 60_000);
      setNotice("验证码已发送", "success");
    } catch (error) {
      setRiskVerificationUrl(readRiskVerificationUrl(error) ?? null);
      const details = (error as { details?: { retryAfterMs?: number } }).details;
      if (details?.retryAfterMs && details.retryAfterMs > 0) {
        setCaptchaCooldownUntil(Date.now() + details.retryAfterMs);
      }
      setNotice((error as { message?: string }).message ?? "验证码发送失败", "error");
    } finally {
      setCaptchaSending(false);
    }
  };

  const captchaSecondsLeft = captchaCooldownUntil === null
    ? 0
    : Math.max(0, Math.ceil((captchaCooldownUntil - captchaClock) / 1_000));

  const loginPhone = async () => {
    if (!phone.trim() || !phoneSecret) {
      setNotice(`请输入手机号和${phoneMethod === "captcha" ? "验证码" : "密码"}`, "error");
      return;
    }
    setBusy(true);
    try {
      const result = await sendCommand<LoginResponse>("song.auth.phone.login", {
        phone: phone.trim(),
        countryCode: countryCode.trim() || "86",
        ...(phoneMethod === "captcha"
          ? { captcha: phoneSecret.trim() }
          : { password: phoneSecret }),
      });
      completeLogin(result);
    } catch (error) {
      setRiskVerificationUrl(readRiskVerificationUrl(error) ?? null);
      setNotice((error as { message?: string }).message ?? "手机登录失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const loginEmail = async () => {
    if (!email.trim() || !emailPassword) {
      setNotice("请输入邮箱和密码", "error");
      return;
    }
    setBusy(true);
    try {
      const result = await sendCommand<LoginResponse>("song.auth.email.login", {
        email: email.trim(),
        password: emailPassword,
      });
      completeLogin(result);
    } catch (error) {
      setRiskVerificationUrl(readRiskVerificationUrl(error) ?? null);
      setNotice((error as { message?: string }).message ?? "邮箱登录失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const removeLogin = async () => {
    try {
      await sendCommand("song.auth.clear");
    } catch {
      // 本地状态仍需立即清除；断线时服务端也会销毁房间 Cookie。
    }
    clearStoredSongMusicSession();
    setStoredSession(null);
    setEditing(true);
    setNotice("本机登录状态已移除", "success");
  };

  const showLoginForm = editing || !storedSession;

  return (
    <div className="overflow-hidden rounded-md border">
      <motion.button
        type="button"
        {...pressable}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium transition-colors hover:bg-accent/40"
      >
        <UserRound className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1 text-left">网易云账号</span>
        <span className={cn(
          "rounded-md px-2 py-0.5 text-[11px] font-medium",
          snapshot.musicAccountReady
            ? "bg-emerald-500/10 text-emerald-700"
            : "bg-muted text-muted-foreground",
        )}>
          {snapshot.musicAccountReady ? "房间已加载" : storedSession ? "本机已登录" : "未登录"}
        </span>
        <motion.span
          className="inline-flex text-muted-foreground"
          animate={{ rotate: open ? 180 : 0 }}
          transition={spring.snap}
        >
          <ChevronDown className="h-4 w-4" />
        </motion.span>
      </motion.button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            variants={collapsible}
            initial="initial"
            animate="animate"
            exit="exit"
            className="overflow-hidden"
          >
            <div className="space-y-4 border-t px-4 py-4">
              {storedSession && !showLoginForm ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 rounded-md bg-muted p-3">
                    {storedSession.account.avatarUrl ? (
                      <img
                        src={storedSession.account.avatarUrl}
                        alt=""
                        className="h-10 w-10 rounded-full object-cover"
                      />
                    ) : (
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-background">
                        <UserRound className="h-5 w-5 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="break-words text-sm font-medium">
                        {storedSession.account.nickname}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <Check className="h-3 w-3 text-emerald-600" />
                        {snapshot.musicAccountReady
                          ? "全房音乐请求正在使用此账号"
                          : "等待加载到当前房间"}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => setEditing(true)}>
                      更换账号
                    </Button>
                    <Button variant="ghost" size="sm" className="gap-1.5 text-destructive" onClick={() => void removeLogin()}>
                      <LogOut className="h-3.5 w-3.5" />移除登录
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1">
                    <ModeButton active={mode === "qr"} icon={<QrCode className="h-3.5 w-3.5" />} label="扫码" onClick={() => setMode("qr")} />
                    <ModeButton active={mode === "phone"} icon={<Smartphone className="h-3.5 w-3.5" />} label="手机" onClick={() => setMode("phone")} />
                    <ModeButton active={mode === "email"} icon={<Mail className="h-3.5 w-3.5" />} label="邮箱" onClick={() => setMode("email")} />
                  </div>

                  {mode === "qr" ? (
                    <div className="flex flex-col items-center gap-3 text-center">
                      {qr ? (
                        <>
                          <img src={qr.qrImage} alt="网易云登录二维码" className="h-44 w-44 rounded-md border bg-white p-2" />
                          <p className="text-xs text-muted-foreground">{qrStatus}</p>
                          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void createQr()} disabled={busy}>
                            <RefreshCw className="h-3.5 w-3.5" />刷新二维码
                          </Button>
                        </>
                      ) : (
                        <Button className="gap-2" onClick={() => void createQr()} disabled={busy}>
                          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
                          生成登录二维码
                        </Button>
                      )}
                    </div>
                  ) : null}

                  {mode === "phone" ? (
                    <div className="space-y-3">
                      <div className="flex gap-2">
                        <Input value={countryCode} onChange={(event) => setCountryCode(event.target.value)} className="w-20" aria-label="国家区号" placeholder="86" />
                        <Input value={phone} onChange={(event) => setPhone(event.target.value)} className="flex-1" placeholder="手机号" inputMode="tel" />
                      </div>
                      <div className="flex gap-1">
                        <Button variant={phoneMethod === "captcha" ? "secondary" : "ghost"} size="sm" className="flex-1" onClick={() => { setPhoneMethod("captcha"); setPhoneSecret(""); }}>
                          验证码登录
                        </Button>
                        <Button variant={phoneMethod === "password" ? "secondary" : "ghost"} size="sm" className="flex-1" onClick={() => { setPhoneMethod("password"); setPhoneSecret(""); }}>
                          密码登录
                        </Button>
                      </div>
                      <div className="flex gap-2">
                        <Input
                          type={phoneMethod === "password" ? "password" : "text"}
                          value={phoneSecret}
                          onChange={(event) => setPhoneSecret(event.target.value)}
                          placeholder={phoneMethod === "captcha" ? "短信验证码" : "密码"}
                        />
                        {phoneMethod === "captcha" ? (
                          <Button
                            variant="outline"
                            className="shrink-0 gap-1.5"
                            disabled={captchaSending || captchaSecondsLeft > 0}
                            onClick={() => void sendCaptcha()}
                          >
                            {captchaSending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                            {captchaSecondsLeft > 0 ? `${captchaSecondsLeft} 秒后重试` : "发送验证码"}
                          </Button>
                        ) : null}
                      </div>
                      <Button className="w-full" disabled={busy} onClick={() => void loginPhone()}>
                        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "登录"}
                      </Button>
                    </div>
                  ) : null}

                  {mode === "email" ? (
                    <div className="space-y-3">
                      <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="网易云账号邮箱" type="email" />
                      <Input value={emailPassword} onChange={(event) => setEmailPassword(event.target.value)} placeholder="密码" type="password" />
                      <Button className="w-full" disabled={busy} onClick={() => void loginEmail()}>
                        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "登录"}
                      </Button>
                    </div>
                  ) : null}

                  <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2.5">
                    <div>
                      <Label className="text-xs">保存登录状态</Label>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        关闭后仅保留到当前浏览器标签会话结束
                      </p>
                    </div>
                    <Switch checked={remember} onCheckedChange={setRemember} />
                  </div>
                  {riskVerificationUrl ? (
                    <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
                      <p>
                        网易云要求完成安全验证。请打开验证页面，完成验证后再尝试登录；也可以直接使用扫码或短信验证码登录。
                      </p>
                      <a
                        href={riskVerificationUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex font-medium underline underline-offset-2"
                      >
                        打开网易云安全验证
                      </a>
                    </div>
                  ) : null}
                  {storedSession ? (
                    <Button variant="ghost" size="sm" className="w-full" onClick={() => setEditing(false)}>
                      返回当前账号
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="flex gap-2 border-t bg-muted/30 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
        <p>
          隐私说明：服务器不会保存账号、手机号、邮箱或密码。登录 Cookie 只保存在登录者的浏览器，
          在房间中仅临时加载到服务器内存供全房获取音乐信息；房主离开、掉线或转让房主时立即销毁。
        </p>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-8 items-center justify-center gap-1.5 rounded-sm text-xs font-medium transition-colors",
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}{label}
    </button>
  );
}
