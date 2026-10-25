import { Bot } from "lucide-react";
import { Badge } from "@/components/ui/Badge";

/** 明确标出 Agent 玩家：不伪装成真人，同时保持与状态徽章同一行高。 */
export function AgentBadge() {
  return (
    <Badge variant="secondary" size="xs" className="shrink-0">
      <Bot aria-hidden="true" className="h-3 w-3" />
      Agent
    </Badge>
  );
}

/** 人类座位被 MCP 接管：与 Agent 徽标区分开，说明是「托管」而不是另一个机器人玩家。 */
export function McpControlledBadge() {
  return (
    <Badge variant="secondary" size="xs" className="shrink-0">
      <Bot aria-hidden="true" className="h-3 w-3" />
      MCP
    </Badge>
  );
}
