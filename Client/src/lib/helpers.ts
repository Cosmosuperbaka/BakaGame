import type { GamePhase, PlayerRole, RoundWinner } from "@/types";

// 阶段中文名
export const PHASE_LABELS: Record<GamePhase, string> = {
  waiting: "等待中",
  assigningQuestioner: "指定出题人",
  wordSubmission: "出题阶段",
  description: "描述阶段",
  voting: "投票阶段",
  tieBreak: "平票PK",
  night: "夜晚阶段",
  daybreak: "天亮了",
  blankGuess: "白板猜词",
  gameOver: "游戏结束",
};

// 角色中文名
export const ROLE_LABELS: Record<PlayerRole, string> = {
  civilian: "平民",
  undercover: "卧底",
  angel: "天使",
  blank: "白板",
};

// 角色颜色
export const ROLE_COLORS: Record<PlayerRole, string> = {
  civilian: "text-blue-600",
  undercover: "text-red-600",
  angel: "text-amber-500",
  blank: "text-gray-500",
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

// 生成 4 位随机数字房间号
export function randomRoomId(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}
