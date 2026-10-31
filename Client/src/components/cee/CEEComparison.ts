import { ArrowDown, ArrowUp, Check, ChevronsDown, ChevronsUp, Minus, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CEEComparison } from "@bakagame/shared";

/**
 * 比较值来自「猜测减答案」（服务端 buildCEEFeedback）；箭头指向答案，方向与差值相反。
 * 色块只分三档：相同为绿，落在近似阈值内为金，差得远或不匹配保持中性；
 * 远近另由单箭头与双箭头区分，不只靠颜色传达。
 * 反馈表与排位的对手线索共用这一份，同一个符号在两处长得一样。
 */
export type CEEComparisonTone = "match" | "near" | "far" | "unknown";

export const CEE_COMPARISON: Record<
  CEEComparison,
  { label: string; icon: LucideIcon; tone: CEEComparisonTone }
> = {
  "=": { label: "相同", icon: Check, tone: "match" },
  yes: { label: "匹配", icon: Check, tone: "match" },
  "+": { label: "答案更低", icon: ArrowDown, tone: "near" },
  "-": { label: "答案更高", icon: ArrowUp, tone: "near" },
  "++": { label: "答案低很多", icon: ChevronsDown, tone: "far" },
  "--": { label: "答案高很多", icon: ChevronsUp, tone: "far" },
  no: { label: "不匹配", icon: X, tone: "far" },
  "?": { label: "无法比较", icon: Minus, tone: "unknown" },
};

export const CEE_TONE_CLASS: Record<CEEComparisonTone, string> = {
  match: "border-success/40 bg-success/10 text-success",
  near: "border-warning/40 bg-warning/10 text-warning",
  far: "border-transparent bg-muted text-foreground",
  unknown: "border-dashed border-border text-muted-foreground",
};
