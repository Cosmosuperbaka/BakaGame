import { Bot } from "lucide-react";
import { PLAYER_BADGE_BASE } from "@/components/common/PlayerStatusPill";
import { cn } from "@/lib/Utils";

/**
 * 两枚徽标与状态胶囊共用 `PLAYER_BADGE_BASE`：同字号、同内边距、无描边，并排时一样高。
 * 底色取 secondary，与状态胶囊的语义色调区分开：这是「谁在玩」的身份，不是「在干什么」的状态。
 * 图标收到 2.5（与 2xs 字号同高），不把徽标撑得比旁边的胶囊高一截。
 */
const AGENT_BADGE = cn(PLAYER_BADGE_BASE, "bg-secondary font-medium text-secondary-foreground");

/** 明确标出 Agent 玩家：不伪装成真人。 */
export function AgentBadge() {
  return (
    <span className={AGENT_BADGE}>
      <Bot aria-hidden="true" className="size-2.5" />
      Agent
    </span>
  );
}

/** 人类座位被 MCP 接管：与 Agent 徽标区分开，说明是「托管」而不是另一个机器人玩家。 */
export function McpControlledBadge() {
  return (
    <span className={AGENT_BADGE}>
      <Bot aria-hidden="true" className="size-2.5" />
      MCP
    </span>
  );
}
