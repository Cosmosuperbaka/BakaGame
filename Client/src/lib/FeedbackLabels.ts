import type { FeedbackKind, FeedbackStatus } from "@/types";
import type { BadgeProps } from "@/components/ui/Badge";

/** 反馈的种类与状态文案（用户侧与管理后台共用）。 */
export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
  suggestion: "建议",
  bug: "问题",
};

export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  open: "待处理",
  processing: "处理中",
  resolved: "已解决",
  closed: "已关闭",
};

export const FEEDBACK_STATUS_BADGE: Record<FeedbackStatus, NonNullable<BadgeProps["variant"]>> = {
  open: "subtle",
  processing: "active",
  resolved: "matched",
  closed: "upcoming",
};
