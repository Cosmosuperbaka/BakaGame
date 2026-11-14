import { useState } from "react";
import { Bot } from "lucide-react";
import { McpPairingPanel } from "@/components/common/McpPairingPanel";
import { SettingsAccordion } from "@/components/common/room/SettingsAccordion";
import { SettingSwitchRow } from "@/components/common/room/settings/ChoiceFields";
import { usePageControl } from "@/stores/UsePageControl";

// 房间命令的失败是协议错误体（普通对象），不是 ORPCError，文案直接取 message。
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
  allowAgents,
  isHost,
  onChangeAllowAgents,
}: {
  allowAgents: boolean;
  isHost: boolean;
  onChangeAllowAgents: (value: boolean) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const changeAllowAgents = async (value: boolean) => {
    setPending(true);
    setError("");
    try {
      await onChangeAllowAgents(value);
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
      <McpPairingPanel {...(allowAgents ? {} : { blockedReason: "开启 MCP 后才能交给 Agent。" })} />
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
 * 整组不设只读：配对是每位玩家自己的事，房主开关对非房主本来就只是一行说明。
 * 保存路径由各玩法的等待页给出：三款玩法的房间设置命令与载荷形状不同，公共块不该认识它们。
 */
export function McpSettingsSection({
  allowAgents,
  isHost,
  onChangeAllowAgents,
}: {
  allowAgents: boolean;
  isHost: boolean;
  onChangeAllowAgents: (value: boolean) => Promise<void>;
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
    >
      <McpSettingsBody
        allowAgents={allowAgents}
        isHost={isHost}
        onChangeAllowAgents={onChangeAllowAgents}
      />
    </SettingsAccordion>
  );
}
