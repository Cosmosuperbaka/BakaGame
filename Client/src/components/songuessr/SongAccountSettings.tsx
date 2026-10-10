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
  type SongMusicPlatform,
  type StoredSongMusicSession,
} from "@/lib/SonGuessrMusicSession";
import { readoutSwap } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import type { SonGuessrMusicAccount, SonGuessrRoomSnapshot } from "@/types";

/** 黑胶与绿钻成长等级在官方徽章上的写法。 */
const LEVEL_NUMERALS = ["", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌"];

/**
 * 网易云音乐图标：官方圆标加音符的 24×24 单色路径，取自 Simple Icons 的 `neteasecloudmusic` 条目（数据 CC0）。
 */
function NeteaseCloudMusicIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M13.046 9.388a3.919 3.919 0 0 0-.66.19c-.809.312-1.447.991-1.666 1.775a2.269 2.269 0 0 0-.074.81c.048.546.333 1.05.764 1.35a1.483 1.483 0 0 0 2.01-.286c.406-.531.355-1.183.24-1.636-.098-.387-.22-.816-.345-1.249a64.76 64.76 0 0 1-.269-.954zm-.82 10.07c-3.984 0-7.224-3.24-7.224-7.223 0-.98.226-3.02 1.884-4.822A7.188 7.188 0 0 1 9.502 5.6a.792.792 0 1 1 .587 1.472 5.619 5.619 0 0 0-2.795 2.462 5.538 5.538 0 0 0-.707 2.7 5.645 5.645 0 0 0 5.638 5.638c1.844 0 3.627-.953 4.542-2.428 1.042-1.68.772-3.931-.627-5.238a3.299 3.299 0 0 0-1.437-.777c.172.589.334 1.18.494 1.772.284 1.12.1 2.181-.519 2.989-.39.51-.956.888-1.592 1.064a3.038 3.038 0 0 1-2.58-.44 3.45 3.45 0 0 1-1.44-2.514c-.04-.467.002-.93.128-1.376.35-1.256 1.356-2.339 2.622-2.826a5.5 5.5 0 0 1 .823-.246l-.134-.505c-.37-1.371.25-2.579 1.547-3.007.329-.109.68-.145 1.025-.105.792.09 1.476.592 1.709 1.023.258.507-.096 1.153-.706 1.153a.788.788 0 0 1-.54-.213c-.088-.08-.163-.174-.259-.247a.825.825 0 0 0-.632-.166.807.807 0 0 0-.634.551c-.056.191-.031.406.02.595.07.256.159.597.217.82 1.11.098 2.162.54 2.97 1.296 1.974 1.844 2.35 4.886.892 7.233-1.197 1.93-3.509 3.177-5.889 3.177zM0 12c0 6.627 5.373 12 12 12s12-5.373 12-12S18.627 0 12 0 0 5.373 0 12Z" />
    </svg>
  );
}

/**
 * QQ 音乐图标：官方 24×24 单色路径。
 */
function QQMusicIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm3.8 6.5.02 4.4a2.7 2.7 0 1 1-2.12-2.64V7.5l4.8-1v2.5l-2.7.5zm-4.4 5.2a1.5 1.5 0 1 0 1.5 1.5 1.5 1.5 0 0 0-1.5-1.5z" />
    </svg>
  );
}

/** 官方会员徽章：图片取自 CDN 原图（`public/assets/netease-vip` 和 `public/assets/qqmusic-vip`），读屏读档位与等级。
 *  路径必须写成完整静态字符串：构建期的 WebP 转换只做精确字符串替换，模板拼接会漏进产物，被 asset-smoke 拦下。 */
const NETEASE_VIP_BADGE_SRC: Record<"svip" | "vip", string[]> = {
  svip: ["", "/assets/netease-vip/SVIP-1.png", "/assets/netease-vip/SVIP-2.png", "/assets/netease-vip/SVIP-3.png", "/assets/netease-vip/SVIP-4.png", "/assets/netease-vip/SVIP-5.png", "/assets/netease-vip/SVIP-6.png", "/assets/netease-vip/SVIP-7.png"],
  vip: ["", "/assets/netease-vip/VIP-1.png", "/assets/netease-vip/VIP-2.png", "/assets/netease-vip/VIP-3.png", "/assets/netease-vip/VIP-4.png", "/assets/netease-vip/VIP-5.png", "/assets/netease-vip/VIP-6.png", "/assets/netease-vip/VIP-7.png"],
};

const QQ_VIP_BADGE_SRC: {
  svip: string[];
  svipYear: string[];
  vip: string[];
  vipYear: string[];
} = {
  svip: [
    "",
    "/assets/qqmusic-vip/SVIP-1.png",
    "/assets/qqmusic-vip/SVIP-2.png",
    "/assets/qqmusic-vip/SVIP-3.png",
    "/assets/qqmusic-vip/SVIP-4.png",
    "/assets/qqmusic-vip/SVIP-5.png",
    "/assets/qqmusic-vip/SVIP-6.png",
    "/assets/qqmusic-vip/SVIP-7.png",
    "/assets/qqmusic-vip/SVIP-8.png",
    "/assets/qqmusic-vip/SVIP-9.png",
    "/assets/qqmusic-vip/SVIP-10.png",
  ],
  svipYear: [
    "",
    "/assets/qqmusic-vip/SVIP-1-Year.png",
    "/assets/qqmusic-vip/SVIP-2-Year.png",
    "/assets/qqmusic-vip/SVIP-3-Year.png",
    "/assets/qqmusic-vip/SVIP-4-Year.png",
    "/assets/qqmusic-vip/SVIP-5-Year.png",
    "/assets/qqmusic-vip/SVIP-6-Year.png",
    "/assets/qqmusic-vip/SVIP-7-Year.png",
    "/assets/qqmusic-vip/SVIP-8-Year.png",
    "/assets/qqmusic-vip/SVIP-9-Year.png",
    "/assets/qqmusic-vip/SVIP-10-Year.png",
  ],
  vip: [
    "",
    "/assets/qqmusic-vip/VIP-1.png",
    "/assets/qqmusic-vip/VIP-2.png",
    "/assets/qqmusic-vip/VIP-3.png",
    "/assets/qqmusic-vip/VIP-4.png",
    "/assets/qqmusic-vip/VIP-5.png",
    "/assets/qqmusic-vip/VIP-6.png",
    "/assets/qqmusic-vip/VIP-7.png",
    "/assets/qqmusic-vip/VIP-8.png",
    "/assets/qqmusic-vip/VIP-9.png",
    "/assets/qqmusic-vip/VIP-10.png",
  ],
  vipYear: [
    "",
    "/assets/qqmusic-vip/VIP-1-Year.png",
    "/assets/qqmusic-vip/VIP-2-Year.png",
    "/assets/qqmusic-vip/VIP-3-Year.png",
    "/assets/qqmusic-vip/VIP-4-Year.png",
    "/assets/qqmusic-vip/VIP-5-Year.png",
    "/assets/qqmusic-vip/VIP-6-Year.png",
    "/assets/qqmusic-vip/VIP-7-Year.png",
    "/assets/qqmusic-vip/VIP-8-Year.png",
    "/assets/qqmusic-vip/VIP-9-Year.png",
    "/assets/qqmusic-vip/VIP-10-Year.png",
  ],
};

function vipBadge(account: SonGuessrMusicAccount): { src: string; label: string } | null {
  const isQq = account.platform === "qq";
  if (isQq) {
    const level = Math.min(Math.max(account.vipLevel ?? 1, 1), 10);
    const isYear = Boolean(account.vipYear);
    if (account.vipTier === "svip") {
      const src = isYear ? QQ_VIP_BADGE_SRC.svipYear[level] : QQ_VIP_BADGE_SRC.svip[level];
      const prefix = isYear ? "年费超级会员" : "超级会员";
      return { src, label: `${prefix} · SVIP${level}` };
    }
    if (account.vipTier === "vip") {
      const src = isYear ? QQ_VIP_BADGE_SRC.vipYear[level] : QQ_VIP_BADGE_SRC.vip[level];
      const prefix = isYear ? "年费绿钻" : "豪华绿钻";
      return { src, label: `${prefix} · LV${level}` };
    }
  } else {
    const level = Math.min(Math.max(account.vipLevel ?? 1, 1), 7);
    if (account.vipTier === "svip") return { src: NETEASE_VIP_BADGE_SRC.svip[level], label: `SVIP · ${LEVEL_NUMERALS[level]}` };
    if (account.vipTier === "vip") return { src: NETEASE_VIP_BADGE_SRC.vip[level], label: `VIP · ${LEVEL_NUMERALS[level]}` };
    if (account.vipTier === "musicPackage") return { src: "/assets/netease-vip/musicPackage.png", label: "音乐包" };
  }
  return null;
}

const expireFormat = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric", timeZone: "Asia/Shanghai" });

/** 会员一行的文字：徽章之后的到期日；旧版本存下的账号没有档位时退回文字。 */
function vipText(account: SonGuessrMusicAccount): { label: string; expire: string; description?: string } {
  const isQq = account.platform === "qq";
  const platformName = isQq ? "QQ音乐" : "网易云";
  const expire = account.vipStatus === "vip" && account.vipExpireTime ? `${expireFormat.format(new Date(account.vipExpireTime))} 到期` : "";
  if (account.vipStatus === "vip") return { label: vipBadge(account)?.label ?? `${platformName}会员`, expire };
  if (account.vipStatus === "nonVip") return { label: "非会员", expire, description: "非会员账号也能出题，会员专享歌曲会自动匹配可用音源。" };
  return { label: "会员状态未知", expire, description: `暂时无法读取会员状态，选歌时以${platformName}实际权限为准。` };
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

/** 官方会员徽章（没有徽章的档位退回文字）与到期日：折叠单行与展开卡共用，保证两处的图片与排版一致。 */
function VipStatus({ vip, badge }: { vip: { label: string; expire: string }; badge: { src: string; label: string } | null }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      {badge ? <img src={badge.src} alt={badge.label} className="h-4 w-auto" /> : <span className="font-medium text-foreground">{vip.label}</span>}
      {vip.expire ? <>{" "}<span className="tabular-nums">{vip.expire}</span></> : null}
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
  const [activePlatform, setActivePlatform] = useState<SongMusicPlatform>("netease");
  const [qqScanType, setQqScanType] = useState<"qq" | "wx" | "mobile">("qq");

  const [storedNetease, setStoredNetease] = useState<StoredSongMusicSession | null>(() => getStoredSongMusicSession("netease"));
  const [storedQq, setStoredQq] = useState<StoredSongMusicSession | null>(() => getStoredSongMusicSession("qq"));

  const [rememberNetease, setRememberNetease] = useState(() => storedNetease?.persistent ?? true);
  const [rememberQq, setRememberQq] = useState(() => storedQq?.persistent ?? true);

  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<QrCreateResponse | null>(null);
  const [qrStatus, setQrStatus] = useState("正在准备登录二维码…");
  const qrCheckingRef = useRef<number | null>(null);
  const loginGenerationRef = useRef(0);
  const rememberRef = useRef({ netease: rememberNetease, qq: rememberQq });

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
    const sync = () => {
      setStoredNetease(getStoredSongMusicSession("netease"));
      setStoredQq(getStoredSongMusicSession("qq"));
    };
    window.addEventListener(SONGUESSR_MUSIC_SESSION_CHANGED, sync);
    return () => window.removeEventListener(SONGUESSR_MUSIC_SESSION_CHANGED, sync);
  }, []);

  const currentStored = activePlatform === "qq" ? storedQq : storedNetease;
  const isCurrentReady = activePlatform === "qq" ? snapshot.qqMusicAccountReady : snapshot.musicAccountReady;
  const currentAccount = isCurrentReady ? currentStored?.account : undefined;
  const showQr = !currentStored;

  const completeLogin = useCallback((platform: SongMusicPlatform, session: { cookie: string; account: SonGuessrMusicAccount }) => {
    loginGenerationRef.current += 1;
    const persistent = rememberRef.current[platform];
    const accountToSave = platform === "qq" ? { ...session.account, platform: "qq" as const } : session.account;
    saveSongMusicSession({ cookie: session.cookie, account: accountToSave }, persistent, platform);
    if (platform === "qq") {
      setStoredQq({ cookie: session.cookie, account: accountToSave, persistent });
      setNotice("QQ音乐账号已加载到当前房间", "success");
    } else {
      setStoredNetease({ cookie: session.cookie, account: accountToSave, persistent });
      setNotice("网易云账号已加载到当前房间", "success");
    }
    setQr(null);
    setQrStatus("登录成功");
  }, [setNotice]);

  const createQr = useCallback(async (targetPlatform = activePlatform, scanType = qqScanType) => {
    const generation = ++loginGenerationRef.current;
    setBusy(true);
    try {
      const result = targetPlatform === "qq"
        ? await sendCommand<QrCreateResponse>("song.auth.qr.create", { platform: "qq", type: scanType })
        : await sendCommand<QrCreateResponse>("song.auth.qr.create");
      if (generation !== loginGenerationRef.current) return;
      setQr(result);
      if (targetPlatform === "qq") {
        setQrStatus(scanType === "wx" ? "请使用微信扫码" : scanType === "mobile" ? "请使用 QQ 音乐 App 扫码" : "请使用手机 QQ 扫码");
      } else {
        setQrStatus("请使用网易云音乐 App 扫码");
      }
    } catch (error) {
      if (generation !== loginGenerationRef.current) return;
      setQrStatus((error as { message?: string }).message ?? "二维码生成失败，请稍后重试");
      setNotice((error as { message?: string }).message ?? "二维码生成失败", "error");
    } finally {
      if (generation === loginGenerationRef.current) setBusy(false);
    }
  }, [activePlatform, qqScanType, sendCommand, setNotice]);

  const checkQr = useCallback(async () => {
    if (!qr || qrCheckingRef.current === loginGenerationRef.current) return;
    const generation = loginGenerationRef.current;
    const qrKey = qr.key;
    const platform = activePlatform;
    const scanType = qqScanType;
    qrCheckingRef.current = generation;
    try {
      const result = platform === "qq"
        ? await sendCommand<QrCheckResponse>("song.auth.qr.check", { key: qrKey, platform: "qq", type: scanType })
        : await sendCommand<QrCheckResponse>("song.auth.qr.check", { key: qrKey });
      if (generation !== loginGenerationRef.current) return;
      setQrStatus(result.message || "等待扫码");
      if (result.status === "expired") {
        setQr(null);
        setQrStatus("二维码已过期，请点击刷新");
      } else if (result.status === "authorized" && result.cookie && result.account) {
        completeLogin(platform, { cookie: result.cookie, account: result.account });
      }
    } catch (error) {
      if (generation !== loginGenerationRef.current) return;
      const appError = error as { code?: string; message?: string };
      if (appError.code === "MUSIC_LOGIN_RISK") {
        setQr(null);
        setQrStatus(platform === "qq" ? "QQ音乐暂时拒绝了本次登录，请稍后重新扫码" : "网易云暂时拒绝了本次登录，请稍后重新扫码");
      } else {
        setQrStatus(appError.message ?? "二维码状态检查失败");
      }
    } finally {
      if (qrCheckingRef.current === generation) qrCheckingRef.current = null;
    }
  }, [activePlatform, completeLogin, qqScanType, qr, sendCommand]);

  useEffect(() => {
    if (!open || !showQr || !qr) return;
    const timer = window.setInterval(() => void checkQr(), 2_000);
    return () => window.clearInterval(timer);
  }, [checkQr, open, qr, showQr]);

  const refreshQr = () => {
    cancelLogin();
    void createQr(activePlatform, qqScanType);
  };

  const switchPlatform = (platform: SongMusicPlatform) => {
    if (platform === activePlatform) return;
    cancelLogin();
    setActivePlatform(platform);
    const targetStored = platform === "qq" ? storedQq : storedNetease;
    if (!targetStored && open) {
      void createQr(platform, qqScanType);
    }
  };

  const handleQqScanTypeChange = (mode: "qq" | "wx" | "mobile") => {
    if (mode === qqScanType) return;
    setQqScanType(mode);
    cancelLogin();
    if (open && activePlatform === "qq" && !storedQq) {
      void createQr("qq", mode);
    }
  };

  /** 退出登录：清掉当前平台房间里的凭据与本机存储 */
  const logout = async () => {
    cancelLogin();
    const generation = loginGenerationRef.current;
    const platform = activePlatform;
    setBusy(true);
    try {
      if (platform === "qq") {
        await sendCommand("song.auth.clear", { platform: "qq" });
      } else {
        await sendCommand("song.auth.clear");
      }
    } catch {
      // 本地状态仍需立即清除
    }
    if (generation !== loginGenerationRef.current) return;
    setBusy(false);
    clearStoredSongMusicSession(platform);
    if (platform === "qq") {
      setStoredQq(null);
      setNotice("已退出QQ音乐账号", "success");
    } else {
      setStoredNetease(null);
      setNotice("已退出网易云账号", "success");
    }
    setQr(null);
    if (open) void createQr(platform, qqScanType);
  };

  const neteaseAccount = snapshot.musicAccountReady ? storedNetease?.account : undefined;
  const qqAccount = snapshot.qqMusicAccountReady ? storedQq?.account : undefined;
  const neteaseConnecting = Boolean(storedNetease) && !snapshot.musicAccountReady;
  const qqConnecting = Boolean(storedQq) && !snapshot.qqMusicAccountReady;

  let headline: React.ReactNode;
  if (neteaseAccount && qqAccount) {
    const neteaseVip = vipText(neteaseAccount);
    const neteaseBadge = vipBadge(neteaseAccount);
    const qqVip = vipText(qqAccount);
    const qqBadge = vipBadge(qqAccount);
    headline = (
      <div className="flex min-w-0 max-w-full items-center gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <AccountAvatar account={neteaseAccount} className="size-5" />
          <span className="truncate text-sm font-medium" title={neteaseAccount.nickname}>{neteaseAccount.nickname}</span>
          {" "}
          <VipStatus vip={neteaseVip} badge={neteaseBadge} />
        </span>
        <span className="text-muted-foreground/30">|</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <AccountAvatar account={qqAccount} className="size-5" />
          <span className="truncate text-sm font-medium" title={qqAccount.nickname}>{qqAccount.nickname}</span>
          {" "}
          <VipStatus vip={qqVip} badge={qqBadge} />
        </span>
      </div>
    );
  } else if (neteaseAccount) {
    const vip = vipText(neteaseAccount);
    const badge = vipBadge(neteaseAccount);
    headline = (
      <>
        <AccountAvatar account={neteaseAccount} className="size-5" />
        <span className="min-w-0 max-w-full truncate text-sm font-medium" title={neteaseAccount.nickname}>{neteaseAccount.nickname}</span>
        {" "}
        <VipStatus vip={vip} badge={badge} />
      </>
    );
  } else if (qqAccount) {
    const vip = vipText(qqAccount);
    const badge = vipBadge(qqAccount);
    headline = (
      <>
        <AccountAvatar account={qqAccount} className="size-5" />
        <span className="min-w-0 max-w-full truncate text-sm font-medium" title={qqAccount.nickname}>{qqAccount.nickname}</span>
        {" "}
        <VipStatus vip={vip} badge={badge} />
      </>
    );
  } else if (neteaseConnecting) {
    headline = <span className="text-sm text-muted-foreground">正在连接网易云账号…</span>;
  } else if (qqConnecting) {
    headline = <span className="text-sm text-muted-foreground">正在连接QQ音乐账号…</span>;
  } else {
    headline = <span className="text-sm text-muted-foreground">未配置</span>;
  }

  const toggle = (next: boolean) => {
    if (!next) { cancelLogin(); setOpen(false); return; }
    setOpen(true);
    if (showQr && !qr && !busy) void createQr(activePlatform, qqScanType);
  };

  const vip = currentAccount ? vipText(currentAccount) : null;
  const badge = currentAccount ? vipBadge(currentAccount) : null;

  return (
    <SettingsAccordion
      icon={UserRound}
      title="音乐账号配置"
      open={open}
      onOpenChange={toggle}
      media={
        activePlatform === "qq" ? (
          <QQMusicIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <NeteaseCloudMusicIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )
      }
      headline={headline}
    >
      {/* 平台切换器 */}
      <div className="mb-4 flex rounded-lg bg-muted p-0.5 text-xs font-medium">
        <button
          type="button"
          onClick={() => switchPlatform("netease")}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 transition-colors",
            activePlatform === "netease"
              ? "bg-background text-foreground shadow-xs font-semibold"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <NeteaseCloudMusicIcon className="size-3.5" />
          <span>网易云音乐</span>
          {snapshot.musicAccountReady ? <span className="size-1.5 rounded-full bg-success" /> : null}
        </button>
        <button
          type="button"
          onClick={() => switchPlatform("qq")}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 transition-colors",
            activePlatform === "qq"
              ? "bg-background text-foreground shadow-xs font-semibold"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <QQMusicIcon className="size-3.5" />
          <span>QQ音乐</span>
          {snapshot.qqMusicAccountReady ? <span className="size-1.5 rounded-full bg-success" /> : null}
        </button>
      </div>

      {/* 账号与二维码两态各自按高度收放，一个收起时另一个撑开 */}
      <CollapsibleRegion open={!showQr}>
        <div className="space-y-4">
          {currentAccount && vip ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-3">
                <AccountAvatar account={currentAccount} className="size-11" />
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 max-w-full truncate text-sm font-medium" title={currentAccount.nickname}>
                    {currentAccount.nickname}
                  </span>
                  <VipStatus vip={vip} badge={badge} />
                </div>
              </div>
              {vip.description ? <p className="text-xs leading-relaxed text-muted-foreground">{vip.description}</p> : null}
            </div>
          ) : (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />{activePlatform === "qq" ? "正在连接QQ音乐账号…" : "正在连接网易云账号…"}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-1.5 text-destructive hover:text-destructive"
            disabled={busy}
            onClick={() => void logout()}
          >
            <LogOut className="h-3.5 w-3.5" />退出登录
          </Button>
        </div>
      </CollapsibleRegion>

      <CollapsibleRegion open={showQr}>
        <div className="space-y-4">
          {activePlatform === "qq" ? (
            <div className="flex gap-1.5 rounded-md bg-muted/60 p-1 text-xs">
              {(["qq", "wx", "mobile"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => handleQqScanTypeChange(mode)}
                  className={cn(
                    "flex-1 rounded py-1 text-center transition-colors",
                    qqScanType === mode
                      ? "bg-background font-medium text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {mode === "qq" ? "QQ扫码" : mode === "wx" ? "微信扫码" : "QQ音乐扫码"}
                </button>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-4">
            <div className="relative mx-auto h-36 w-36 shrink-0 overflow-hidden rounded-md border bg-white sm:mx-0">
              <AnimatePresence initial={false}>
                {qr ? (
                  <motion.img
                    key={qr.key}
                    src={qr.qrImage}
                    alt={activePlatform === "qq" ? "QQ音乐登录二维码" : "网易云登录二维码"}
                    variants={readoutSwap}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className="absolute inset-0 h-full w-full p-2"
                  />
                ) : (
                  <motion.span
                    key="placeholder"
                    variants={readoutSwap}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className="absolute inset-0 flex items-center justify-center bg-muted"
                  >
                    {busy ? (
                      <Spinner className="size-6 text-muted-foreground" />
                    ) : (
                      <QrCode className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
                    )}
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
            <div className="min-w-0 basis-44 flex-1 space-y-3">
              <ol className="space-y-1 text-xs leading-relaxed text-muted-foreground">
                {activePlatform === "qq" ? (
                  qqScanType === "wx" ? (
                    <>
                      <li>1. 打开微信</li>
                      <li>2. 用「扫一扫」扫描左侧二维码</li>
                      <li>3. 在手机上确认登录</li>
                    </>
                  ) : qqScanType === "mobile" ? (
                    <>
                      <li>1. 打开 QQ 音乐 App</li>
                      <li>2. 用「扫一扫」扫描左侧二维码</li>
                      <li>3. 在手机上确认登录</li>
                    </>
                  ) : (
                    <>
                      <li>1. 打开手机 QQ</li>
                      <li>2. 用「扫一扫」扫描左侧二维码</li>
                      <li>3. 在手机上确认登录</li>
                    </>
                  )
                ) : (
                  <>
                    <li>1. 打开网易云音乐 App</li>
                    <li>2. 用「扫一扫」扫描左侧二维码</li>
                    <li>3. 在手机上确认登录</li>
                  </>
                )}
              </ol>
              <p aria-live="polite" className="text-sm">{qrStatus}</p>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={refreshQr} disabled={busy}>
                <RefreshCw className="h-3.5 w-3.5" />刷新二维码
              </Button>
            </div>
          </div>
          <SettingSwitchRow
            label="保存登录状态"
            description="仅保存在当前浏览器，服务器不持久化账号信息"
            checked={activePlatform === "qq" ? rememberQq : rememberNetease}
            onCheckedChange={(value) => {
              if (activePlatform === "qq") {
                rememberRef.current.qq = value;
                setRememberQq(value);
              } else {
                rememberRef.current.netease = value;
                setRememberNetease(value);
              }
            }}
          />
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
