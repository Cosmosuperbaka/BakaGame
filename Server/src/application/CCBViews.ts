import type { CCBGuess, CCBPrivateState, CCBRoomSnapshot, CCBRoomSummary } from '../shared/CCB';
import { ccbUnitId, type CCBPlayerRecord, type CCBRoom } from '../domain/CCBModel';
import { ccbParticipants, getCCBUnit } from '../domain/CCBRound';

export function ccbRoomSummary(room: CCBRoom): CCBRoomSummary {
  return { roomId: room.id, source: 'native', name: room.name, phase: room.phase,
    playerCount: room.players.size, hasPassword: Boolean(room.passwordHash), allowSpectators: room.allowSpectators };
}
export function ccbSnapshot(room: CCBRoom): CCBRoomSnapshot {
  return { roomId: room.id, source: 'native', name: room.name, visibility: room.visibility,
    hasPassword: Boolean(room.passwordHash), allowSpectators: room.allowSpectators, hostPlayerId: room.hostPlayerId,
    phase: room.phase, settings: room.settings, roundNumber: room.roundNumber, syncRound: room.round?.syncRound ?? 0,
    setterPlayerId: room.setterPlayerId, phaseDeadlineAt: room.phaseDeadlineAt, chat: room.chat, roundSummary: room.summary,
    upstreamConnected: true, players: [...room.players.values()].map(player => ({
      id: player.id, name: player.name, online: player.online, ready: player.ready, team: player.team,
      membership: player.membership, score: player.score, status: player.status, attempts: player.attempts,
      marks: player.marks, syncCompleted: player.syncCompleted,
    })) };
}
function visibleGuesses(room: CCBRoom, player: CCBPlayerRecord, observing: boolean): CCBGuess[] {
  const round = room.round;
  if (!round) return [];
  const unit = getCCBUnit(room, player);
  return round.guesses.filter(guess => observing || unit?.memberIds.includes(guess.playerId)).map(guess => ({
    ...guess, feedback: { ...guess.feedback, tags: guess.feedback.tags.map(tag => {
      const owners = round.tagOwners.get(tag.text);
      const hidden = !observing && room.phase !== 'settled' && Boolean(owners && !owners.has(player.id));
      return hidden ? { text: '???', matched: false, hidden: true, kind: tag.kind } : tag;
    }) },
  }));
}
export function ccbPrivateState(room: CCBRoom, player: CCBPlayerRecord): CCBPrivateState {
  const round = room.round;
  const unit = getCCBUnit(room, player);
  const observing = room.phase === 'settled' || player.status !== 'playing';
  const remaining = round ? Math.max(0, round.settings.maxAttempts - (unit?.attempts ?? 0)) : 0;
  const inGame = room.phase === 'guessing' && Boolean(unit) && player.status === 'playing';
  const canGuess = inGame && Boolean(!unit!.ended && (!round!.settings.syncMode || !unit!.completed));
  const participants = ccbParticipants(room);
  const usedCharacterIds = new Set(round?.guesses.filter(guess => unit?.memberIds.includes(guess.playerId)).map(guess => guess.character.id));
  return {
    playerId: player.id, canGuess,
    canSurrender: inGame && !unit!.ended,
    canStart: room.phase === 'waiting' && player.id === room.hostPlayerId && participants.length > 0 &&
      participants.every(member => member.id === room.hostPlayerId || member.ready),
    canSetAnswer: room.phase === 'answering' && player.id === room.setterPlayerId,
    guesses: visibleGuesses(room, player, observing),
    answer: round && observing ? round.answer : null,
    hints: round && inGame ? round.hints.filter((_, index) => round.settings.useHints[index]! > 0 && remaining <= round.settings.useHints[index]!) : [],
    imageHintAvailable: Boolean(round && inGame && round.settings.useImageHint > 0 && remaining <= round.settings.useImageHint),
    imageHintLevel: remaining,
    deadlineAt: canGuess ? unit!.deadlineAt : null,
    bannedCharacterIds: round?.settings.globalPick ? [...new Set(round.guesses.filter(guess =>
      !usedCharacterIds.has(guess.character.id) && !unit?.memberIds.includes(guess.playerId) && (!round.settings.syncMode || guess.syncRound < round.syncRound) &&
      !(guess.correct && (round.settings.syncMode || round.settings.nonstopMode)),
    ).map(guess => guess.character.id))] : [],
  };
}
