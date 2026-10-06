import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeftRight, LogOut, QrCode, RefreshCw, ShieldCheck, UserRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CollapsibleRegion } from "@/components/ui/Collapsible";
import { Spinner } from "@/components/ui/Spinner";
import { SettingSwitchRow } from "@/components/common/room/SettingFields";
import { SettingsAccordion } from "@/components/common/room/SettingsAccordion";
import {
  clearStoredSongMusicSession,
  getStoredSongMusicSession,
  saveSongMusicSession,
  SONGUESSR_MUSIC_SESSION_CHANGED,
  type StoredSongMusicSession,
} from "@/lib/SonGuessrMusicSession";
import { readoutSwap } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import type { SonGuessrMusicAccount, SonGuessrRoomSnapshot } from "@/types";

/** 标题行右侧的连接状态：圆点颜色与头像角上的状态点同一份。 */
const CONNECTIONS = {
  room: { label: "房间已连接", tone: "bg-success/10 text-success", dot: "bg-success" },
  local: { label: "本机已登录", tone: "bg-warning/10 text-warning", dot: "bg-warning" },
  none: { label: "未登录", tone: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/50" },
} as const;

const VIP_TONES = {
  vip: { label: "网易云会员", tone: "bg-success/10 text-success", description: "" },
  nonVip: { label: "非会员", tone: "bg-warning/10 text-warning", description: "非会员账号也能出题，会员专享歌曲会自动匹配可用音源。" },
  unknown: { label: "会员状态未知", tone: "bg-muted text-muted-foreground", description: "暂时无法读取会员状态，选歌时以网易云实际权限为准。" },
} as const;

interface QrCreateResponse extends Record<string, unknown> {
  key: string;
  qrUrl: string;
  qrImage: string;
}

interface QrCheckResponse extends Record<string, unknown> {
  status: "waiting" | "scanned" | "expired" | "authorized";
  message: string;
  cookie?: string;
  account?: SonGuessrMusicAccount;
}

export function SongAccountSettings({ snapshot }: { snapshot: SonGuessrRoomSnapshot }) {
  return <RoomAccountSettings key={snapshot.roomId} snapshot={snapshot} />;
}

function RoomAccountSettings({ snapshot }: { snapshot: SonGuessrRoomSnapshot }) {
  const sendCommand = useSonGuessrStore((state) => state.sendCommand);
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [remember, setRemember] = useState(() => getStoredSongMusicSession()?.persistent ?? true);
  const [storedSession, setStoredSession] = useState<StoredSongMusicSession | null>(
    getStoredSongMusicSession,
  );
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<QrCreateResponse | null>(null);
  const [qrStatus, setQrStatus] = useState("正在准备登录二维码…");
  const qrCheckingRef = useRef<number | null>(null);
  const loginGenerationRef = useRef(0);
  const rememberRef = useRef(remember);

  const cancelLogin = useCallback(() => {
    loginGenerationRef.current += 1;
    qrCheckingRef.current = null;
    setBusy(false);
    setQr(null);
  }, []);

  useEffect(() => () => {
    loginGenerationRef.current += 1;
  }, []);

  useEffect(() => {
    const sync = () => setStoredSession(getStoredSongMusicSession());
    window.addEventListener(SONGUESSR_MUSIC_SESSION_CHANGED, sync);
    return () => window.removeEventListener(SONGUESSR_MUSIC_SESSION_CHANGED, sync);
  }, []);

  const completeLogin = useCallback((session: { cookie: string; account: SonGuessrMusicAccount }) => {
    loginGenerationRef.current += 1;
    saveSongMusicSession(session, rememberRef.current);
    setStoredSession({ ...session, persistent: rememberRef.current });
    setEditing(false);
    setQr(null);
    setQrStatus("登录成功");
    setNotice("网易云账号已加载到当前房间", "success");
  }, [setNotice]);

  const createQr = useCallback(async () => {
    const generation = ++loginGenerationRef.current;
    setBusy(true);
    try {
      const result = await sendCommand<QrCreateResponse>("song.auth.qr.create");
      if (generation !== loginGenerationRef.current) return;
      setQr(result);
      setQrStatus("请使用网易云音乐 App 扫码");
    } catch (error) {
      if (generation !== loginGenerationRef.current) return;
      setQrStatus((error as { message?: string }).message ?? "二维码生成失败，请稍后重试");
      setNotice((error as { message?: string }).message ?? "二维码生成失败", "error");
    } finally {
      if (generation === loginGenerationRef.current) setBusy(false);
    }
  }, [sendCommand, setNotice]);

  const showQr = !storedSession || editing;

  const checkQr = useCallback(async () => {
    if (!qr || qrCheckingRef.current === loginGenerationRef.current) return;
    const generation = loginGenerationRef.current;
    const qrKey = qr.key;
    qrCheckingRef.current = generation;
    try {
      const result = await sendCommand<QrCheckResponse>("song.auth.qr.check", { key: qrKey });
      if (generation !== loginGenerationRef.current) return;
      setQrStatus(result.message || "等待扫码");
      if (result.status === "expired") {
        setQr(null);
        setQrStatus("二维码已过期，请点击刷新");
      } else if (result.status === "authorized" && result.cookie && result.account) {
        completeLogin({ cookie: result.cookie, account: result.account });
      }
    } catch (error) {
      if (generation !== loginGenerationRef.current) return;
      const appError = error as { code?: string; message?: string };
      if (appError.code === "MUSIC_LOGIN_RISK") {
        setQr(null);
        setQrStatus("网易云暂时拒绝了本次登录，请稍后重新扫码");
      } else {
        setQrStatus(appError.message ?? "二维码状态检查失败");
      }
    } finally {
      if (qrCheckingRef.current === generation) qrCheckingRef.current = null;
    }
  }, [completeLogin, qr, sendCommand]);

  useEffect(() => {
    if (!open || !showQr || !qr) return;
    const timer = window.setInterval(() => void checkQr(), 2_000);
    return () => window.clearInterval(timer);
  }, [checkQr, open, qr, showQr]);

  const refreshQr = () => {
    cancelLogin();
    void createQr();
  };

  const removeLogin = async () => {
    cancelLogin();
    const generation = loginGenerationRef.current;
    setBusy(true);
    try {
      await sendCommand("song.auth.clear");
    } catch {
      // 本地状态仍需立即清除；房主离开时服务端也会销毁房间 Cookie。
    }
    if (generation !== loginGenerationRef.current) return;
    setBusy(false);
    clearStoredSongMusicSession();
    setStoredSession(null);
    setEditing(false);
    setQr(null);
    setNotice("本机登录状态已移除", "success");
  };

  const account = storedSession?.account;
  const vip = VIP_TONES[account?.vipStatus ?? "unknown"];
  const vipExpireLabel = account?.vipExpireTime
    ? `有效期至 ${new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        timeZone: "Asia/Shanghai",
      }).format(new Date(account.vipExpireTime))}`
    : undefined;
  const connection = snapshot.musicAccountReady ? CONNECTIONS.room : storedSession ? CONNECTIONS.local : CONNECTIONS.none;

  const toggle = (next: boolean) => {
    if (!next) { cancelLogin(); setOpen(false); return; }
    setOpen(true);
    if (showQr && !qr && !busy) void createQr();
  };
  // 更换账号直接给出新二维码，不让人再点一次刷新。
  const switchAccount = () => {
    cancelLogin();
    setEditing(true);
    void createQr();
  };
  const backToAccount = () => { cancelLogin(); setEditing(false); };

  return (
    <SettingsAccordion
      icon={UserRound}
      title="网易云账号"
      open={open}
      onOpenChange={toggle}
      summary={account ? [account.nickname, vip.label] : ["登录后全房共用此账号取歌"]}
      badge={(
        <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-medium", connection.tone)}>
          <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", connection.dot)} />
          {connection.label}
        </span>
      )}
    >
      {/* 账号与二维码两态各自按高度收放，一个收起时另一个撑开，切换时面板高度连续变化。 */}
      <CollapsibleRegion open={!showQr && Boolean(account)}>
        {account ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="relative shrink-0">
                {account.avatarUrl ? (
                  <img src={account.avatarUrl} alt="" className="h-11 w-11 rounded-full object-cover" />
                ) : (
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted">
                    <UserRound className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                  </span>
                )}
                <span aria-hidden="true" className={cn("absolute right-0 bottom-0 h-3 w-3 rounded-full ring-2 ring-panel", connection.dot)} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium" title={account.nickname}>{account.nickname}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {snapshot.musicAccountReady ? "全房音乐请求正在使用此账号" : "等待加载到当前房间"}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5">
              <div className={cn("min-w-0 flex-1", vip.description && "basis-40")}>
                <div className="text-sm">会员状态</div>
                {vip.description ? <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{vip.description}</p> : null}
              </div>
              <span className={cn("ml-auto inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium", vip.tone)}>
                {vip.label}{vipExpireLabel ? <span className="font-normal opacity-80"> · {vipExpireLabel}</span> : null}
              </span>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="flex-1 gap-1.5" disabled={busy} onClick={switchAccount}>
                <ArrowLeftRight className="h-3.5 w-3.5" />更换账号
              </Button>
              <Button variant="ghost" size="sm" className="gap-1.5 text-destructive hover:text-destructive" disabled={busy} onClick={() => void removeLogin()}>
                <LogOut className="h-3.5 w-3.5" />移除登录
              </Button>
            </div>
          </div>
        ) : null}
      </CollapsibleRegion>

      <CollapsibleRegion open={showQr}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="relative mx-auto h-36 w-36 shrink-0 overflow-hidden rounded-md border bg-white sm:mx-0">
              <AnimatePresence initial={false}>
                {qr ? (
                  <motion.img key={qr.key} src={qr.qrImage} alt="网易云登录二维码" variants={readoutSwap} initial="initial" animate="animate" exit="exit"
                    className="absolute inset-0 h-full w-full p-2" />
                ) : (
                  <motion.span key="placeholder" variants={readoutSwap} initial="initial" animate="animate" exit="exit"
                    className="absolute inset-0 flex items-center justify-center bg-muted">
                    {busy ? <Spinner className="size-6 text-muted-foreground" /> : <QrCode className="h-8 w-8 text-muted-foreground" aria-hidden="true" />}
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
            <div className="min-w-0 basis-44 flex-1 space-y-3">
              <ol className="space-y-1 text-xs leading-relaxed text-muted-foreground">
                <li>1. 打开网易云音乐 App</li>
                <li>2. 用「扫一扫」扫描左侧二维码</li>
                <li>3. 在手机上确认登录</li>
              </ol>
              <p aria-live="polite" className="text-sm">{qrStatus}</p>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={refreshQr} disabled={busy}>
                <RefreshCw className="h-3.5 w-3.5" />刷新二维码
              </Button>
            </div>
          </div>
          <SettingSwitchRow label="保存登录状态" description="仅保存在当前浏览器，服务器不持久化账号信息"
            checked={remember} onCheckedChange={(value) => { rememberRef.current = value; setRemember(value); }} />
          {account ? (
            <Button variant="ghost" size="sm" className="w-full" onClick={backToAccount}>返回当前账号</Button>
          ) : null}
        </div>
      </CollapsibleRegion>

      <p className="mt-4 flex gap-2 border-t pt-4 text-2xs leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
        <span>
          服务器不会保存账号信息。账号信息仅保存在登录者浏览器，在房间中临时加载到服务器内存供全房获取音乐信息；房间关闭或主动移除登录时销毁。
        </span>
      </p>
    </SettingsAccordion>
  );
}
