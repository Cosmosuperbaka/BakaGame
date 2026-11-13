import { useEffect, useState, type ComponentType } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { LogOut, QrCode, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CollapsibleRegion } from "@/components/ui/Collapsible";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Spinner } from "@/components/ui/Spinner";
import { Hint } from "@/components/ui/Tooltip";
import { SettingSwitchRow } from "@/components/common/room/settings/ChoiceFields";
import { SettingsAccordion } from "@/components/common/room/SettingsAccordion";
import { NeteaseCloudMusicIcon, QQMusicIcon } from "@/components/common/MusicPlatformIcons";
import {
  clearStoredSongMusicSession,
  saveSongMusicSession,
  type SongMusicPlatform,
  type StoredSongMusicSession,
} from "@/lib/SonGuessrMusicSession";
import { readoutSwap } from "@/lib/Motion";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { vipBadge, vipText } from "./SongAccountBadges";
import { errorMessage } from "./SongErrorMessage";
import { SONG_PLATFORM_NAME, type QqScanMode, type QrCreateResponse } from "./SongQrLogin";
import { useSongQrLogin } from "./UseSongQrLogin";
import { useSongStoredMusicSession } from "./UseSongStoredMusicSession";
import { AccountAvatar, VipStatus } from "./SongAccountIdentity";
import type {
  SonGuessrMusicAccount,
  SonGuessrMusicPoolView,
  SonGuessrPlayerView,
  SonGuessrRoomSnapshot,
} from "@bakagame/shared";

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

/** 各平台在面板里的图标与分段标签；提示文案里的称呼见 SONG_PLATFORM_NAME。 */
const PLATFORM_META: Record<
  SongMusicPlatform,
  { tabLabel: string; Icon: ComponentType<{ className?: string }> }
> = {
  netease: { tabLabel: "网易云音乐", Icon: NeteaseCloudMusicIcon },
  qq: { tabLabel: "QQ音乐", Icon: QQMusicIcon },
};
const PLATFORMS: readonly SongMusicPlatform[] = ["netease", "qq"];

function PlatformIcon({ platform, className }: { platform: SongMusicPlatform; className: string }) {
  const { Icon } = PLATFORM_META[platform];
  return <Icon className={className} />;
}

/**
 * 平台切换器：分段单选，选中的那一端决定下方展示哪份账号信息与哪一条登录二维码。
 * 该端凭据已加载到房间时在标签后点一枚绿点；绿点只是提示，读屏改读 `sr-only` 的文字，
 * 不让颜色单独承担状态（DesignGuide §3）。
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
      options={PLATFORMS.map((platform) => ({
        value: platform,
        label: (
          <span className="flex items-center gap-1.5">
            <PlatformIcon platform={platform} className="size-3.5" />
            <span>{PLATFORM_META[platform].tabLabel}</span>
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
  const showToast = useSonGuessrStore((state) => state.showToast);
  const [sharingBusy, setSharingBusy] = useState(false);
  const setSharing = async (platform: SongMusicPlatform, enabled: boolean) => {
    setSharingBusy(true);
    try {
      await sendCommand("song.auth.setPoolSharing", { platform, enabled });
    } catch (error) {
      showToast(errorMessage(error, "切换账号共享失败，请重试"), "error");
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
  const showToast = useSonGuessrStore((state) => state.showToast);
  const [open, setOpen] = useState(false);
  const [activePlatform, setActivePlatform] = useState<SongMusicPlatform>("netease");
  const [qqScanType, setQqScanType] = useState<QqScanMode>("qq");

  const storedNetease = useSongStoredMusicSession("netease");
  const storedQq = useSongStoredMusicSession("qq");
  const [remember, setRemember] = useState<Record<SongMusicPlatform, boolean>>(() => ({
    netease: storedNetease?.persistent ?? true,
    qq: storedQq?.persistent ?? true,
  }));
  const { sharingBusy, setSharing } = usePoolSharing();
  const {
    qr,
    status: qrStatus,
    busy,
    login,
  } = useSongQrLogin({
    send: sendCommand,
    onAuthorized: (platform, session) => {
      const account =
        platform === "qq" ? { ...session.account, platform: "qq" as const } : session.account;
      saveSongMusicSession({ cookie: session.cookie, account }, remember[platform], platform);
      showToast(`${SONG_PLATFORM_NAME[platform]}账号已加载到当前房间`, "success");
    },
    onCreateFailed: (message) => showToast(message, "error"),
  });

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

  useEffect(() => {
    if (!open || !showQr || !qr) return;
    const timer = window.setInterval(() => void login.check(activePlatform, qqScanType), 2_000);
    return () => window.clearInterval(timer);
  }, [activePlatform, login, open, qqScanType, qr, showQr]);

  const refreshQr = () => {
    login.cancel();
    void login.start(activePlatform, qqScanType);
  };

  const switchPlatform = (platform: SongMusicPlatform) => {
    if (platform === activePlatform) return;
    login.cancel();
    setActivePlatform(platform);
    const targetStored = platform === "qq" ? storedQq : storedNetease;
    if (!targetStored && open) {
      void login.start(platform, qqScanType);
    }
  };

  const handleQqScanTypeChange = (mode: QqScanMode) => {
    if (mode === qqScanType) return;
    setQqScanType(mode);
    login.cancel();
    if (open && activePlatform === "qq" && !storedQq) {
      void login.start("qq", mode);
    }
  };

  /** 退出登录：清掉当前平台房间里的凭据与本机存储；服务端没清掉就什么都不动，让玩家重试。 */
  const logout = async () => {
    const platform = activePlatform;
    const outcome = await login.clear(platform);
    if (outcome === "superseded") return;
    if (outcome === "failed") {
      // 号还在账号池里被房内共享，本机凭据也留着，不能谎称已退出。
      showToast("退出失败，请重试", "error");
      return;
    }
    clearStoredSongMusicSession(platform);
    showToast(`已退出${SONG_PLATFORM_NAME[platform]}账号`, "success");
    if (open) void login.start(platform, qqScanType);
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
    const { Icon } = PLATFORM_META[platform];
    const iconClass = "size-3.5 shrink-0";

    const platformName = SONG_PLATFORM_NAME[platform];

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
      login.cancel();
      setOpen(false);
      return;
    }
    setOpen(true);
    if (showQr && !qr && !busy) void login.start(activePlatform, qqScanType);
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
              正在连接{SONG_PLATFORM_NAME[activePlatform]}账号…
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
            <QrFrame qr={qr} busy={busy} alt={`${SONG_PLATFORM_NAME[activePlatform]}登录二维码`} />
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
            description="仅保存在当前浏览器；登录本站并开启云同步时，会加密存入你的云端设置，换设备自动登录。关闭则只在本标签页有效，不会上传"
            checked={remember[activePlatform]}
            onCheckedChange={(value) =>
              setRemember((current) => ({ ...current, [activePlatform]: value }))
            }
          />
        </div>
      </CollapsibleRegion>

      <p className="mt-4 flex gap-2 border-t pt-4 text-2xs leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
        <span>
          房间不会保存账号信息。账号信息保存在登录者浏览器，在房间中临时加载到服务器内存，按你的共享开关供本房取歌；关掉开关、离开房间或房间关闭即销毁。只有登录本站、开启云同步并保存登录状态时，才会加密存入你的云端设置。
        </span>
      </p>
    </SettingsAccordion>
  );
}
