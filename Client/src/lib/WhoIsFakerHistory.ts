import {
  ABSTAIN_TARGET_ID,
  type PublicPlayerView,
  type RoundFeedback,
  type RoundHistoryEntry,
  type VoteRecord,
} from "@/types";

/** 名单里查不到（极少见的旧数据）时退回编号，不留空白。 */
export function playerNameOf(players: PublicPlayerView[], playerId: string): string {
  return players.find((player) => player.id === playerId)?.name ?? playerId;
}

/** 按目标汇总票数，票多的在前；弃票单独一项，排在最后。 */
export function tallyVotes(votes: VoteRecord[]): Array<{ targetId: string; count: number }> {
  const counts = new Map<string, number>();
  for (const vote of votes) counts.set(vote.targetId, (counts.get(vote.targetId) ?? 0) + 1);
  return [...counts.entries()]
    .map(([targetId, count]) => ({ targetId, count }))
    .sort((a, b) =>
      Number(a.targetId === ABSTAIN_TARGET_ID) - Number(b.targetId === ABSTAIN_TARGET_ID) || b.count - a.count,
    );
}

/** 继续按钮的文案取自服务端预判的下一阶段。 */
export function feedbackNextLabel(feedback: RoundFeedback): string {
  switch (feedback.next) {
    case "night": return "进入夜晚";
    case "description": return feedback.kind === "night" ? "开始描述" : "继续游戏";
    case "tieBreak": return "进入平票 PK";
    case "blankGuess": return "进入白板猜词";
    case "gameOver": return "查看结算";
    default: return "继续游戏";
  }
}

export const REMOVAL_REASON_TEXT: Record<Extract<RoundHistoryEntry, { kind: "removal" }>["reason"], string> = {
  left: "主动离开",
  timeout: "离线超时被移出",
  kicked: "被房主移出",
  disconnected: "掉线后被出题人移出",
};

/** 历史条目的阶段名：同一天里按时间顺序排开。 */
export function historyEntryTitle(entry: RoundHistoryEntry): string {
  switch (entry.kind) {
    case "vote": return entry.tieBreak ? "平票 PK 投票" : "投票";
    case "night": return "夜晚";
    case "blankGuess": return "白板猜词";
    case "removal": return "离场";
  }
}

/** 按天分组，组内保持服务端记录的先后。 */
export function groupHistoryByDay(history: RoundHistoryEntry[]): Array<{ day: number; entries: RoundHistoryEntry[] }> {
  const groups: Array<{ day: number; entries: RoundHistoryEntry[] }> = [];
  const ordered = [...history].sort((a, b) => a.createdAt - b.createdAt);
  for (const entry of ordered) {
    const last = groups.at(-1);
    if (last && last.day === entry.day) last.entries.push(entry);
    else groups.push({ day: entry.day, entries: [entry] });
  }
  return groups;
}
