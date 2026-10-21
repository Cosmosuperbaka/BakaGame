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
