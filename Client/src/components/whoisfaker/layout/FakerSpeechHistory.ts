import {
  buildDescriptionColumns,
  pendingColumn,
  type DescriptionColumn,
  type SpeechStatus,
} from "@/lib/DescriptionColumns";
import { submittedOf } from "@/lib/WhoIsFakerSpeech";
import type { DescriptionRecord, PublicPlayerView } from "@bakagame/shared";

/** 玩家行右侧续接的发言列 */
export interface PlayerListHistory {
  columns: DescriptionColumn[];
  byPlayer: Map<string, Map<string, DescriptionRecord>>;
  /** playerId → columnKey → 1-based 发言顺位序号 */
  playerOrder?: Map<string, Map<string, number>>;
  /** 只在发言记录里出现、已离场的玩家，附在旁观分组之后 */
  departedPlayers: PublicPlayerView[];
  /**
   * 进行中那一列里已提交但尚未公开的玩家。
   * 这些格子显示对勾而不是等待占位 —— 内容已经有了，等的只是揭示时机。
   */
  submittedColumnKey?: string;
  submittedPlayerIds?: Set<string>;
}

/** 名册里已无此人的发言作者：只用记录里的 id 与名字合成离线占位，不伪造完整玩家。 */
const departedPlayerOf = (record: DescriptionRecord): PublicPlayerView => ({
  id: record.playerId,
  name: record.playerName,
  score: 0,
  membership: "active",
  online: false,
  isReady: false,
  isBot: false,
  isHost: false,
  roundStatus: "waiting",
});

/**
 * 发言历史的列模型：按“正常轮次 → 平票 PK → 补充发言”展开列，进行中的那一列补上待提交格子，
 * 并找出只在发言里出现的已离场玩家。房间页与故事夹具共用这一份，不各写一遍。
 */
export function buildSpeechHistory(
  descriptions: DescriptionRecord[],
  players: PublicPlayerView[],
  status: SpeechStatus | undefined
): PlayerListHistory {
  const { columns, byPlayer, playerOrder } = buildDescriptionColumns(descriptions, status);
  const present = new Set(players.map((player) => player.id));
  const departed = new Map<string, PublicPlayerView>();
  for (const record of descriptions) {
    if (present.has(record.playerId) || departed.has(record.playerId)) continue;
    departed.set(record.playerId, departedPlayerOf(record));
  }
  return {
    columns,
    byPlayer,
    playerOrder,
    departedPlayers: [...departed.values()],
    submittedColumnKey: (status ? pendingColumn(status) : null)?.key,
    submittedPlayerIds: status ? submittedOf(status) : new Set<string>(),
  };
}
