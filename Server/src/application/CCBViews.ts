import type { CCBGuess, CCBPrivateState, CCBRoomSnapshot, CCBRoomSummary } from '../shared/CCB';
import { ccbUnitId, type CCBPlayerRecord, type CCBRoom } from '../domain/CCBModel';
import { ccbParticipants, getCCBUnit } from '../domain/CCBRound';

/** 大厅人数与其它游戏同口径：只计在线成员，参与与旁观分开统计。 */
export function ccbRoomSummary(room: CCBRoom): CCBRoomSummary {
  const online = [...room.players.values()].filter(player => player.online);
  return { roomId: room.id, source: 'native', name: room.name, phase: room.phase,
    playerCount: online.filter(player => player.membership === 'active').length,
    spectatorCount: online.filter(player => player.membership === 'spectator').length,
    hasPassword: Boolean(room.passwordHash), allowSpectators: room.allowSpectators };
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
  // 能当出题人的：在线、且他出题后（连同队友一起观战）还留得下猜题者。逐人重算参与者是 O(n²)，
  // 而私有状态每次广播要给每个连接各算一遍，所以只给房主、且只在手动出题的等待与选人阶段算。
  const isHost = player.id === room.hostPlayerId;
  const needsCandidates = isHost && (room.phase === 'choosingSetter' || (room.phase === 'waiting' && room.settings.answerMode === 'manual'));
  const setterCandidates = needsCandidates
    ? [...room.players.values()].filter(candidate => candidate.online && ccbParticipants(room, candidate.id).length > 0) : [];
  const usedCharacterIds = new Set(round?.guesses.filter(guess => guess.playerId === player.id).map(guess => guess.character.id));
  return {
    playerId: player.id, canGuess,
    canSurrender: inGame && !unit!.ended,
    // 随机出题要其他参与者都准备；手动出题开始后先进入选人阶段，出题人不必准备，有可选的出题人即可。
    canStart: room.phase === 'waiting' && isHost && participants.length > 0 &&
      (room.settings.answerMode === 'manual'
        ? setterCandidates.length > 0
        : participants.every(member => member.id === room.hostPlayerId || member.ready)),
    canSetAnswer: room.phase === 'answering' && player.id === room.setterPlayerId,
    setterCandidateIds: room.phase === 'choosingSetter' && isHost ? setterCandidates.map(candidate => candidate.id) : [],
    guesses: visibleGuesses(room, player, observing),
    answer: round && observing ? round.answer : null,
    hints: round && inGame ? round.hints.filter((_, index) => round.settings.useHints[index]! > 0 && remaining <= round.settings.useHints[index]!) : [],
    imageHintAvailable: Boolean(round && inGame && round.settings.useImageHint > 0 && remaining <= round.settings.useImageHint),
    imageHintLevel: remaining,
    deadlineAt: canGuess ? unit!.deadlineAt : null,
    bannedCharacterIds: round?.settings.globalPick ? [...new Set(round.guesses.filter(guess =>
      !usedCharacterIds.has(guess.character.id) && guess.playerId !== player.id && (!round.settings.syncMode || guess.syncRound < round.syncRound) &&
      !(guess.correct && (round.settings.syncMode || round.settings.nonstopMode)),
    ).map(guess => guess.character.id))] : [],
  };
}
