import { motion } from "framer-motion";
import { Eye, UserCheck } from "lucide-react";
import { listContainer, listItem, selectable } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/** 区块小标题。`hint` 是右侧的补充说明，缺省时右侧留空。 */
export function SectionHeader({
  title,
  icon,
  hint,
}: {
  title: string;
  icon?: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-2.5 px-1">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {icon ?? <UserCheck className="h-3.5 w-3.5" />}
        {title}
      </div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/**
 * 候选玩家网格。`nameWrap` 必填且无默认值：`break-words` 不参与最小内容宽度计算，
 * 长名字会把网格轨道撑宽，与 `truncate` 的呈现不同，因此由调用方显式声明。
 */
export function CandidateGrid({
  candidates,
  tone,
  nameWrap,
  onPick,
}: {
  candidates: Array<{ id: string; name: string }>;
  tone: "recommended" | "default";
  nameWrap: "truncate" | "wrap";
  onPick: (playerId: string) => void;
}) {
  if (candidates.length === 0) {
    return <div className="px-1 py-3 text-xs text-muted-foreground">暂无玩家</div>;
  }

  return (
    <motion.div
      className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      variants={listContainer(candidates.length)}
      initial="initial"
      animate="animate"
    >
      {candidates.map((candidate) => (
        <motion.button
          key={candidate.id}
          type="button"
          variants={listItem}
          {...selectable}
          onClick={() => onPick(candidate.id)}
          className={cn(
            "cursor-pointer rounded-md border px-3 py-2.5 text-left text-sm transition-[background,border-color]",
            tone === "recommended"
              ? "border-primary/40 bg-primary/5 hover:border-primary/50 hover:bg-primary/10"
              : "hover:border-primary/40 hover:bg-primary/5",
          )}
        >
          <div className="flex items-center gap-1.5">
            {tone === "recommended" ? (
              <Eye className="h-3.5 w-3.5 shrink-0 text-primary" />
            ) : (
              <UserCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className={cn("font-medium", nameWrap === "truncate" ? "truncate" : "break-words")}>
              {candidate.name}
            </span>
          </div>
        </motion.button>
      ))}
    </motion.div>
  );
}
