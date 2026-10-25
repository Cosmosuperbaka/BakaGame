import { useState } from "react";
import { Bot, Check, Copy, Lock } from "lucide-react";
import { SettingsAccordion } from "@/components/common/room/SettingsAccordion";
import { SettingSwitchRow } from "@/components/common/room/SettingFields";
import { Button } from "@/components/ui/Button";
import { MCP_ENDPOINT_PATH } from "@/lib/McpConfig";
import { isBakaClient } from "@/lib/BakaChannel";
import { SITE_ORIGIN } from "@/data/PageMeta";
import { getSessionToken, getSonGuessrSessionToken } from "@/lib/Storage";
import { readCEESession } from "@/lib/CEESession";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { useCEEStore } from "@/stores/UseCEEStore";

type GameId = "faker" | "song" | "cee";

const useControlled = (game: GameId): boolean => {
  const faker = useWhoIsFakerStore((state) => state.privateState?.mcpControlled === true);
  const song = useSonGuessrStore((state) => state.privateState?.mcpControlled === true);
  const cee = useCEEStore((state) => state.privateState?.mcpControlled === true);
  return game === "faker" ? faker : game === "song" ? song : cee;
};

const readSeatToken = (game: GameId, roomId: string): string | null => {
  if (game === "faker") return getSessionToken(roomId);
  if (game === "song") return getSonGuessrSessionToken(roomId);
  return readCEESession(roomId);
};

const sendForGame = async (
  game: GameId,
  type: string,
  payload: Record<string, unknown> = {}
) => {
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

const buildPrompt = (game: GameId, roomId: string, token: string): string => {
  // 原生壳的页面 origin 是本地资源地址，外部 Agent 不可达；固定用公开站点。
  const origin =
    typeof window === "undefined"
      ? SITE_ORIGIN
      : isBakaClient()
        ? SITE_ORIGIN
        : window.location.origin;
  return `请读取 ${origin}/llms.txt，并使用远程 MCP 连接 ${origin}${MCP_ENDPOINT_PATH}。 调用 claim_seat({ game: "${game}", roomId: "${roomId}", sessionToken: "${token}" }) 接入房间之后只作为 Agent 自行游玩`;
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
      description="开启后大厅显示 MCP 徽标；Agent 可以用你的会话凭证接手座位。"
      icon={Bot}
      checked={allowAgents}
      onCheckedChange={onChange}
      disabled={pending}
    />
  );
}

function McpStatusPanel({
  allowAgents,
  controlled,
  token,
  prompt,
  copied,
  onCopy,
}: {
  allowAgents: boolean;
  controlled: boolean;
  token: string | null;
  prompt: string;
  copied: boolean;
  onCopy: () => void;
}) {
  if (!allowAgents)
    return (
      <p className="text-xs text-muted-foreground">
        开启后才能生成接入 Prompt。Agent 读取的信息不会超过你本人能看到的范围。
      </p>
    );
  if (controlled)
    return (
      <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Lock aria-hidden="true" className="h-4 w-4" />
          Agent 已接入本座位
        </p>
        <p className="text-xs text-muted-foreground">
          你的手动操作已全部锁定；Agent 收回控制或断线后恢复。会话凭证仍可用于重新接入，离开房间后旧凭证失效。
        </p>
      </div>
    );
  if (!token)
    return (
      <p className="text-xs text-muted-foreground">
        当前还没有房间会话凭证；进入房间后再打开这里生成 Prompt。
      </p>
    );
  return (
    <div className="space-y-2">
      <p className="text-xs leading-5 text-muted-foreground">
        把下面的 Prompt 发给 Agent。它会用你的会话凭证接手座位；凭证等同于座位控制权，只发给可信 Agent。
      </p>
      <div className="rounded-sm border border-border bg-muted/40 p-2.5 font-mono text-[11px] leading-5 text-muted-foreground">
        {prompt}
      </div>
      <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onCopy}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? "已复制" : "复制接入 Prompt"}
      </Button>
    </div>
  );
}

function McpSettingsBody({
  game,
  roomId,
  allowAgents,
  isHost,
  controlled,
}: {
  game: GameId;
  roomId: string;
  allowAgents: boolean;
  isHost: boolean;
  controlled: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const token = readSeatToken(game, roomId);
  const prompt = token ? buildPrompt(game, roomId, token) : "";

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

  const copyPrompt = () => {
    const writing = navigator.clipboard?.writeText(prompt);
    if (writing === undefined) return;
    void writing.then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="space-y-4">
      <McpToggle
        isHost={isHost}
        allowAgents={allowAgents}
        pending={pending}
        onChange={(value) => void changeAllowAgents(value)}
      />
      <McpStatusPanel
        allowAgents={allowAgents}
        controlled={controlled}
        token={token}
        prompt={prompt}
        copied={copied}
        onCopy={copyPrompt}
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
 * 独立的 MCP 设置项：房间开关、会话凭证 Prompt 与接管状态都收在这里，
 * 不再出现在建房弹窗或通用房间设置里，也不向玩家展示接入文档。
 */
export function McpSettingsSection({
  game,
  roomId,
  allowAgents,
  isHost,
}: {
  game: GameId;
  roomId: string;
  allowAgents: boolean;
  isHost: boolean;
}) {
  const controlled = useControlled(game);
  const [open, setOpen] = useState(false);

  return (
    <SettingsAccordion
      icon={Bot}
      title="MCP 设置"
      summary={[allowAgents ? "MCP 可用" : "MCP 关闭", controlled ? "Agent 已接入" : "未接入"]}
      open={open}
      onOpenChange={setOpen}
      readOnly={!isHost}
    >
      <McpSettingsBody
        game={game}
        roomId={roomId}
        allowAgents={allowAgents}
        isHost={isHost}
        controlled={controlled}
      />
    </SettingsAccordion>
  );
}
