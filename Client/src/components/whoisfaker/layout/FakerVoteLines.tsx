import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { listItem } from "@/lib/motion/Choreography";
import { cn } from "@/lib/Utils";

/**
 * 一条行为：谁、做了什么、对谁。阶段反馈的票型与结算历史的投票、夜晚行动共用这一行，
 * 只在密度上不同（`dense` 为结算历史的紧凑档）。
 */
export function VoteRow({
  actor,
  verb,
  target,
  muted,
  dense,
  animated,
}: {
  actor: string;
  verb: string;
  target: ReactNode;
  /** 对象是「弃票」「不行动」这类没有收件人的结论时压低强调 */
  muted?: boolean;
  dense?: boolean;
  /** 放在带 `listContainer` 变体的列表里时逐行入场 */
  animated?: boolean;
}) {
  const className = cn(
    "flex min-w-0 items-center gap-2 rounded-md bg-background px-3 py-1.5",
    dense ? "text-xs" : "text-sm"
  );
  const body = (
    <>
      <span className="min-w-0 truncate font-medium">{actor}</span>
      <span className="shrink-0 text-muted-foreground">{verb}</span>
      {/* 对象是这一行的结论：不随行动者一起压缩，最多占半行，超出才截断 */}
      <span
        className={cn(
          "min-w-0 max-w-1/2 shrink-0 truncate",
          muted ? "text-muted-foreground" : "font-medium"
        )}
      >
        {target}
      </span>
    </>
  );
  return animated ? (
    <motion.li variants={listItem} className={className}>
      {body}
    </motion.li>
  ) : (
    <li className={className}>{body}</li>
  );
}

/** 每个结算阶段的一句话结论：平票进入 PK、出局名单，或没人出局时各自的说法。 */
export function OutcomeLine({
  names,
  empty,
  tieBreak,
  size = "xs",
}: {
  names: string[];
  empty: string;
  /** 平票候选；有它时只说平票进入 PK */
  tieBreak?: string[];
  /** `base` 是阶段反馈页的居中大号结论，`xs` 是结算历史里的行内结论 */
  size?: "base" | "xs";
}) {
  const base = size === "base";
  const lineClass = base ? "text-center text-base" : "text-xs";
  const strong = base ? "font-semibold" : "font-medium";
  if (tieBreak?.length) {
    return (
      <p className={lineClass}>
        <span className={cn(strong, "text-warning")}>{tieBreak.join("、")}</span>
        <span className="text-muted-foreground"> 平票，进入 PK</span>
      </p>
    );
  }
  if (!names.length) {
    return <p className={cn(lineClass, base && "font-medium", "text-muted-foreground")}>{empty}</p>;
  }
  return (
    <p className={lineClass}>
      <span className={cn(strong, "text-destructive")}>{names.join("、")}</span>
      <span className="text-muted-foreground"> 出局</span>
    </p>
  );
}
