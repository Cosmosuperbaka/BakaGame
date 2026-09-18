import type { CCBCharacterView, CCBGuess, CCBScoreDetail } from '../shared/CCB';
import { AppError } from './Errors';
import { ccbUnitId, type CCBPlayerRecord, type CCBRoom, type CCBRound, type CCBUnit } from './CCBModel';
import { buildCCBFeedback, calculateCCBSetterScore, calculateCCBWinnerScore, createCCBHints } from './CCBRules';

export function ccbParticipants(room: CCBRoom): CCBPlayerRecord[] {
  const setter = room.setterPlayerId ? room.players.get(room.setterPlayerId) : undefined;
  return [...room.players.values()].filter(player => player.online && player.membership === 'active' && player.id !== setter?.id &&
    !(setter?.team !== null && setter?.team !== undefined && player.team === setter.team));
}
export function beginCCBRound(room: CCBRoom, answer: CCBCharacterView, hints: string[] | null, now: number, random: () => number): void {
  const participants = ccbParticipants(room);
  if (!participants.length) throw new AppError('NO_PARTICIPANTS', '至少需要一名在线猜题玩家');
  const units = new Map<string, CCBUnit>();
  for (const player of room.players.values()) {
    player.attempts = 0; player.marks = ''; player.syncCompleted = false;
    player.status = 'observing';
  }
  for (const player of participants) {
    player.status = 'playing';
    const key = ccbUnitId(player);
    let unit = units.get(key);
    if (!unit) {
      unit = { id: key, memberIds: [], attempts: 0, marks: '', completed: false, ended: false,
        deadlineAt: room.settings.timeLimit ? now + room.settings.timeLimit * 1000 : null };
      units.set(key, unit);
    }
    unit.memberIds.push(player.id);
  }
  room.phase = 'guessing'; room.phaseDeadlineAt = null; delete room.preparationId; room.roundNumber++;
  room.summary = null;
  room.round = {
    id: crypto.randomUUID(), answer: structuredClone(answer), settings: structuredClone(room.settings),
    hints: hints === null ? createCCBHints(answer.summary, room.settings.useHints.length, random) : hints.slice(0, room.settings.useHints.length),
    units, participants: participants.map(player => player.id), guesses: [], characters: new Map([[answer.id, structuredClone(answer)]]),
    winners: [], syncRound: 1, roundStartRank: 1, initialCount: participants.length,
    tagOwners: new Map(), pendingTagOwners: new Map(),
  };
}
export function getCCBUnit(room: CCBRoom, player: CCBPlayerRecord): CCBUnit | undefined {
  const unit = room.round?.units.get(ccbUnitId(player));
  return unit?.memberIds.includes(player.id) ? unit : undefined;
}
export function requireCCBAction(room: CCBRoom, player: CCBPlayerRecord): { round: CCBRound; unit: CCBUnit } {
  if (room.phase !== 'guessing' || !room.round) throw new AppError('INVALID_PHASE', '当前不在猜测阶段');
  const unit = getCCBUnit(room, player);
  if (!player.online || !unit || unit.ended || player.status !== 'playing') throw new AppError('CANNOT_GUESS', '你本局已结束或正在观战');
  if (room.round.settings.syncMode && unit.completed) throw new AppError('SYNC_WAITING', '请等待本轮其他玩家');
  return { round: room.round, unit };
}
function copyUnit(room: CCBRoom, unit: CCBUnit): void {
  for (const id of unit.memberIds) {
    const player = room.players.get(id);
    if (!player) continue;
    player.attempts = unit.attempts; player.marks = unit.marks; player.syncCompleted = unit.completed;
  }
}
function finishUnit(room: CCBRoom, unit: CCBUnit, status: 'exhausted' | 'surrendered', mark: string): void {
  unit.ended = true; unit.completed = true; unit.deadlineAt = null; unit.marks += mark;
  for (const id of unit.memberIds) { const player = room.players.get(id); if (player) player.status = status; }
  copyUnit(room, unit);
}
export function applyCCBGuess(room: CCBRoom, player: CCBPlayerRecord, character: CCBCharacterView, now: number): CCBGuess {
  const { round, unit } = requireCCBAction(room, player);
  const correct = character.id === round.answer.id;
  const previouslyUsed = round.guesses.some(guess => guess.character.id === character.id && guess.playerId === player.id);
  if (round.settings.globalPick && !previouslyUsed && !(correct && (round.settings.syncMode || round.settings.nonstopMode))) {
    const used = round.guesses.some(guess => guess.character.id === character.id &&
      guess.playerId !== player.id && (!round.settings.syncMode || guess.syncRound < round.syncRound));
    if (used) throw new AppError('CHARACTER_BANNED', '该角色已被其他玩家猜过');
  }
  const feedback = buildCCBFeedback(character, round.answer, round.settings);
  const guess: CCBGuess = { id: crypto.randomUUID(), playerId: player.id, playerName: player.name,
    character: { id: character.id, name: character.name, nameCn: character.nameCn, imageUrl: character.imageUrl },
    correct, partial: !correct && feedback.sharedAppearances.length > 0, syncRound: round.syncRound, createdAt: now, feedback };
  round.guesses.push(guess); unit.attempts++; unit.marks += correct ? '✔' : guess.partial ? '💡' : '❌';
  if (round.settings.tagBan) {
    const owners = round.settings.syncMode ? round.pendingTagOwners : round.tagOwners;
    for (const tag of feedback.tags.filter(tag => tag.matched)) {
      if (round.tagOwners.has(tag.text)) continue;
      const existing = owners.get(tag.text) ?? new Set<string>();
      unit.memberIds.forEach(id => existing.add(id)); owners.set(tag.text, existing);
    }
  }
  unit.completed = true;
  unit.deadlineAt = round.settings.syncMode ? null : round.settings.timeLimit ? now + round.settings.timeLimit * 1000 : null;
  if (correct) {
    unit.ended = true; unit.deadlineAt = null;
    const rank = round.settings.syncMode ? round.roundStartRank : round.winners.length + 1;
    const base = round.settings.nonstopMode ? Math.max(1, round.initialCount - rank + 1) : 2;
    const score = calculateCCBWinnerScore(unit.attempts, round.settings.maxAttempts, base);
    const detail: CCBScoreDetail = { playerId: player.id, playerName: player.name, ...score, partial: 0, setter: 0, reason: '猜中角色', rank };
    round.winners.push({ playerId: player.id, unitId: unit.id, attempts: unit.attempts, rank, detail });
    if (round.settings.nonstopMode) player.score += detail.score;
    unit.marks += score.firstGuess ? '👑' : '✌';
    for (const id of unit.memberIds) { const member = room.players.get(id); if (member) member.status = id === player.id ? 'solved' : 'teamWon'; }
  } else if (unit.attempts >= round.settings.maxAttempts) finishUnit(room, unit, 'exhausted', '💀');
  copyUnit(room, unit);
  advanceCCBRound(room, now);
  return guess;
}
export function surrenderCCB(room: CCBRoom, player: CCBPlayerRecord, now: number): void {
  if (room.phase !== 'guessing' || !room.round) throw new AppError('INVALID_PHASE', '当前不在猜测阶段');
  const unit = getCCBUnit(room, player);
  if (!unit || unit.ended) throw new AppError('CANNOT_SURRENDER', '你本局已结束或正在观战');
  finishUnit(room, unit, 'surrendered', '🏳️'); advanceCCBRound(room, now);
}
export function tickCCBRound(room: CCBRoom, now: number): void {
  const round = room.round;
  if (room.phase !== 'guessing' || !round) return;
  for (const unit of round.units.values()) {
    if (unit.ended || unit.deadlineAt === null || now < unit.deadlineAt) continue;
    const online = unit.memberIds.filter(id => room.players.get(id)?.online && room.players.get(id)?.status === 'playing').length;
    if (!online) { unit.deadlineAt = null; continue; }
    // 队伍超时按在线队员数扣除，计数最多达到本局上限。
    const used = Math.min(online, round.settings.maxAttempts - unit.attempts);
    unit.attempts += used; unit.marks += '⏱️'.repeat(used); unit.completed = true;
    unit.deadlineAt = round.settings.syncMode ? null : now + round.settings.timeLimit * 1000;
    if (unit.attempts >= round.settings.maxAttempts) finishUnit(room, unit, 'exhausted', '💀');
    copyUnit(room, unit);
  }
  advanceCCBRound(room, now);
}
export function advanceCCBRound(room: CCBRoom, now: number): void {
  const round = room.round;
  if (room.phase !== 'guessing' || !round) return;
  const unfinished = [...round.units.values()].filter(unit => !unit.ended);
  const active = unfinished.filter(unit => unit.memberIds.some(id => room.players.get(id)?.online));
  const syncComplete = active.every(unit => unit.completed);
  if (!unfinished.length || (!round.settings.nonstopMode && round.winners.length && (!round.settings.syncMode || syncComplete))) {
    settleCCBRound(room); return;
  }
  // 临时断线保留未结束席位，等待重连或房间离线清理；刷新页面不能直接判负。
  if (!active.length) return;
  if (!round.settings.syncMode || !syncComplete) return;
  for (const [tag, owners] of round.pendingTagOwners) {
    for (const unit of active) unit.memberIds.forEach(id => owners.add(id));
    round.tagOwners.set(tag, owners);
  }
  round.pendingTagOwners.clear(); round.syncRound++; round.roundStartRank = round.winners.length + 1;
  for (const unit of round.units.values()) {
    if (unit.ended) continue;
    unit.completed = false;
    unit.deadlineAt = round.settings.timeLimit ? now + round.settings.timeLimit * 1000 : null;
    copyUnit(room, unit);
  }
}
export function settleCCBRound(room: CCBRoom): void {
  const round = room.round;
  if (!round || room.phase !== 'guessing') return;
  const scores = new Map<string, CCBScoreDetail>();
  for (const id of round.participants) {
    const player = room.players.get(id);
    if (player) scores.set(id, { playerId: id, playerName: player.name, score: 0, base: 0, firstGuess: 0, quickGuess: 0, partial: 0, setter: 0, reason: '' });
  }
  for (const winner of round.winners) {
    scores.set(winner.playerId, winner.detail);
    const player = room.players.get(winner.playerId);
    if (player && !round.settings.nonstopMode) player.score += winner.detail.score;
  }
  for (const unit of round.units.values()) {
    const hits = unit.memberIds.map(id => ({ id, position: round.guesses.filter(guess => guess.playerId === id).findIndex(guess => guess.partial) }))
      .filter(hit => hit.position >= 0 && room.players.has(hit.id))
      .sort((a, b) => a.position - b.position || room.players.get(a.id)!.name.localeCompare(room.players.get(b.id)!.name));
    const winner = hits[0];
    if (winner && !round.winners.some(correct => correct.playerId === winner.id)) {
      room.players.get(winner.id)!.score++;
      const detail = scores.get(winner.id)!; detail.score++; detail.partial = 1; detail.reason = '猜中共同作品';
    }
  }
  const setter = room.setterPlayerId ? room.players.get(room.setterPlayerId) : undefined;
  if (setter) {
    const result = calculateCCBSetterScore({ nonstop: round.settings.nonstopMode, totalPlayers: round.initialCount,
      winnerCount: round.winners.length, firstWinnerAttempts: round.winners[0]?.attempts ?? 0,
      maxAttempts: round.settings.maxAttempts, bigWinnerScore: round.winners.find(winner => winner.detail.firstGuess > 0)?.detail.score ?? 0 });
    setter.score += result.score;
    scores.set(setter.id, { playerId: setter.id, playerName: setter.name, score: result.score, base: 0,
      firstGuess: 0, quickGuess: 0, partial: 0, setter: result.score, reason: result.reason });
  }
  room.summary = { answer: structuredClone(round.answer), scores: [...scores.values()], guesses: structuredClone(round.guesses),
    winners: round.winners.map(winner => ({ playerId: winner.playerId, rank: winner.rank, score: winner.detail.score })) };
  room.phase = 'settled'; room.phaseDeadlineAt = null;
  for (const unit of round.units.values()) unit.deadlineAt = null;
}
