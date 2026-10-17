import type { CEECharacterView, CEEGuess, CEEPhase, CEEPlayer, CEERoundSummary, CEEScoreDetail, CEESettings, ChatMessage, RoomVisibility } from '../shared/Index';

export interface CEEPlayerRecord extends CEEPlayer {
  sessionToken: string; connectionId?: string; joinedAt: number; offlineAt?: number;
}
export interface CEEUnit {
  id: string; memberIds: string[]; attempts: number; marks: string; completed: boolean;
  ended: boolean; deadlineAt: number | null;
}
export interface CEEWinner {
  playerId: string; unitId: string; attempts: number; rank: number; detail: CEEScoreDetail;
}
export interface CEERound {
  id: string; answer: CEECharacterView; settings: CEESettings; hints: string[];
  units: Map<string, CEEUnit>; participants: string[]; guesses: CEEGuess[];
  characters: Map<number, CEECharacterView>; winners: CEEWinner[]; syncRound: number;
  roundStartRank: number; initialCount: number; startedAt: number;
  tagOwners: Map<string, Set<string>>; pendingTagOwners: Map<string, Set<string>>;
}
export interface CEERoom {
  id: string; name: string; visibility: RoomVisibility; passwordHash?: string; allowSpectators: boolean;
  hostPlayerId: string; players: Map<string, CEEPlayerRecord>; settings: CEESettings;
  phase: CEEPhase; roundNumber: number; setterPlayerId: string | null;
  phaseDeadlineAt: number | null; preparationId?: string; round: CEERound | null; summary: CEERoundSummary | null;
  chat: ChatMessage[]; createdAt: number; lastActiveAt: number; emptyAt?: number; hostDeadlineAt?: number;
}
export const ceeUnitId = (player: Pick<CEEPlayer, 'id' | 'team'>): string => player.team === null ? player.id : `team:${player.team}`;
