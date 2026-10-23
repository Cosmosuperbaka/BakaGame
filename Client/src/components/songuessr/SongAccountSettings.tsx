import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { LogOut, QrCode, RefreshCw, ShieldCheck, UserRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CollapsibleRegion } from "@/components/ui/Collapsible";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Spinner } from "@/components/ui/Spinner";
import { Hint } from "@/components/ui/Tooltip";
import { SettingSwitchRow } from "@/components/common/room/SettingFields";
import { SettingsAccordion } from "@/components/common/room/SettingsAccordion";
import { NeteaseCloudMusicIcon, QQMusicIcon } from "@/components/common/MusicPlatformIcons";
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
import type {
  SonGuessrAck,
  SonGuessrMusicAccount,
  SonGuessrMusicPoolView,
  SonGuessrPlayerView,
  SonGuessrRoomSnapshot,
} from "@bakagame/shared";

/** 黑胶与绿钻成长等级在官方徽章上的写法。 */
const LEVEL_NUMERALS = ["", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌"];

/** 官方会员徽章：图片取自 CDN 原图（`public/assets/netease-vip` 和 `public/assets/qqmusic-vip`），读屏读档位与等级。
 *  路径必须写成完整静态字符串：构建期的 WebP 转换只做精确字符串替换，模板拼接会漏进产物，被 asset-smoke 拦下。 */
const NETEASE_VIP_BADGE_SRC: Record<"svip" | "vip", string[]> = {
  svip: [
    "",
    "/assets/netease-vip/SVIP-1.png",
    "/assets/netease-vip/SVIP-2.png",
    "/assets/netease-vip/SVIP-3.png",
    "/assets/netease-vip/SVIP-4.png",
    "/assets/netease-vip/SVIP-5.png",
    "/assets/netease-vip/SVIP-6.png",
    "/assets/netease-vip/SVIP-7.png",
  ],
  vip: [
    "",
    "/assets/netease-vip/VIP-1.png",
    "/assets/netease-vip/VIP-2.png",
    "/assets/netease-vip/VIP-3.png",
    "/assets/netease-vip/VIP-4.png",
    "/assets/netease-vip/VIP-5.png",
    "/assets/netease-vip/VIP-6.png",
    "/assets/netease-vip/VIP-7.png",
  ],
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

type VipBadge = { src: string; label: string; platform: SongMusicPlatform };

function qqVipBadge(account: SonGuessrMusicAccount): VipBadge | null {
  const level = Math.min(Math.max(account.vipLevel ?? 1, 1), 10);
  const isYear = Boolean(account.vipYear);
  if (account.vipTier === "svip") {
    return {
      src: isYear ? QQ_VIP_BADGE_SRC.svipYear[level] : QQ_VIP_BADGE_SRC.svip[level],
      label: `${isYear ? "年费超级会员" : "超级会员"} · SVIP${level}`,
      platform: "qq",
    };
  }
  if (account.vipTier === "vip") {
    return {
      src: isYear ? QQ_VIP_BADGE_SRC.vipYear[level] : QQ_VIP_BADGE_SRC.vip[level],
      label: `${isYear ? "年费绿钻" : "豪华绿钻"} · LV${level}`,
      platform: "qq",
    };
  }
  return null;
}

function neteaseVipBadge(account: SonGuessrMusicAccount): VipBadge | null {
  const level = Math.min(Math.max(account.vipLevel ?? 1, 1), 7);
  if (account.vipTier === "svip")
    return {
      src: NETEASE_VIP_BADGE_SRC.svip[level],
      label: `SVIP · ${LEVEL_NUMERALS[level]}`,
      platform: "netease",
    };
  if (account.vipTier === "vip")
    return {
      src: NETEASE_VIP_BADGE_SRC.vip[level],
      label: `VIP · ${LEVEL_NUMERALS[level]}`,
      platform: "netease",
    };
  if (account.vipTier === "musicPackage")
    return { src: "/assets/netease-vip/musicPackage.png", label: "音乐包", platform: "netease" };
  return null;
}

function vipBadge(account: SonGuessrMusicAccount): VipBadge | null {
  return account.platform === "qq" ? qqVipBadge(account) : neteaseVipBadge(account);
}

const expireFormat = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  timeZone: "Asia/Shanghai",
});

/** 会员一行的文字：徽章之后的到期日；旧版本存下的账号没有档位时退回文字。 */
function vipText(account: SonGuessrMusicAccount): {
  label: string;
  expire: string;
  description?: string;
} {
  const isQq = account.platform === "qq";
  const platformName = isQq ? "QQ音乐" : "网易云";
  const expire =
    account.vipStatus === "vip" && account.vipExpireTime
      ? `${expireFormat.format(new Date(account.vipExpireTime))} 到期`
      : "";
  if (account.vipStatus === "vip")
    return { label: vipBadge(account)?.label ?? `${platformName}会员`, expire };
  if (account.vipStatus === "nonVip")
    return {
      label: "非会员",
      expire,
      description: "非会员账号也能出题，会员专享歌曲会自动匹配可用音源。",
    };
  return {
    label: "会员状态未知",
    expire,
    description: `暂时无法读取会员状态，选歌时以${platformName}实际权限为准。`,
  };
}

function AccountAvatar({
  account,
  className,
}: {
  account: SonGuessrMusicAccount;
  className: string;
}) {
  return account.avatarUrl ? (
    <img
      src={account.avatarUrl}
      alt=""
      className={cn(className, "shrink-0 rounded-full bg-muted object-cover")}
    />
  ) : (
    <span
      className={cn(
        className,
        "flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
      )}
    >
      <UserRound className="size-3/5" aria-hidden="true" />
    </span>
  );
}

/** 官方会员徽章（没有徽章的档位退回文字）与到期日：折叠单行与展开卡共用，保证两处的图片与排版一致。
 *  QQ 音乐官方母版 PNG 画布高 46px 但徽章实体仅占 28px（上下含 9px 透明边距），
 *  需将图像高放大约 1.64 倍至 26px 并配合 -my-[5px] 负外边距，使视觉实体高度与网易云（无透明边距 16px）绝对对齐且不撑高外层行高。 */
function VipStatus({
  vip,
  badge,
}: {
  vip: { label: string; expire: string };
  badge: { src: string; label: string; platform?: SongMusicPlatform } | null;
}) {
  const isQq = badge?.platform === "qq" || Boolean(badge?.src.includes("qqmusic-vip"));
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      {badge ? (
        <img
          src={badge.src}
          alt={badge.label}
          className={cn("w-auto shrink-0", isQq ? "h-[26px] -my-[5px]" : "h-4")}
        />
      ) : (
        <span className="font-medium text-foreground">{vip.label}</span>
      )}
      {vip.expire ? (
        <>
          {" "}
          <span className="tabular-nums">{vip.expire}</span>
        </>
      ) : null}
    </span>
  );
}

/** 二维码回包：形状由 shared 的 ack 契约给出，这里只留别名让状态与 props 好读。 */
type QrCreateResponse = SonGuessrAck<"song.auth.qr.create">;

export function SongAccountSettings({
  snapshot,
  me,
}: {
  snapshot: SonGuessrRoomSnapshot;
  /** 当前玩家：账号池里「我的号」按它定位，缺省时退回房间级账号展示（老快照/故事夹具）。 */
  me?: SonGuessrPlayerView;
}) {
  return <RoomAccountSettings key={snapshot.roomId} snapshot={snapshot} me={me} />;
}

type QqScanMode = "qq" | "wx" | "mobile";

const PLATFORM_TABS: readonly {
  platform: SongMusicPlatform;
  label: string;
  Icon: ComponentType<{ className?: string }>;
}[] = [
  { platform: "netease", label: "网易云音乐", Icon: NeteaseCloudMusicIcon },
  { platform: "qq", label: "QQ音乐", Icon: QQMusicIcon },
];

/**
 * 平台切换器：分段单选，选中的那一端决定下方展示哪份账号信息与哪一条登录二维码。
 * 该端凭据已加载到房间时在标签后点一枚绿点；绿点只是提示，读屏改读 `sr-only` 的文字，
 * 不让颜色单独承担状态（Design §3）。
 */
function PlatformSwitcher({
  active,
  ready,
  onSelect,
}: {
  active: SongMusicPlatform;
  ready: Record<SongMusicPlatform, boolean | undefined>;
  onSelect: (platform: SongMusicPlatform) => void;
}) {
  return (
    <SegmentedControl
      size="sm"
      className="mb-4 w-full"
      aria-label="音乐平台"
      value={active}
      onValueChange={onSelect}
      options={PLATFORM_TABS.map(({ platform, label, Icon }) => ({
        value: platform,
        label: (
          <span className="flex items-center gap-1.5">
            <Icon className="size-3.5" />
            <span>{label}</span>
            {ready[platform] ? (
              <>
                <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
                <span className="sr-only">，凭据已加载到房间</span>
              </>
            ) : null}
          </span>
        ),
      }))}
    />
  );
}

const QQ_SCAN_TYPES: readonly { mode: QqScanMode; label: string }[] = [
  { mode: "qq", label: "QQ扫码" },
  { mode: "wx", label: "微信扫码" },
  { mode: "mobile", label: "QQ音乐扫码" },
];

/** QQ 音乐的三种扫码入口：同样是分段单选，换档即重发一次二维码。 */
function QqScanTypePicker({
  value,
  onSelect,
}: {
  value: QqScanMode;
  onSelect: (mode: QqScanMode) => void;
}) {
  return (
    <SegmentedControl
      size="sm"
      className="w-full"
      aria-label="扫码方式"
      value={value}
      onValueChange={onSelect}
      options={QQ_SCAN_TYPES.map(({ mode, label }) => ({ value: mode, label }))}
    />
  );
}

/** 扫码步骤文案：QQ 平台按扫码方式换第一个 App，网易云固定一条。 */
function scanStepLines(platform: SongMusicPlatform, scanType: QqScanMode): string[] {
  if (platform !== "qq")
    return ["1. 打开网易云音乐 App", "2. 用「扫一扫」扫描左侧二维码", "3. 在手机上确认登录"];
  if (scanType === "wx")
    return ["1. 打开微信", "2. 用「扫一扫」扫描左侧二维码", "3. 在手机上确认登录"];
  if (scanType === "mobile")
    return ["1. 打开 QQ 音乐 App", "2. 用「扫一扫」扫描左侧二维码", "3. 在手机上确认登录"];
  return ["1. 打开手机 QQ", "2. 用「扫一扫」扫描左侧二维码", "3. 在手机上确认登录"];
}

function ScanSteps({ platform, scanType }: { platform: SongMusicPlatform; scanType: QqScanMode }) {
  return (
    <ol className="space-y-1 text-xs leading-relaxed text-muted-foreground">
      {scanStepLines(platform, scanType).map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ol>
  );
}

const qrAlt = (platform: SongMusicPlatform): string =>
  platform === "qq" ? "QQ音乐登录二维码" : "网易云登录二维码";

const connectingLabel = (platform: SongMusicPlatform): string =>
  platform === "qq" ? "正在连接QQ音乐账号…" : "正在连接网易云账号…";

/** 二维码画框：拿到图就换图，否则按忙闲显示转圈或占位图标。
 *  画框底恒定取白而不跟随主题：二维码要一圈亮度恒定的静区才扫得出来，
 *  暗色下把静区换成 `bg-background` 会连模块边缘一起吃掉；上游给的是不透明白底图，
 *  这里只是补上外圈的留白。 */
function QrFrame({ qr, busy, alt }: { qr: QrCreateResponse | null; busy: boolean; alt: string }) {
  return (
    <div className="relative mx-auto h-36 w-36 shrink-0 overflow-hidden rounded-md border bg-white sm:mx-0">
      <AnimatePresence initial={false}>
        {qr ? (
          <motion.img
            key={qr.key}
            src={qr.qrImage}
            alt={alt}
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
  );
}

/** 池里属于我的那条记录；没有池（旧快照 / 故事夹具）或没有身份时为空。 */
function myPoolEntry(
  snapshot: SonGuessrRoomSnapshot,
  me: SonGuessrPlayerView | undefined,
  platform: SongMusicPlatform
): SonGuessrMusicPoolView | undefined {
  if (snapshot.musicPool === undefined || me === undefined) return undefined;
  return snapshot.musicPool.find(
    (entry) => entry.playerId === me.id && entry.platform === platform
  );
}

/**
 * 本行要展示的账号。
 *
 * 快照带了账号池就**只看我自己的号**：池里排在前面的可能是别人的号，拿它当「我的账号」
 * 会让玩家看到别人的昵称、点退出登录还清不掉（B4：谁的号谁做主）。
 * 老快照没有池字段时退回房间级账号，故事夹具与旧用例的展示保持不变。
 */
function displayAccountFor(
  snapshot: SonGuessrRoomSnapshot,
  me: SonGuessrPlayerView | undefined,
  platform: SongMusicPlatform,
  stored: StoredSongMusicSession | null
): SonGuessrMusicAccount | undefined {
  if (snapshot.musicPool !== undefined) {
    return myPoolEntry(snapshot, me, platform)?.account;
  }
  const roomReady = platform === "qq" ? snapshot.qqMusicAccountReady : snapshot.musicAccountReady;
  return snapshot.musicAccounts?.[platform] ?? (roomReady ? stored?.account : undefined);
}

/** 服务端暂停了号主的号：必须说出来，否则号主只看到开关自己变灰，会以为是谁动了设置。 */
function PoolPausedNotice({ entry }: { entry?: SonGuessrMusicPoolView }) {
  if (!entry) return null;
  return (
    <p
      role="status"
      className="mb-4 rounded-md bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground"
    >
      服务端已暂停使用这个号：{entry.lastFailureReason ?? "上游暂时拒绝请求"}。
      {entry.enabled ? "稍后会自行恢复，无需重新登录。" : "请重新登录后再共享。"}
    </p>
  );
}

/** 号主自己的共享开关：只在等待阶段可改（服务端也会再拦一次）。 */
function PoolSharingRow({
  entry,
  locked,
  busy,
  onToggle,
}: {
  entry?: SonGuessrMusicPoolView;
  locked: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  if (!entry) return null;
  return (
    <SettingSwitchRow
      label="允许本房使用我的账号"
      description={
        locked
          ? "开局后不能改；下一局回到准备页再调整"
          : "出题取歌时会用这个号；关掉后本房不再取用，正在跑的请求会自己跑完"
      }
      checked={entry.enabled}
      disabled={locked || busy}
      onCheckedChange={onToggle}
    />
  );
}

/** 凭据被判死时服务端已经把开关关掉，光看开关看不出原因，这里给一条明确的重登入口。 */
function PoolReloginButton({
  entry,
  busy,
  onRelogin,
}: {
  entry?: SonGuessrMusicPoolView;
  busy: boolean;
  onRelogin: () => void;
}) {
  if (!entry || entry.enabled) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-full gap-1.5"
      disabled={busy}
      onClick={onRelogin}
    >
      <RefreshCw className="h-3.5 w-3.5" />
      重新登录
    </Button>
  );
}

/** 共享开关的命令通道：忙碌态与失败提示都收在这里，账号组件本身只读结果。 */
function usePoolSharing() {
  const sendCommand = useSonGuessrStore((state) => state.sendCommand);
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const [sharingBusy, setSharingBusy] = useState(false);
  const setSharing = async (platform: SongMusicPlatform, enabled: boolean) => {
    setSharingBusy(true);
    try {
      await sendCommand("song.auth.setPoolSharing", { platform, enabled });
    } catch (error) {
      setNotice((error as { message?: string }).message ?? "切换账号共享失败，请重试", "error");
    } finally {
      setSharingBusy(false);
    }
  };
  return { sharingBusy, setSharing };
}

function RoomAccountSettings({
  snapshot,
  me,
}: {
  snapshot: SonGuessrRoomSnapshot;
  me?: SonGuessrPlayerView;
}) {
  const sendCommand = useSonGuessrStore((state) => state.sendCommand);
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const [open, setOpen] = useState(false);
  const [activePlatform, setActivePlatform] = useState<SongMusicPlatform>("netease");
  const [qqScanType, setQqScanType] = useState<QqScanMode>("qq");

  const [storedNetease, setStoredNetease] = useState<StoredSongMusicSession | null>(() =>
    getStoredSongMusicSession("netease")
  );
  const [storedQq, setStoredQq] = useState<StoredSongMusicSession | null>(() =>
    getStoredSongMusicSession("qq")
  );

  const [rememberNetease, setRememberNetease] = useState(() => storedNetease?.persistent ?? true);
  const [rememberQq, setRememberQq] = useState(() => storedQq?.persistent ?? true);

  const [busy, setBusy] = useState(false);
  const { sharingBusy, setSharing } = usePoolSharing();
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

  useEffect(
    () => () => {
      loginGenerationRef.current += 1;
    },
    []
  );

  useEffect(() => {
    const sync = () => {
      setStoredNetease(getStoredSongMusicSession("netease"));
      setStoredQq(getStoredSongMusicSession("qq"));
    };
    window.addEventListener(SONGUESSR_MUSIC_SESSION_CHANGED, sync);
    return () => window.removeEventListener(SONGUESSR_MUSIC_SESSION_CHANGED, sync);
  }, []);

  const currentStored = activePlatform === "qq" ? storedQq : storedNetease;
  const poolAware = snapshot.musicPool !== undefined;
  const currentEntry = myPoolEntry(snapshot, me, activePlatform);
  /**
   * 被服务端暂停的号：冷却期内不参与取号。风控与限流到点自动恢复（凭据被判死时服务端会顺手
   * 关掉开关），所以只有「开关也关了」才要号主重新登录。
   */
  const cooldownEntry = currentEntry?.cooldownUntil !== undefined ? currentEntry : undefined;
  /** 共享开关只在等待阶段可改，与 `song.room.updateSettings` 同一道门槛（服务端也会再拦一次）。 */
  const sharingLocked = snapshot.phase !== "waiting";
  const currentAccount = displayAccountFor(snapshot, me, activePlatform, currentStored);
  // 只在「我这端既没进池、本机也没凭据」时才摆二维码；本机有凭据就等自动装载，先显示正在连接。
  const showQr = poolAware ? currentAccount === undefined && !currentStored : !currentStored;

  const completeLogin = useCallback(
    (platform: SongMusicPlatform, session: { cookie: string; account: SonGuessrMusicAccount }) => {
      loginGenerationRef.current += 1;
      const persistent = rememberRef.current[platform];
      const accountToSave =
        platform === "qq" ? { ...session.account, platform: "qq" as const } : session.account;
      saveSongMusicSession(
        { cookie: session.cookie, account: accountToSave },
        persistent,
        platform
      );
      if (platform === "qq") {
        setStoredQq({ cookie: session.cookie, account: accountToSave, persistent });
        setNotice("QQ音乐账号已加载到当前房间", "success");
      } else {
        setStoredNetease({ cookie: session.cookie, account: accountToSave, persistent });
        setNotice("网易云账号已加载到当前房间", "success");
      }
      setQr(null);
      setQrStatus("登录成功");
    },
    [setNotice]
  );

  const createQr = useCallback(
    async (targetPlatform = activePlatform, scanType = qqScanType) => {
      const generation = ++loginGenerationRef.current;
      setBusy(true);
      try {
        const result =
          targetPlatform === "qq"
            ? await sendCommand("song.auth.qr.create", {
                platform: "qq",
                type: scanType,
              })
            : await sendCommand("song.auth.qr.create");
        if (generation !== loginGenerationRef.current) return;
        setQr(result);
        if (targetPlatform === "qq") {
          setQrStatus(
            scanType === "wx"
              ? "请使用微信扫码"
              : scanType === "mobile"
                ? "请使用 QQ 音乐 App 扫码"
                : "请使用手机 QQ 扫码"
          );
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
    },
    [activePlatform, qqScanType, sendCommand, setNotice]
  );

  const checkQr = useCallback(async () => {
    if (!qr || qrCheckingRef.current === loginGenerationRef.current) return;
    const generation = loginGenerationRef.current;
    const qrKey = qr.key;
    const platform = activePlatform;
    const scanType = qqScanType;
    qrCheckingRef.current = generation;
    try {
      const result =
        platform === "qq"
          ? await sendCommand("song.auth.qr.check", {
              key: qrKey,
              platform: "qq",
              type: scanType,
            })
          : await sendCommand("song.auth.qr.check", { key: qrKey });
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
        setQrStatus(
          platform === "qq"
            ? "QQ音乐暂时拒绝了本次登录，请稍后重新扫码"
            : "网易云暂时拒绝了本次登录，请稍后重新扫码"
        );
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

  const handleQqScanTypeChange = (mode: QqScanMode) => {
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

  const neteaseAccount = displayAccountFor(snapshot, me, "netease", storedNetease);
  const qqAccount = displayAccountFor(snapshot, me, "qq", storedQq);
  const neteaseConnecting = Boolean(storedNetease) && neteaseAccount === undefined;
  const qqConnecting = Boolean(storedQq) && qqAccount === undefined;

  const renderAccountPill = (
    platform: "netease" | "qq",
    account?: SonGuessrMusicAccount,
    connecting?: boolean
  ) => {
    const isQq = platform === "qq";
    const Icon = isQq ? QQMusicIcon : NeteaseCloudMusicIcon;
    const iconClass = "size-3.5 shrink-0";

    const platformName = isQq ? "QQ音乐" : "网易云";

    if (account) {
      const vip = vipText(account);
      const badge = vipBadge(account);
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon className={iconClass} />
          <AccountAvatar account={account} className="size-4 shrink-0" />
          <Hint label={account.nickname}>
            <span className="truncate text-xs font-medium">{account.nickname}</span>
          </Hint>
          <VipStatus vip={vip} badge={badge} />
        </span>
      );
    }

    if (connecting) {
      return (
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className={iconClass} />
          <span>正在连接{platformName}账号…</span>
        </span>
      );
    }

    return (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className={iconClass} />
        <span>未配置</span>
      </span>
    );
  };

  const headline = (
    <div className="flex min-w-0 w-full flex-col gap-1.5 overflow-hidden">
      {renderAccountPill("netease", neteaseAccount, neteaseConnecting)}
      {renderAccountPill("qq", qqAccount, qqConnecting)}
    </div>
  );

  const toggle = (next: boolean) => {
    if (!next) {
      cancelLogin();
      setOpen(false);
      return;
    }
    setOpen(true);
    if (showQr && !qr && !busy) void createQr(activePlatform, qqScanType);
  };

  const vip = currentAccount ? vipText(currentAccount) : null;
  const badge = currentAccount ? vipBadge(currentAccount) : null;

  return (
    <SettingsAccordion title="音乐账号配置" open={open} onOpenChange={toggle} headline={headline}>
      {/* 平台切换器 */}
      <PlatformSwitcher
        active={activePlatform}
        ready={{ netease: snapshot.musicAccountReady, qq: snapshot.qqMusicAccountReady }}
        onSelect={switchPlatform}
      />

      {/* 被服务端暂停时必须说出来：否则号主只看到开关自己变灰，会以为是房主或页面动了设置。 */}
      <PoolPausedNotice entry={cooldownEntry} />

      {/* 账号与二维码两态各自按高度收放，一个收起时另一个撑开 */}
      <CollapsibleRegion open={!showQr}>
        <div className="space-y-4">
          {currentAccount && vip ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-3">
                <AccountAvatar account={currentAccount} className="size-11" />
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                  <Hint label={currentAccount.nickname}>
                    <span className="min-w-0 max-w-full truncate text-sm font-medium">
                      {currentAccount.nickname}
                    </span>
                  </Hint>
                  <VipStatus vip={vip} badge={badge} />
                </div>
              </div>
              {vip.description ? (
                <p className="text-xs leading-relaxed text-muted-foreground">{vip.description}</p>
              ) : null}
            </div>
          ) : (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              {connectingLabel(activePlatform)}
            </p>
          )}
          <PoolSharingRow
            entry={currentEntry}
            locked={sharingLocked}
            busy={sharingBusy}
            onToggle={(value) => void setSharing(activePlatform, value)}
          />
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-1.5 text-destructive hover:text-destructive"
            disabled={busy}
            onClick={() => void logout()}
          >
            <LogOut className="h-3.5 w-3.5" />
            退出登录
          </Button>
          <PoolReloginButton entry={cooldownEntry} busy={busy} onRelogin={() => void logout()} />
        </div>
      </CollapsibleRegion>

      <CollapsibleRegion open={showQr}>
        <div className="space-y-4">
          {activePlatform === "qq" ? (
            <QqScanTypePicker value={qqScanType} onSelect={handleQqScanTypeChange} />
          ) : null}

          <div className="flex flex-wrap items-center gap-4">
            <QrFrame qr={qr} busy={busy} alt={qrAlt(activePlatform)} />
            <div className="min-w-0 basis-44 flex-1 space-y-3">
              <ScanSteps platform={activePlatform} scanType={qqScanType} />
              <p aria-live="polite" className="text-sm">
                {qrStatus}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={refreshQr}
                disabled={busy}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                刷新二维码
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
          服务器不会保存账号信息。账号信息仅保存在登录者浏览器，在房间中临时加载到服务器内存，按你的共享开关供本房取歌；关掉开关、离开房间或房间关闭即销毁。
        </span>
      </p>
    </SettingsAccordion>
  );
}
