import { useEffect, useId, useState } from "react";
import { Bot, Check, Cloud, Copy, Lock, SunMoon, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Collapsible } from "@/components/ui/Collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Slider } from "@/components/ui/Slider";
import { SettingsSection, SettingSwitchRow } from "@/components/common/room/SettingFields";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";
import { isBakaClient } from "@/lib/BakaChannel";
import { setCloudSyncEnabled, useCloudSyncEnabled } from "@/lib/CloudSync";
import { MCP_ENDPOINT_PATH, type McpGameId } from "@/lib/McpConfig";
import {
  closePageControl,
  openPageControl,
  SITE_WS_PATH,
  useSiteLinkConnected,
} from "@/lib/SiteWs";
import { usePageControl } from "@/stores/UsePageControl";
import {
  setSoundEnabled,
  setSoundVolume,
  useSoundEnabled,
  useSoundVolume,
} from "@/lib/SoundEffects";
import { setThemePreference, useThemePreference, type ThemePreference } from "@/lib/Theme";
import type { OriginPoint } from "@/lib/Motion";
import { useAccountStore } from "@/stores/UseAccountStore";
import { useCEEStore } from "@/stores/UseCEEStore";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { SITE_ORIGIN } from "@/data/PageMeta";

const THEME_OPTIONS: SegmentedOption<ThemePreference>[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

/**
 * 站点根地址：壳内的页面 origin 是本地资源地址，必须写站点地址；网页则用当前站点 origin。
 */
const siteOrigin = (): string => {
  if (typeof window === "undefined") return SITE_ORIGIN;
  return isBakaClient() ? SITE_ORIGIN : window.location.origin;
};

/** 复制给 Agent 的公开端点：与房间 MCP 设置生成的 Prompt 同一口径。 */
const mcpEndpoint = (): string => `${siteOrigin()}${MCP_ENDPOINT_PATH}`;

/** 交给 Agent 的接管指令：端点 + 这把一次性配对码，别的一概不需要。 */
const pageControlPrompt = (code: string): string =>
  `请读取 ${siteOrigin()}/llms.txt，并用远程 MCP 连接 ${mcpEndpoint()}。` +
  ` 调用 control_page({ code: "${code}" }) 接管我当前的页面，之后用 page_act 导航或点击，把页面带进我想玩的游戏。`;

/**
 * 连接信息：站点连接的当前状态、远程端点与取用方式。
 * 房间内与首页共用同一块——它描述的是**站点级**链路，与当前在哪个房间无关。
 */
function McpConnectionDetails({ connected }: { connected: boolean }) {
  const [copied, setCopied] = useState(false);
  const endpoint = mcpEndpoint();

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyEndpoint = () => {
    const writing = navigator.clipboard?.writeText(endpoint);
    if (writing === undefined) return;
    void writing.then(
      () => setCopied(true),
      () => {}
    );
  };

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden="true"
            className={
              connected
                ? "h-1.5 w-1.5 shrink-0 rounded-full bg-success"
                : "h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40"
            }
          />
          站点连接 · {connected ? "已连接" : "未连接"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={copyEndpoint}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "已复制" : "复制地址"}
        </Button>
      </div>
      <p className="mt-1 break-all font-mono text-xs leading-5 text-foreground">{endpoint}</p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Agent 从站点发现文件读到这个端点；接入房间还要房主开启 MCP，并拿到带座位凭证的 Prompt。
      </p>
    </div>
  );
}

/**
 * 房间内的 MCP 连接状态：开关与凭证 Prompt 归房间的「MCP 设置」，
 * 全局设置只回答「这个房间能不能接入、现在有没有 Agent 接手」。
 */
function useRoomMcpInfo(game: McpGameId | undefined): {
  allowed: boolean;
  controlled: boolean;
} | null {
  const fakerAllowed = useWhoIsFakerStore((state) => state.snapshot?.settings.allowAgents === true);
  const fakerControlled = useWhoIsFakerStore((state) => state.privateState?.mcpControlled === true);
  const songAllowed = useSonGuessrStore((state) => state.snapshot?.settings.allowAgents === true);
  const songControlled = useSonGuessrStore((state) => state.privateState?.mcpControlled === true);
  const ceeAllowed = useCEEStore((state) => state.snapshot?.settings.allowAgents === true);
  const ceeControlled = useCEEStore((state) => state.privateState?.mcpControlled === true);
  if (!game) return null;
  if (game === "faker") return { allowed: fakerAllowed, controlled: fakerControlled };
  if (game === "song") return { allowed: songAllowed, controlled: songControlled };
  return { allowed: ceeAllowed, controlled: ceeControlled };
}

function RoomMcpSection({ game }: { game: McpGameId }) {
  const info = useRoomMcpInfo(game);
  const connected = useSiteLinkConnected();
  // 房间没开 MCP 也没有 Agent 接手时没有可展示的连接信息，整组让位给本机偏好。
  if (!info || (!info.allowed && !info.controlled)) return null;
  const StatusIcon = info.controlled ? Lock : Bot;
  return (
    <SettingsSection title="MCP 连接" icon={Bot}>
      <div className="flex items-start gap-2">
        <StatusIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {info.controlled ? "Agent 已接入本座位" : "本房间已允许 MCP 接入"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {info.controlled
              ? "你的手动操作已锁定；Agent 释放控制或断线后恢复。"
              : "尚未有 Agent 接管座位；带会话凭证的接入 Prompt 在房间等待页的「MCP 设置」里生成。"}
          </p>
        </div>
      </div>
      <McpConnectionDetails connected={connected} />
    </SettingsSection>
  );
}

/** 配对码区块：人类把它（或整段指令）交给 Agent；页面侧不落盘、刷新即失效。 */
function PageCodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState<"code" | "prompt" | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1_600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = (kind: "code" | "prompt", text: string) => {
    const writing = navigator.clipboard?.writeText(text);
    if (writing === undefined) return;
    void writing.then(
      () => setCopied(kind),
      () => {}
    );
  };

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">配对码 · 5 分钟内有效</span>
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => copy("code", code)}
          >
            {copied === "code" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied === "code" ? "已复制" : "复制码"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => copy("prompt", pageControlPrompt(code))}
          >
            {copied === "prompt" ? <Check aria-hidden="true" /> : <Bot aria-hidden="true" />}
            {copied === "prompt" ? "已复制" : "复制指令"}
          </Button>
        </div>
      </div>
      <p className="mt-1 font-mono text-base font-semibold tracking-code text-foreground">
        {code}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        把码或整段指令交给 Agent；它认领后就能导航与点击这台浏览器，你随时可以收回。
      </p>
    </div>
  );
}

function LobbyMcpSection() {
  const { status, code, agentName } = usePageControl();
  const connected = useSiteLinkConnected();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const toggle = (next: boolean) => {
    setBusy(true);
    setFailure(null);
    const task = next ? openPageControl() : closePageControl();
    void task
      .catch((error: unknown) => {
        setFailure((error as { message?: string } | null)?.message ?? "操作失败，请重试");
      })
      .finally(() => setBusy(false));
  };

  return (
    <SettingsSection title="MCP 连接" icon={Bot}>
      <SettingSwitchRow
        label="允许 Agent 接管本页"
        description={`开启后生成一次性配对码，Agent 凭它驱动这台浏览器；指令只走站点通道（${SITE_WS_PATH}）。`}
        checked={status !== "off"}
        onCheckedChange={toggle}
        disabled={busy}
      />
      {status === "controlled" ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3">
          <Lock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{agentName || "Agent"} 正在接管本页</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              它会替你导航、点按钮；想自己操作就收回控制，配对码随即作废。
            </p>
          </div>
        </div>
      ) : null}
      {code ? <PageCodeBlock code={code} /> : null}
      {failure ? (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      ) : null}
      <Collapsible title="连接信息" size="sm">
        <McpConnectionDetails connected={connected} />
      </Collapsible>
    </SettingsSection>
  );
}

function ThemeField() {
  const theme = useThemePreference();
  const labelId = useId();
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span id={labelId} className="font-serif text-sm leading-snug">
          主题
        </span>
        <SegmentedControl
          aria-labelledby={labelId}
          value={theme}
          options={THEME_OPTIONS}
          onValueChange={setThemePreference}
          size="sm"
        />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        深色模式或跟随设备外观，切换立即生效。
      </p>
    </div>
  );
}

function SoundVolumeField({ disabled }: { disabled: boolean }) {
  const volume = useSoundVolume();
  const labelId = useId();
  const percentage = Math.round(volume * 100);
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span
          id={labelId}
          className={
            disabled
              ? "font-serif text-sm leading-snug opacity-50"
              : "font-serif text-sm leading-snug"
          }
        >
          音量
        </span>
        <span
          aria-hidden="true"
          className="text-xs font-semibold tabular-nums text-muted-foreground"
        >
          {percentage}%
        </span>
      </div>
      <Slider
        value={[percentage]}
        min={0}
        max={100}
        step={5}
        disabled={disabled}
        onValueChange={([next]) => setSoundVolume((next ?? 0) / 100)}
        aria-labelledby={labelId}
        aria-valuetext={`${percentage}%`}
        className="h-6"
      />
    </div>
  );
}

function CloudSyncSection() {
  const enabled = useCloudSyncEnabled();
  const status = useAccountStore((state) => state.status);
  return (
    <SettingsSection title="云同步" icon={Cloud}>
      <SettingSwitchRow
        label="启用云同步"
        description="登录后同步昵称、房间设置记忆与音乐账号；关闭即停止读写云端。"
        checked={enabled}
        onCheckedChange={setCloudSyncEnabled}
      />
      {status === "guest" || status === "unavailable" ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          当前未登录；登录后会按这个开关决定是否同步。
        </p>
      ) : null}
    </SettingsSection>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
  origin,
  game,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  origin?: OriginPoint | null;
  /** 在房间内打开时传入当前游戏，MCP 分区改为只读的连接信息。 */
  game?: McpGameId;
}) {
  const soundEnabled = useSoundEnabled();

  return (
    <Dialog open={open} onOpenChange={onOpenChange} origin={origin}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>偏好保存在本机。</DialogDescription>
        </DialogHeader>

        <div>
          {game ? <RoomMcpSection game={game} /> : <LobbyMcpSection />}

          <SettingsSection title="外观" icon={SunMoon}>
            <ThemeField />
          </SettingsSection>

          <SettingsSection title="音效" icon={Volume2}>
            <SettingSwitchRow
              label="提示音"
              description="行动与聊天提示音；猜歌播放音量仍在猜歌房间顶栏调节。"
              checked={soundEnabled}
              onCheckedChange={setSoundEnabled}
            />
            <SoundVolumeField disabled={!soundEnabled} />
          </SettingsSection>

          <CloudSyncSection />
        </div>
      </DialogContent>
    </Dialog>
  );
}
