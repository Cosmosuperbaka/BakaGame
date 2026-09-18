import type { ChatMessage } from '../shared/Model';
import type { CCBCharacterView, CCBGuess, CCBPhase, CCBRoundSummary, CCBSettings } from '../shared/CCB';
import type { CCBOriginalPlayer } from '../infrastructure/CCBOriginalProtocol';
import type { CCBOriginalSocket } from '../infrastructure/CCBOriginalSocket';

export interface CCBOriginalChatRoom {
  generation: string;
  chat: ChatMessage[];
  /** 同一上游局的自动提示只生成一次，不因增强玩家加入顺序变化。 */
  roundHints: Map<string, string[]>;
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
