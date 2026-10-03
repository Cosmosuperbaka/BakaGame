import type { WhoIsFakerPhase, WhoIsFakerRole, RoundWinner } from "@/types";

// 阶段中文名
export const PHASE_LABELS: Record<WhoIsFakerPhase, string> = {
  waiting: "等待中",
  assigningQuestioner: "指定主持人",
  wordSubmission: "出题阶段",
  description: "描述阶段",
  voting: "投票阶段",
  tieBreak: "平票PK",
  night: "夜晚阶段",
  blankGuess: "白板猜词",
  gameOver: "游戏结束",
};

// 角色中文名
export const ROLE_LABELS: Record<WhoIsFakerRole, string> = {
  civilian: "平民",
  undercover: "卧底",
  angel: "天使",
  blank: "白板",
};

/**
 * 身份色。只由 `RoleBadge` 引用：玩家栏、结算身份表与中盘预览的身份徽章共用这一套，
 * 不各写一份；中性身份取语义的 `muted-foreground`，不引入第三种灰色。
 * 取值全部来自 `index.css` 的状态语义令牌，亮暗两侧由令牌自身切换，
 * 组件里不再逐处补 `dark:` 变体。
 */
export const ROLE_COLORS: Record<WhoIsFakerRole, string> = {
  civilian: "text-info",
  undercover: "text-destructive",
  angel: "text-warning",
  blank: "text-muted-foreground",
};

// 阵营中文名
export const SIDE_LABELS: Record<string, string> = {
  good: "好人阵营",
  undercover: "卧底阵营",
  blank: "白板",
};

// 胜利者中文名
export const WINNER_LABELS: Record<RoundWinner, string> = {
  good: "好人阵营胜利",
  undercover: "卧底阵营胜利",
  blank: "白板胜利",
  aborted: "游戏中断",
};
