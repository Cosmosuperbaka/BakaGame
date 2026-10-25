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
import {
  MCP_ENDPOINT_PATH,
  setMcpNewRoomAllowed,
  useMcpNewRoomAllowed,
  type McpGameId,
} from "@/lib/McpConfig";
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
 * 复制给 Agent 的公开端点：与房间 MCP 设置生成的 Prompt 同一口径。
 * 壳内的页面 origin 是本地资源地址，必须写站点地址；网页则用当前站点 origin。
 */
const mcpEndpoint = (): string => {
  const origin =
    typeof window === "undefined"
      ? SITE_ORIGIN
      : isBakaClient()
        ? SITE_ORIGIN
        : window.location.origin;
  return `${origin}${MCP_ENDPOINT_PATH}`;
};

function McpConnectionDetails() {
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
        <span className="text-xs text-muted-foreground">远程 MCP 端点</span>
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
        Agent 从站点发现文件找到这个端点；接入房间还需要房主开启 MCP，并生成带座位凭证的 Prompt。
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
  const fakerAllowed = useWhoIsFakerStore(
    (state) => state.snapshot?.settings.allowAgents === true
  );
  const fakerControlled = useWhoIsFakerStore(
    (state) => state.privateState?.mcpControlled === true
  );
  const songAllowed = useSonGuessrStore(
    (state) => state.snapshot?.settings.allowAgents === true
  );
  const songControlled = useSonGuessrStore(
    (state) => state.privateState?.mcpControlled === true
  );
  const ceeAllowed = useCEEStore((state) => state.snapshot?.settings.allowAgents === true);
  const ceeControlled = useCEEStore((state) => state.privateState?.mcpControlled === true);
  if (!game) return null;
  if (game === "faker") return { allowed: fakerAllowed, controlled: fakerControlled };
  if (game === "song") return { allowed: songAllowed, controlled: songControlled };
  return { allowed: ceeAllowed, controlled: ceeControlled };
}

function RoomMcpSection({ game }: { game: McpGameId }) {
  const info = useRoomMcpInfo(game);
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
      <McpConnectionDetails />
    </SettingsSection>
  );
}

function LobbyMcpSection() {
  const mcpNewRoomAllowed = useMcpNewRoomAllowed();
  return (
    <SettingsSection title="MCP 连接" icon={Bot}>
      <SettingSwitchRow
        label="允许 MCP 接入本会话"
        description="开启后，本会话新建的房间默认允许 MCP 接入；已建房间仍由房主在房间设置里决定。"
        checked={mcpNewRoomAllowed}
        onCheckedChange={setMcpNewRoomAllowed}
      />
      <Collapsible title="连接详情" size="sm">
        <McpConnectionDetails />
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
