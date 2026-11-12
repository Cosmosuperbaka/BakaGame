import { ArrowDown, ArrowUp, Check, ChevronsDown, ChevronsUp, Minus, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CEECharacterView, CEEComparison, CEEFeedback } from "@bakagame/shared";

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

/** 服务端用 -1 表示「查不到」的数值字段（最高分、最早登场）；展示时一律读作未知，不显示哨兵值本身。 */
export const CEE_UNKNOWN_NUMBER = -1;

/** 性别展示：答案卡与反馈表同一口径，`?` 是服务端对未知性别的写法。 */
export const CEE_GENDER_TEXT: Record<CEECharacterView["gender"], string> = {
  female: "女",
  male: "男",
  "?": "未知",
};

/** 反馈字段的中文名：反馈表、回放芯片与排位对手线索共用。 */
export const CEE_FIELD_LABEL: Record<
  Exclude<keyof CEEFeedback, "sharedAppearances" | "tags" | "extraTags">,
  string
> = {
  gender: "性别",
  popularity: "人气",
  appearancesCount: "作品数",
  rating: "最高分",
  latestAppearance: "最晚登场",
  earliestAppearance: "最早登场",
};
