import type { CCBGuess, CCBPrivateState, CCBRoomSnapshot } from '../shared/CCB';
import type { CCBOriginalChatRoom, CCBOriginalSession } from './CCBOriginalModel';

export function originalPrivateState(session: CCBOriginalSession): CCBPrivateState {
  const playerId = session.socket.id || '';
  const me = session.players.find(player => player.id === playerId);
  const watching = !!me && (me.membership === 'spectator' || me.isSetter || me.temporaryObserver
    || ['solved', 'teamWon', 'exhausted', 'surrendered'].includes(me.status));
  const ended = session.phase === 'settled';
  const ownCorrect = session.guesses.some(guess => guess.playerId === playerId && guess.correct);
  const teamIds = new Set(session.players.filter(player => player.id === playerId || (me?.team !== null
    && me?.team !== undefined && player.team === me.team)).map(player => player.id));
  const visibleGuesses = session.guesses.filter(guess => watching || ended || teamIds.has(guess.playerId));
  const guesses: CCBGuess[] = visibleGuesses.map(guess => ({ ...guess, feedback: { ...guess.feedback,
    tags: guess.feedback.tags.map(tag => {
      const revealers = session.bannedTags.get(tag.text);
      const hidden = !watching && !ended && !!revealers && ![...revealers].some(id => teamIds.has(id));
      return hidden ? { text: '', matched: false, hidden: true, kind: tag.kind } : tag;
    }),
  } }));
  const remaining = Math.max(0, session.settings.maxAttempts - (me?.attempts || 0));
  const canGuess = !!me && session.confirmed && session.socket.connected && session.phase === 'guessing'
    && !watching && !ownCorrect && (!session.settings.syncMode || !me.syncCompleted);
  const mine = new Set(session.guesses.filter(guess => guess.playerId === playerId).map(guess => guess.character.id));
  const bannedCharacterIds = session.settings.globalPick ? [...new Set(session.guesses.filter(guess =>
    guess.playerId !== playerId && !mine.has(guess.character.id)
    && (!session.settings.syncMode || guess.syncRound < session.syncRound)
    && !((session.settings.syncMode || session.settings.nonstopMode) && guess.correct)
  ).map(guess => guess.character.id))] : [];
  return {
    playerId, canGuess, canSurrender: session.phase === 'guessing' && !!me && !watching && !ownCorrect,
    canStart: !!me?.isHost && ['waiting', 'settled'].includes(session.phase)
      && session.players.every(player => player.isHost || player.ready || !player.online),
    canSetAnswer: session.phase === 'answering' && session.setterId === playerId,
    guesses, answer: watching || ended ? session.answer : null,
    hints: session.hints.filter((_, index) => session.settings.useHints[index] > 0
      && (watching || ended || remaining <= session.settings.useHints[index])),
    imageHintAvailable: !!session.answer && session.settings.useImageHint > 0 && remaining <= session.settings.useImageHint,
    imageHintLevel: remaining,
    deadlineAt: canGuess ? session.deadlineAt : null, bannedCharacterIds,
  };
}

export function originalSnapshot(session: CCBOriginalSession, chatRoom?: CCBOriginalChatRoom): CCBRoomSnapshot {
  return {
    roomId: session.roomId, source: 'original', name: session.roomName || `${session.players.find(player => player.isHost)?.name || ''}的房间`,
    visibility: session.isPublic ? 'public' : 'private', hasPassword: false, allowSpectators: true,
    hostPlayerId: session.players.find(player => player.isHost)?.id || '', phase: session.phase,
    settings: session.settings,
    players: session.players.map(({ isHost: _host, isSetter: _setter, temporaryObserver: _temporary, ...player }) => ({
      ...player,
      status: session.guesses.some(guess => guess.playerId === player.id && guess.correct) ? 'solved' : player.status,
    })),
    roundNumber: session.roundNumber, syncRound: session.syncRound, setterPlayerId: session.setterId,
    phaseDeadlineAt: null, chat: chatRoom?.chat || [], roundSummary: session.roundSummary,
    upstreamConnected: session.confirmed && session.socket.connected,
  };
}
