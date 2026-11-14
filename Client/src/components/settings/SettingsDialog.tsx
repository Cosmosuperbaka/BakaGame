import { useEffect, useId } from "react";
import { Bot, Check, Cloud, Copy, SunMoon, Volume2 } from "lucide-react";
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
import { McpPairingPanel } from "@/components/common/McpPairingPanel";
import { SettingsSection } from "@/components/common/room/settings/Layout";
import { SettingSwitchRow } from "@/components/common/room/settings/ChoiceFields";
import { useCopyFeedback } from "@/hooks/UseCopyFeedback";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";
import { setCloudSyncEnabled, useCloudSyncEnabled } from "@/lib/CloudSync";
import { mcpEndpoint } from "@/lib/McpConfig";
import { useSiteLinkConnected } from "@/lib/SiteWs";
import { usePageControl } from "@/stores/UsePageControl";
import {
  setSoundEnabled,
  setSoundVolume,
  useSoundEnabled,
  useSoundVolume,
} from "@/lib/SoundEffects";
import { setThemePreference, useThemePreference, type ThemePreference } from "@/lib/Theme";
import type { OriginPoint } from "@/lib/motion/Origin";
import { useAccountStore } from "@/stores/UseAccountStore";

const THEME_OPTIONS: SegmentedOption<ThemePreference>[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

/** 连接信息：站点连接的当前状态、远程端点与取用方式，与当前在哪个页面无关。 */
function McpConnectionDetails({ connected }: { connected: boolean }) {
  const { copied: copiedKey, copy } = useCopyFeedback();
  const copied = copiedKey !== null;
  const endpoint = mcpEndpoint();

  const copyEndpoint = () => void copy(endpoint);

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
        <Button type="button" variant="ghost" size="xs" className="gap-1.5" onClick={copyEndpoint}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "已复制" : "复制地址"}
        </Button>
      </div>
      <p className="mt-1 break-all font-mono text-xs leading-5 text-foreground">{endpoint}</p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Agent 从站点发现文件读到这个端点；要操作这张标签页还需要上面的配对码。
      </p>
    </div>
  );
}

/** 交给 Agent 的入口在任何页面都是这一块；房间只多一条房主开关的限制。 */
function McpSection({ agentsBlocked }: { agentsBlocked?: boolean }) {
  const connected = useSiteLinkConnected();
  return (
    <SettingsSection title="MCP 连接" icon={Bot}>
      <McpPairingPanel
        {...(agentsBlocked
          ? { blockedReason: "本房间未开启 MCP，房主开启后才能交给 Agent。" }
          : {})}
      />
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
        {/* 读数随标签一起置灰：提示音关掉后只淡了「音量」二字、百分比仍是满色，读起来像还能调。 */}
        <span
          aria-hidden="true"
          className={
            disabled
              ? "text-xs font-semibold tabular-nums text-muted-foreground opacity-50"
              : "text-xs font-semibold tabular-nums text-muted-foreground"
          }
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
    // 云同步绑定账号：Agent 不替人类改账号相关的设置。
    <SettingsSection title="云同步" icon={Cloud} agentSensitive>
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
  agentsBlocked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  origin?: OriginPoint | null;
  /** 在房间内打开时由房间顶栏按各自房主开关算出：没开 MCP 就不能交给 Agent。 */
  agentsBlocked?: boolean;
}) {
  const soundEnabled = useSoundEnabled();
  const { status } = usePageControl();

  // 配对成功后页面归 Agent，设置面板留着只会挡住它要操作的内容。
  useEffect(() => {
    if (status === "controlled") onOpenChange(false);
  }, [status, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} origin={origin}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>偏好保存在本机。</DialogDescription>
        </DialogHeader>

        <div>
          <McpSection agentsBlocked={agentsBlocked} />

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

          {/* 敏感标记落在节上：再套一层包装会让它成为「第一节」，丢掉分隔线与上间距。 */}
          <CloudSyncSection />
        </div>
      </DialogContent>
    </Dialog>
  );
}
