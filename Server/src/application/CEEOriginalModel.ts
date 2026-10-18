import type { ChatMessage } from "../shared/Model";
import type {
  CEECharacterView,
  CEEGuess,
  CEEPhase,
  CEERoundSummary,
  CEESettings,
} from "../shared/CEE";
import type { CEEOriginalPlayer } from "../infrastructure/CEEOriginalProtocol";
import type { CEEOriginalSocket } from "../infrastructure/CEEOriginalSocket";
import type { CEEOriginalRoundData } from "./CEEOriginalRoundData";
import type { LRUCache } from "lru-cache";

export interface CEEOriginalChatRoom {
  generation: string;
  chat: ChatMessage[];
  seenRoundKeys: LRUCache<string, number>;
  /** 首个结束/开局事件推进代数，其余上游连接绑定同一局。 */
  round?: {
    id: string;
    number: number;
    characterKey: string;
    phase: "guessing" | "settled";
    hints: string[];
    data: CEEOriginalRoundData;
  };
}

/** 原版服务器 `/api/list-rooms` 的一行，已归一化字段类型；包含非公开房。 */
export interface CEEUpstreamRoom {
  id: string;
  isPublic: boolean;
  name: string;
  phase: "waiting" | "guessing";
  playerCount: number;
}

/** 查询期间冻结准备事务，连接/权限/阶段失效即撤销，不能靠命令队列保活。 */
export interface CEEOriginalPreparation {
  id: string;
  connectionId: string;
  phase: "waiting" | "settled" | "answering";
  hostId: string;
  setterId: string | null;
  roomGeneration: string;
  roundKey: string | null;
  settings: CEESettings;
}

export interface CEEOriginalSession {
  token: string;
  connectionId?: string;
  detachedAt?: number;
  /** 原版服务器上的真实房号，所有上游事件与聊天分组都用它。 */
  roomId: string;
  /** 统一房号目录分配的 4 位别名，客户端只见到这个号。 */
  alias: string;
  name: string;
  socket: CEEOriginalSocket;
  confirmed: boolean;
  revoked: boolean;
  players: CEEOriginalPlayer[];
  settings: CEESettings;
  phase: CEEPhase;
  /**
   * 手动出题时房主点开始后进入选出题人阶段，原版协议没有这一阶段，只在本服务端记录：
   * 值是进入前的阶段，取消时退回去；上游一推进阶段（开始出题、开局、结束）就清掉。
   */
  choosingSetterFrom?: "waiting" | "settled";
  roomName: string;
  isPublic: boolean;
  setterId: string | null;
  roundNumber: number;
  syncRound: number;
  roundKey: string | null;
  answer: CEECharacterView | null;
  hints: string[];
  guesses: CEEGuess[];
  bannedTags: Map<string, Set<string>>;
  winners: Array<{ playerId: string; rank: number; score: number }>;
  roundSummary: CEERoundSummary | null;
  deadlineAt: number | null;
  preparation?: CEEOriginalPreparation;
  queue: Promise<unknown>;
}
