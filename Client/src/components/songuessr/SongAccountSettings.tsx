import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { LogOut, QrCode, RefreshCw, ShieldCheck, UserRound } from "lucide-react";
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

/** 黑胶成长等级在官方徽章上的写法。 */
const LEVEL_NUMERALS = ["", "壹", "贰", "叁", "肆", "伍", "陆", "柒"];

/** 官方会员徽章：图片取自网易云 CDN 的原图（`public/assets/netease-vip`），读屏读档位与等级。 */
function vipBadge(account: SonGuessrMusicAccount): { src: string; label: string } | null {
  const level = Math.min(Math.max(account.vipLevel ?? 1, 1), 7);
  if (account.vipTier === "svip") return { src: `/assets/netease-vip/SVIP-${level}.png`, label: `SVIP · ${LEVEL_NUMERALS[level]}` };
  if (account.vipTier === "vip") return { src: `/assets/netease-vip/VIP-${level}.png`, label: `VIP · ${LEVEL_NUMERALS[level]}` };
  if (account.vipTier === "musicPackage") return { src: "/assets/netease-vip/musicPackage.png", label: "音乐包" };
  return null;
}

const expireFormat = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric", timeZone: "Asia/Shanghai" });

/** 会员一行的文字：徽章之后的到期日；旧版本存下的账号没有档位时退回文字。 */
function vipText(account: SonGuessrMusicAccount): { label: string; expire: string; description?: string } {
  const expire = account.vipStatus === "vip" && account.vipExpireTime ? `${expireFormat.format(new Date(account.vipExpireTime))} 到期` : "";
  if (account.vipStatus === "vip") return { label: vipBadge(account)?.label ?? "网易云会员", expire };
  if (account.vipStatus === "nonVip") return { label: "非会员", expire, description: "非会员账号也能出题，会员专享歌曲会自动匹配可用音源。" };
  return { label: "会员状态未知", expire, description: "暂时无法读取会员状态，选歌时以网易云实际权限为准。" };
}

function AccountAvatar({ account, className }: { account: SonGuessrMusicAccount; className: string }) {
  return account.avatarUrl ? (
    <img src={account.avatarUrl} alt="" className={cn(className, "shrink-0 rounded-full bg-muted object-cover")} />
  ) : (
    <span className={cn(className, "flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground")}>
      <UserRound className="size-3/5" aria-hidden="true" />
    </span>
  );
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
  account?: SonGuessrMusicAccount;
}

export function SongAccountSettings({ snapshot }: { snapshot: SonGuessrRoomSnapshot }) {
  return <RoomAccountSettings key={snapshot.roomId} snapshot={snapshot} />;
}

function RoomAccountSettings({ snapshot }: { snapshot: SonGuessrRoomSnapshot }) {
  const sendCommand = useSonGuessrStore((state) => state.sendCommand);
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const [open, setOpen] = useState(false);
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

  const showQr = !storedSession;

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

  /** 退出登录：清掉房间里的凭据与本机存储，面板回到扫码，展开着就直接给出新二维码。 */
  const logout = async () => {
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
    setQr(null);
    setNotice("已退出网易云账号", "success");
    if (open) void createQr();
  };

  // 账号信息只在加载到房间后显示：本机存着凭据、还在装载时只说「正在连接」，不让人以为已经能用。
  const account = snapshot.musicAccountReady ? storedSession?.account : undefined;
  const connecting = Boolean(storedSession) && !snapshot.musicAccountReady;
  const vip = account ? vipText(account) : null;
  const badge = account ? vipBadge(account) : null;

  const toggle = (next: boolean) => {
    if (!next) { cancelLogin(); setOpen(false); return; }
    setOpen(true);
    if (showQr && !qr && !busy) void createQr();
  };

  return (
    <SettingsAccordion
      icon={UserRound}
      title="网易云账号"
      open={open}
      onOpenChange={toggle}
      media={account ? <AccountAvatar account={account} className="size-5" /> : undefined}
      summary={account && vip ? [account.nickname, [vip.label, vip.expire].filter(Boolean).join(" ")]
        : connecting ? ["正在连接网易云账号…"] : ["登录后全房共用此账号取歌"]}
    >
      {/* 账号与二维码两态各自按高度收放，一个收起时另一个撑开，切换时面板高度连续变化。 */}
      <CollapsibleRegion open={!showQr}>
        <div className="space-y-4">
          {account && vip ? (
            <div className="space-y-1.5">
              {/* 头像、昵称与会员徽章同一行；空间不够时徽章与到期日整体换到昵称下方。 */}
              <div className="flex items-center gap-3">
                <AccountAvatar account={account} className="size-11" />
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 max-w-full truncate text-sm font-medium" title={account.nickname}>{account.nickname}</span>
                  <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {badge ? <img src={badge.src} alt={badge.label} className="h-4 w-auto" /> : <span className="font-medium text-foreground">{vip.label}</span>}
                    {vip.expire ? <span className="tabular-nums">{vip.expire}</span> : null}
                  </span>
                </div>
              </div>
              {vip.description ? <p className="text-xs leading-relaxed text-muted-foreground">{vip.description}</p> : null}
            </div>
          ) : (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />正在连接网易云账号…
            </p>
          )}
          <Button variant="outline" size="sm" className="w-full gap-1.5 text-destructive hover:text-destructive" disabled={busy} onClick={() => void logout()}>
            <LogOut className="h-3.5 w-3.5" />退出登录
          </Button>
        </div>
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
        </div>
      </CollapsibleRegion>

      <p className="mt-4 flex gap-2 border-t pt-4 text-2xs leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
        <span>
          服务器不会保存账号信息。账号信息仅保存在登录者浏览器，在房间中临时加载到服务器内存供全房获取音乐信息；房间关闭或退出登录时销毁。
        </span>
      </p>
    </SettingsAccordion>
  );
}
