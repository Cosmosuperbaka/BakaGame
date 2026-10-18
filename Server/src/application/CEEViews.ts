import type { CEEGuess, CEEPrivateState, CEERoomSnapshot, CEERoomSummary } from '../shared/CEE';
import { type CEEPlayerRecord, type CEERoom, type CEERound, type CEEUnit } from '../domain/CEEModel';
import { ceeParticipants, getCEEUnit } from '../domain/CEERound';
import { ROOM_ID_TEST_MODE } from '../shared/Index';

/** 大厅人数与其它游戏同口径：只计在线成员，参与与旁观分开统计。 */
export function ceeRoomSummary(room: CEERoom): CEERoomSummary {
  const online = [...room.players.values()].filter(player => player.online);
  return { roomId: room.id, source: 'native', name: room.name, phase: room.phase,
    playerCount: online.filter(player => player.membership === 'active').length,
    spectatorCount: online.filter(player => player.membership === 'spectator').length,
    hasPassword: Boolean(room.passwordHash), allowSpectators: room.allowSpectators };
}
export function ceeSnapshot(room: CEERoom): CEERoomSnapshot {
  return { roomId: room.id, source: 'native', name: room.name, visibility: room.visibility,
    hasPassword: Boolean(room.passwordHash), allowSpectators: room.allowSpectators, hostPlayerId: room.hostPlayerId,
    phase: room.phase, settings: room.settings, roundNumber: room.roundNumber, syncRound: room.round?.syncRound ?? 0,
    setterPlayerId: room.setterPlayerId, phaseDeadlineAt: room.phaseDeadlineAt, chat: room.chat, roundSummary: room.summary,
    upstreamConnected: true, players: [...room.players.values()].map(player => ({
      id: player.id, name: player.name, online: player.online, ready: player.ready, team: player.team,
      membership: player.membership, score: player.score, status: player.status, attempts: player.attempts,
      marks: player.marks, syncCompleted: player.syncCompleted, account: player.account,
    })) };
}
function visibleGuesses(room: CEERoom, player: CEEPlayerRecord, observing: boolean): CEEGuess[] {
  const round = room.round;
  if (!round) return [];
  const unit = getCEEUnit(room, player);
  return round.guesses.filter(guess => observing || unit?.memberIds.includes(guess.playerId)).map(guess => ({
    ...guess, feedback: { ...guess.feedback, tags: guess.feedback.tags.map(tag => {
      const owners = round.tagOwners.get(tag.text);
      const hidden = !observing && room.phase !== 'settled' && Boolean(owners && !owners.has(player.id));
      return hidden ? { text: '???', matched: false, hidden: true, kind: tag.kind } : tag;
    }) },
  }));
}
/** 本单位剩余可猜次数；没有当前局时为 0。 */
function ceeRemainingAttempts(round: CEERound | null, unit: CEEUnit | undefined): number {
  return round ? Math.max(0, round.settings.maxAttempts - (unit?.attempts ?? 0)) : 0;
}
/** 是否还能提交猜测：本局未结束，同步模式下还需等本轮完成。 */
function canSubmitCEEGuess(round: CEERound, unit: CEEUnit): boolean {
  return !unit.ended && (!round.settings.syncMode || !unit.completed);
}
/** 房主开局条件：人数达标（仅测试房允许房主一人试玩），随机出题要其他人备好、手动出题要有可选出题人。 */
function hostCanStartRound(room: CEERoom, participants: CEEPlayerRecord[], setterCandidates: CEEPlayerRecord[]): boolean {
  const enoughPlayers = participants.length > 1 || (room.id === ROOM_ID_TEST_MODE && participants.length > 0);
  if (!enoughPlayers) return false;
  if (room.settings.answerMode === 'manual') return setterCandidates.length > 0;
  return room.phase === 'settled' || participants.every(member => member.id === room.hostPlayerId || member.ready);
}
/** 全局 BP 下该玩家视角的禁用角色编号：其他玩家猜过的角色，答案豁免与本人重复除外。 */
function bannedCharacterIdsFor(round: CEERound | null, player: CEEPlayerRecord): number[] {
  if (!round || !round.settings.globalPick) return [];
  const usedCharacterIds = new Set(round.guesses.filter(guess => guess.playerId === player.id).map(guess => guess.character.id));
  return [...new Set(round.guesses.filter(guess =>
    !usedCharacterIds.has(guess.character.id) && guess.playerId !== player.id && (!round.settings.syncMode || guess.syncRound < round.syncRound) &&
    !(guess.correct && (round.settings.syncMode || round.settings.nonstopMode)),
  ).map(guess => guess.character.id))];
}
export function ceePrivateState(room: CEERoom, player: CEEPlayerRecord): CEEPrivateState {
  const round = room.round;
  const unit = getCEEUnit(room, player);
  const observing = room.phase === 'settled' || player.status !== 'playing';
  const remaining = ceeRemainingAttempts(round, unit);
  const inGame = room.phase === 'guessing' && Boolean(unit) && player.status === 'playing';
  const canGuess = inGame && Boolean(round && unit && canSubmitCEEGuess(round, unit));
  const inStartablePhase = room.phase === 'waiting' || room.phase === 'settled';
  const participants = ceeParticipants(room, inStartablePhase ? null : room.setterPlayerId);
  // 能当出题人的：在线、且他出题后（连同队友一起观战）还留得下猜题者。逐人重算参与者是 O(n²)，
  const isHost = player.id === room.hostPlayerId;
  const needsCandidates = isHost && (room.phase === 'choosingSetter' || (inStartablePhase && room.settings.answerMode === 'manual'));
  const setterCandidates = needsCandidates
    ? [...room.players.values()].filter(candidate => candidate.online && ceeParticipants(room, candidate.id).length > 0) : [];
  return {
    playerId: player.id, canGuess,
    canSurrender: inGame && !unit!.ended,
    // 随机出题在等待阶段需其他参与者准备（结算阶段再来一轮直接沿用在线参与者）；
    // 手动出题开始后先进入选人阶段，出题人不必准备，有可选的出题人即可。
    // 单人不能开局，只有测试房允许房主一个人试玩。
    canStart: inStartablePhase && isHost && hostCanStartRound(room, participants, setterCandidates),
    canSetAnswer: room.phase === 'answering' && player.id === room.setterPlayerId,
    setterCandidateIds: room.phase === 'choosingSetter' && isHost ? setterCandidates.map(candidate => candidate.id) : [],
    guesses: visibleGuesses(room, player, observing),
    answer: round && observing ? round.answer : null,
    hints: round && inGame ? round.hints.filter((_, index) => round.settings.useHints[index]! > 0 && remaining <= round.settings.useHints[index]!) : [],
    imageHintAvailable: Boolean(round && inGame && round.settings.useImageHint > 0 && remaining <= round.settings.useImageHint),
    imageHintLevel: remaining,
    deadlineAt: canGuess ? unit!.deadlineAt : null,
    bannedCharacterIds: bannedCharacterIdsFor(round, player),
  };
}
