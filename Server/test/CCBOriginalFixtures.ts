import type { CCBDataProvider, CCBRawCharacter } from '../src/infrastructure/CCBData';
import type { CCBOriginalSocket } from '../src/infrastructure/CCBOriginalSocket';
import { createDefaultCCBSettings, type CCBCharacterView } from '../src/shared/CCB';
export const originalCharacter = (id = 900): CCBCharacterView => ({
  id, name: `角色${id}`, nameCn: `中文${id}`, imageUrl: `https://images.example/${id}.jpg`,
  gender: 'female', popularity: 120, summary: '第一条线索。第二条线索。第三条线索。',
  appearances: [{ id: 10, name: '作品', nameCn: '作品', year: 2020, rating: 9, ratingCount: 100 }],
  comparisonAppearances: [{ id: 10, name: '作品', nameCn: '作品' }], extraTags: [],
  highestRating: 9, earliestAppearance: 2020, latestAppearance: 2020,
  subjectTags: ['校园'], characterTags: ['眼镜'], voiceActors: ['声优'], metaTags: ['校园', '眼镜', '声优'],
});
export const originalData: CCBDataProvider = {
  async getCharacter(id) { return originalCharacter(id); }, async chooseRandomCharacter() { return originalCharacter(); },
  async getRawCharacter(id): Promise<CCBRawCharacter> { return { ...originalCharacter(id), aliases: [], appearances: [], extraTagsBySubject: {} }; },
  async searchCharacters() { return [originalCharacter()]; }, async searchSubjects() { return []; }, async getSubjectCharacters() { return [originalCharacter()]; }, async getSubjects() { return []; },
  async importDirectory(id) { return { id, subjectIds: [10], missingSubjectIds: [], importedAt: 1 }; },
  async resolveCharacterImage(id) { return `https://images.example/${id}.jpg`; },
  async resolveSubjectImage(id) { return `https://images.example/s${id}.jpg`; }, close() {},
};

export class FixtureSocket implements CCBOriginalSocket {
  connected = false;
  listeners = new Map<string, Set<(payload?: unknown) => void>>();
  sent: Array<{ event: string; payload: unknown }> = [];
  failGuess = false;
  atomicTags = false;
  constructor(readonly id: string, readonly room: FixtureRoom) {}
  on(event: string, listener: (payload?: unknown) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }
  off(event: string, listener: (payload?: unknown) => void) { this.listeners.get(event)?.delete(listener); }
  receive(event: string, payload?: unknown) { for (const listener of [...this.listeners.get(event) || []]) listener(payload); }
  emit(event: string, payload: unknown, ack?: (payload: unknown) => void) {
    this.sent.push({ event, payload });
    const command = payload as Record<string, unknown>;
    if (event === 'createRoom' || event === 'joinRoom') {
      this.room.players.push({ id: this.id, username: command.username, ready: true, isHost: event === 'createRoom',
        team: null, guesses: '', score: 0 });
      this.room.broadcast('updatePlayers', { players: this.room.players, isPublic: true });
      this.receive('roomNameUpdated', { roomName: '' });
    } else if (event === 'updateGameSettings') this.receive('updateGameSettings', { settings: command.settings });
    else if (event === 'requestGameSettings') this.receive('updateGameSettings', { settings: createDefaultCCBSettings() });
    else if (event === 'updateRoomName') this.receive('roomNameUpdated', { roomName: String(command.roomName).trim().slice(0, 30) });
    else if (event === 'toggleRoomVisibility') this.receive('updatePlayers', { players: this.room.players, isPublic: false });
    else if (event === 'toggleReady') {
      const player = this.room.players.find(player => player.id === this.id)!;
      player.ready = !player.ready;
      this.room.broadcast('updatePlayers', { players: this.room.players, isPublic: true });
    } else if (event === 'gameStart' || event === 'setAnswer') this.room.broadcast('gameStart', {
      character: command.character, settings: command.settings || createDefaultCCBSettings(), players: this.room.players,
      isPublic: true, hints: command.hints,
    });
    else if (event === 'setAnswerSetter') this.room.broadcast('waitForAnswer', { answerSetterId: command.setterId });
    ack?.(this.failGuess && event === 'playerGuess' ? { ok: false, message: '角色已经被猜过' }
      : { ok: true, ...(event === 'playerGuess' && this.atomicTags ? { tagBanApplied: true } : {}) });
  }
  connect() { this.connected = true; this.receive('connect'); }
  disconnect() { this.connected = false; this.receive('disconnect'); }
  removeAllListeners() { this.listeners.clear(); }
}

export class FixtureRoom {
  sockets: FixtureSocket[] = [];
  players: Array<Record<string, unknown>> = [];
  factory = () => { const socket = new FixtureSocket(`original-${this.sockets.length}`, this); this.sockets.push(socket); return socket; };
  broadcast(event: string, payload: unknown) { this.sockets.forEach(socket => socket.receive(event, payload)); }
}
