import type { GameId } from "@bakagame/shared";
import { useState } from "react";
import { Bot } from "lucide-react";
import { McpPairingPanel } from "@/components/common/McpPairingPanel";
import { SettingsAccordion } from "@/components/common/room/SettingsAccordion";
import { SettingSwitchRow } from "@/components/common/room/SettingFields";
import { usePageControl } from "@/stores/UsePageControl";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { useCEEStore } from "@/stores/UseCEEStore";

const sendForGame = async (game: GameId, type: string, payload: Record<string, unknown> = {}) => {
  if (game === "faker")
    return useWhoIsFakerStore.getState().sendCommand(type as never, payload as never);
  if (game === "song")
    return useSonGuessrStore.getState().sendCommand(type as never, payload as never);
  return useCEEStore.getState().sendCommand(type as never, payload as never);
};

const updateAllowAgents = async (game: GameId, value: boolean): Promise<void> => {
  if (game === "faker") {
    await sendForGame(game, "room.updateSettings", { allowAgents: value });
    return;
  }
  if (game === "song") {
    await sendForGame(game, "song.room.updateSettings", { allowAgents: value });
    return;
  }
  const snapshot = useCEEStore.getState().snapshot;
  if (!snapshot) throw new Error("尚未收到房间快照");
  await sendForGame(game, "cee.room.settings", {
    settings: { ...snapshot.settings, allowAgents: value },
  });
};

const errorMessage = (failure: unknown, fallback: string): string =>
  (failure as { message?: string } | null)?.message ?? fallback;

function McpToggle({
  isHost,
  allowAgents,
  pending,
  onChange,
}: {
  isHost: boolean;
  allowAgents: boolean;
  pending: boolean;
  onChange: (value: boolean) => void;
}) {
  if (!isHost)
    return (
      <p className="text-xs text-muted-foreground">
        {allowAgents ? "房主已开启 MCP 接入。" : "房主尚未开启 MCP 接入。"}
      </p>
    );
  return (
    <SettingSwitchRow
      label="允许 MCP 接入"
      description="开启后大厅显示 MCP 徽标；房内玩家可以把自己的标签页交给 Agent 操作。"
      icon={Bot}
      checked={allowAgents}
      onCheckedChange={onChange}
      disabled={pending}
    />
  );
}

function McpSettingsBody({
  game,
  allowAgents,
  isHost,
}: {
  game: GameId;
  allowAgents: boolean;
  isHost: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const changeAllowAgents = async (value: boolean) => {
    setPending(true);
    setError("");
    try {
      await updateAllowAgents(game, value);
    } catch (failure) {
      setError(errorMessage(failure, "保存 MCP 设置失败"));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-4">
      <McpToggle
        isHost={isHost}
        allowAgents={allowAgents}
        pending={pending}
        onChange={(value) => void changeAllowAgents(value)}
      />
      <McpPairingPanel
        {...(allowAgents ? {} : { blockedReason: "开启 MCP 后才能交给 Agent。" })}
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 房间的 MCP 设置项：房主的房间开关在这里，交给 Agent 的入口与任何页面是同一块，
 * 不再出现在建房弹窗或通用房间设置里，也不向玩家展示接入文档。
 */
export function McpSettingsSection({
  game,
  allowAgents,
  isHost,
}: {
  game: GameId;
  allowAgents: boolean;
  isHost: boolean;
}) {
  const { status } = usePageControl();
  const [open, setOpen] = useState(false);

  return (
    <SettingsAccordion
      icon={Bot}
      title="MCP 设置"
      summary={[
        allowAgents ? "MCP 可用" : "MCP 关闭",
        status === "controlled" ? "Agent 操作中" : "未接管",
      ]}
      open={open}
      onOpenChange={setOpen}
      readOnly={!isHost}
    >
      <McpSettingsBody game={game} allowAgents={allowAgents} isHost={isHost} />
    </SettingsAccordion>
  );
}
