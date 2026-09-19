import type { CCBCharacterView, CCBGuess, CCBPhase, CCBPlayer, CCBRoundSummary, CCBScoreDetail, CCBSettings, ChatMessage, RoomVisibility } from '../shared/Index';

export interface CCBPlayerRecord extends CCBPlayer {
  sessionToken: string; connectionId?: string; joinedAt: number; offlineAt?: number;
}
export interface CCBUnit {
  id: string; memberIds: string[]; attempts: number; marks: string; completed: boolean;
  ended: boolean; deadlineAt: number | null;
}
export interface CCBWinner {
  playerId: string; unitId: string; attempts: number; rank: number; detail: CCBScoreDetail;
}
export interface CCBRound {
  id: string; answer: CCBCharacterView; settings: CCBSettings; hints: string[];
  units: Map<string, CCBUnit>; participants: string[]; guesses: CCBGuess[];
  characters: Map<number, CCBCharacterView>; winners: CCBWinner[]; syncRound: number;
  roundStartRank: number; initialCount: number;
  tagOwners: Map<string, Set<string>>; pendingTagOwners: Map<string, Set<string>>;
}
export interface CCBRoom {
  id: string; name: string; visibility: RoomVisibility; passwordHash?: string; allowSpectators: boolean;
  hostPlayerId: string; players: Map<string, CCBPlayerRecord>; settings: CCBSettings;
  phase: CCBPhase; roundNumber: number; setterPlayerId: string | null;
  phaseDeadlineAt: number | null; preparationId?: string; round: CCBRound | null; summary: CCBRoundSummary | null;
  chat: ChatMessage[]; lastActiveAt: number; emptyAt?: number; hostDeadlineAt?: number;
}
export const ccbUnitId = (player: Pick<CCBPlayer, 'id' | 'team'>): string => player.team === null ? player.id : `team:${player.team}`;
