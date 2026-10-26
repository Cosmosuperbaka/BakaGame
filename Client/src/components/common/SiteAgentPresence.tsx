import { motion } from "framer-motion";
import { Bot } from "lucide-react";
import { agentActivityLabel } from "@/lib/AgentActivityLabel";
import { useSiteAgents } from "@/stores/UseSiteAgents";

/** 同时最多展示两条；更多的折成 `+N`，不在首页堆一长串。 */
const MAX_VISIBLE = 2;

/**
 * 首页的 Agent 在线指示：证明「MCP 在首页就连上了」，也把 Agent 的当前位置亮给人类。
 * 没有 Agent 时不占任何布局高度。
 */
export function SiteAgentPresence() {
  const agents = useSiteAgents();
  if (agents.length === 0) return null;
  const visible = agents.slice(0, MAX_VISIBLE);
  const hidden = agents.length - visible.length;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      aria-live="polite"
      className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 pt-1 text-[11px] text-muted-foreground"
    >
      <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
      </span>
      {visible.map((agent) => (
        <span key={agent.id} className="inline-flex max-w-[15rem] items-center gap-1">
          <Bot className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
          <span className="truncate font-medium text-foreground/70">{agent.agentName}</span>
          <span className="truncate">{agentActivityLabel(agent.kind, agent.label)}</span>
        </span>
      ))}
      {hidden > 0 ? <span className="opacity-70">+{hidden}</span> : null}
    </motion.div>
  );
}
