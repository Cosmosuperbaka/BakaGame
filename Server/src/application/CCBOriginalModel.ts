import type { ChatMessage } from '../shared/Model';
import type { CCBCharacterView, CCBGuess, CCBPhase, CCBRoundSummary, CCBSettings } from '../shared/CCB';
import type { CCBOriginalPlayer } from '../infrastructure/CCBOriginalProtocol';
import type { CCBOriginalSocket } from '../infrastructure/CCBOriginalSocket';
import type { CCBOriginalRoundData } from './CCBOriginalRoundData';
import type { LRUCache } from 'lru-cache';

export interface CCBOriginalChatRoom {
  generation: string;
  chat: ChatMessage[];
  seenRoundKeys: LRUCache<string, number>;
  /** 首个结束/开局事件推进代数，其余上游连接绑定同一局。 */
  round?: { id: string; number: number; characterKey: string; phase: 'guessing' | 'settled';
    hints: string[]; data: CCBOriginalRoundData };
}

export interface CCBOriginalSession {
  token: string;
  connectionId?: string;
  detachedAt?: number;
  roomId: string;
  name: string;
  socket: CCBOriginalSocket;
  confirmed: boolean;
  revoked: boolean;
  players: CCBOriginalPlayer[];
  settings: CCBSettings;
  phase: CCBPhase;
  roomName: string;
  isPublic: boolean;
  setterId: string | null;
  roundNumber: number;
  syncRound: number;
  roundKey: string | null;
  answer: CCBCharacterView | null;
  hints: string[];
  guesses: CCBGuess[];
  bannedTags: Map<string, Set<string>>;
  winners: Array<{ playerId: string; rank: number; score: number }>;
  roundSummary: CCBRoundSummary | null;
  deadlineAt: number | null;
  queue: Promise<unknown>;
}
