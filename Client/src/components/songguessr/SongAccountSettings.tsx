import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  ChevronDown,
  LoaderCircle,
  LogOut,
  QrCode,
  RefreshCw,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Label } from "@/components/ui/Label";
import { Switch } from "@/components/ui/Switch";
import {
  clearStoredSongMusicSession,
  getStoredSongMusicSession,
  saveSongMusicSession,
  SONG_MUSIC_SESSION_CHANGED,
  type StoredSongMusicSession,
} from "@/lib/SongguessrMusicSession";
import { collapsible, pressable, spring } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { useSongGuessrStore } from "@/stores/UseSongGuessrStore";
import type { SongGuessrMusicAccount, SongGuessrRoomSnapshot } from "@/types";

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

export function SongAccountSettings({ snapshot }: { snapshot: SongGuessrRoomSnapshot }) {
  const sendCommand = useSongGuessrStore((state) => state.sendCommand);
  const setNotice = useSongGuessrStore((state) => state.setNotice);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [remember, setRemember] = useState(() => getStoredSongMusicSession()?.persistent ?? true);
  const [storedSession, setStoredSession] = useState<StoredSongMusicSession | null>(
    getStoredSongMusicSession,
  );
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<QrCreateResponse | null>(null);
  const [qrStatus, setQrStatus] = useState("正在准备登录二维码…");
  const qrCheckingRef = useRef(false);
  const qrAutoCreatedRef = useRef(false);

  useEffect(() => {
    const sync = () => setStoredSession(getStoredSongMusicSession());
    window.addEventListener(SONG_MUSIC_SESSION_CHANGED, sync);
    return () => window.removeEventListener(SONG_MUSIC_SESSION_CHANGED, sync);
  }, []);

  const completeLogin = useCallback((session: { cookie: string; account: SongGuessrMusicAccount }) => {
    saveSongMusicSession(session, remember);
    setStoredSession({ ...session, persistent: remember });
    setEditing(false);
    setQr(null);
    qrAutoCreatedRef.current = false;
    setQrStatus("登录成功");
    setNotice("网易云账号已加载到当前房间", "success");
  }, [remember, setNotice]);

  const createQr = useCallback(async () => {
    setBusy(true);
    try {
      const result = await sendCommand<QrCreateResponse>("song.auth.qr.create");
      setQr(result);
      setQrStatus("请使用网易云音乐 App 扫码");
    } catch (error) {
      setQrStatus((error as { message?: string }).message ?? "二维码生成失败，请稍后重试");
      setNotice((error as { message?: string }).message ?? "二维码生成失败", "error");
    } finally {
      setBusy(false);
    }
  }, [sendCommand, setNotice]);

  const showQr = !storedSession || editing;

  useEffect(() => {
    if (!open) {
      qrAutoCreatedRef.current = false;
      return;
    }
    if (showQr && !qr && !busy && !qrAutoCreatedRef.current) {
      qrAutoCreatedRef.current = true;
      void createQr();
    }
  }, [busy, createQr, open, qr, showQr]);

  const checkQr = useCallback(async () => {
    if (!qr || qrCheckingRef.current) return;
    qrCheckingRef.current = true;
    try {
      const result = await sendCommand<QrCheckResponse>("song.auth.qr.check", { key: qr.key });
      setQrStatus(result.message || "等待扫码");
      if (result.status === "expired") {
        setQr(null);
        setQrStatus("二维码已过期，请点击刷新");
      } else if (result.status === "authorized" && result.cookie && result.account) {
        completeLogin({ cookie: result.cookie, account: result.account });
      }
    } catch (error) {
      const appError = error as { code?: string; message?: string };
      if (appError.code === "MUSIC_LOGIN_RISK") {
        setQr(null);
        setQrStatus("网易云暂时拒绝了本次登录，请稍后重新扫码");
      } else {
        setQrStatus(appError.message ?? "二维码状态检查失败");
      }
    } finally {
      qrCheckingRef.current = false;
    }
  }, [completeLogin, qr, sendCommand]);

  useEffect(() => {
    if (!open || !showQr || !qr) return;
    const timer = window.setInterval(() => void checkQr(), 2_000);
    return () => window.clearInterval(timer);
  }, [checkQr, open, qr, showQr]);

  const refreshQr = () => {
    qrAutoCreatedRef.current = true;
    setQr(null);
    void createQr();
  };

  const removeLogin = async () => {
    try {
      await sendCommand("song.auth.clear");
    } catch {
      // 本地状态仍需立即清除；房主离开时服务端也会销毁房间 Cookie。
    }
    clearStoredSongMusicSession();
    setStoredSession(null);
    setEditing(false);
    setQr(null);
    qrAutoCreatedRef.current = false;
    setNotice("本机登录状态已移除", "success");
  };

  const vipStatus = storedSession?.account.vipStatus;
  const vipLabel = vipStatus === "vip"
    ? "网易云会员"
    : vipStatus === "nonVip"
      ? "非会员"
      : "会员状态未知";
  const vipExpireLabel = storedSession?.account.vipExpireTime
    ? `有效期至 ${new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        timeZone: "Asia/Shanghai",
      }).format(new Date(storedSession.account.vipExpireTime))}`
    : undefined;

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
          {snapshot.musicAccountReady ? "房间已连接" : storedSession ? "本机已登录" : "未登录"}
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
              {storedSession && !editing ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 rounded-md bg-muted p-3">
                    {storedSession.account.avatarUrl ? (
                      <img src={storedSession.account.avatarUrl} alt="" className="h-10 w-10 rounded-full object-cover" />
                    ) : (
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-background">
                        <UserRound className="h-5 w-5 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="break-words text-sm font-medium">{storedSession.account.nickname}</div>
                      <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <Check className="h-3 w-3 text-emerald-600" />
                        {snapshot.musicAccountReady ? "全房音乐请求正在使用此账号" : "等待加载到当前房间"}
                      </div>
                    </div>
                  </div>
                  <div className={cn(
                    "rounded-md border px-3 py-2 text-xs",
                    vipStatus === "vip"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : vipStatus === "nonVip"
                        ? "border-amber-200 bg-amber-50 text-amber-900"
                        : "border-muted bg-muted/50 text-muted-foreground",
                  )}>
                    <div className="font-medium">{vipLabel}{vipExpireLabel ? ` · ${vipExpireLabel}` : ""}</div>
                    {vipStatus === "nonVip" ? (
                      <p className="mt-1">当前账号不是会员，无法选择会员专享歌曲。</p>
                    ) : vipStatus === "unknown" || !vipStatus ? (
                      <p className="mt-1">暂时无法读取会员状态，选歌时以网易云实际权限为准。</p>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => { setEditing(true); setQr(null); }}>
                      更换账号
                    </Button>
                    <Button variant="ghost" size="sm" className="gap-1.5 text-destructive" onClick={() => void removeLogin()}>
                      <LogOut className="h-3.5 w-3.5" />移除登录
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-col items-center gap-3 text-center">
                    {qr ? (
                      <img src={qr.qrImage} alt="网易云登录二维码" className="h-44 w-44 rounded-md border bg-white p-2" />
                    ) : (
                      <div className="flex h-44 w-44 items-center justify-center rounded-md border bg-muted">
                        {busy ? <LoaderCircle className="h-6 w-6 animate-spin text-muted-foreground" /> : <QrCode className="h-8 w-8 text-muted-foreground" />}
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">{qrStatus}</p>
                    <Button variant="outline" size="sm" className="gap-1.5" onClick={refreshQr} disabled={busy}>
                      <RefreshCw className="h-3.5 w-3.5" />刷新二维码
                    </Button>
                  </div>
                  <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2.5">
                    <div>
                      <Label className="text-xs">保存登录状态</Label>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">仅保存在当前浏览器，服务器不持久化账号信息</p>
                    </div>
                    <Switch checked={remember} onCheckedChange={setRemember} />
                  </div>
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
          隐私说明：服务器不会保存账号信息。账号信息仅保存在登录者浏览器，
          在房间中临时加载到服务器内存供全房获取音乐信息；房间关闭或主动移除登录时销毁。
        </p>
      </div>
    </div>
  );
}
