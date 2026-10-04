import { expect, test } from 'bun:test';
import { createServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { io as connect } from 'socket.io-client';
import { CCBOriginalService } from '../src/application/CCBOriginalService';
import type { CCBDataProvider, CCBRawCharacter } from '../src/infrastructure/CCBData';
import { createDefaultCCBSettings, type CCBCharacterView, type CCBRoomEnterResult, type CCBClientMessage } from '../src/shared/CCB';

const originalRoot = resolve(import.meta.dir, '../../../anime-character-guessr/server');
const sourceAvailable = existsSync(resolve(originalRoot, 'utils/socket.js'));
const character = (id: number): CCBCharacterView => ({
  id, name: `角色${id}`, nameCn: '', gender: '?', popularity: 1, summary: '本地联调题目',
  appearances: [], comparisonAppearances: [], extraTags: [], highestRating: -1, earliestAppearance: -1, latestAppearance: -1,
  subjectTags: ['校园'], characterTags: [], voiceActors: [], metaTags: ['校园'],
});
const data: CCBDataProvider = {
  async getCharacter(id) { return character(id); }, async chooseRandomCharacter() { return character(900); },
  async getRawCharacter(id): Promise<CCBRawCharacter> { return { ...character(id), aliases: [], appearances: [], extraTagsBySubject: {} }; },
  async searchCharacters() { return []; }, async searchSubjects() { return []; }, async getSubjectCharacters() { return []; },
  async importDirectory(id) { return { id, subjectIds: [], missingSubjectIds: [], importedAt: 0 }; },
  async resolveCharacterImage() { return undefined; }, close() {},
};
test.skipIf(!sourceAvailable)('真实原版与增强客户端在本地同房同步猜测、聊天隔离和连续结算', async () => {
  const requireOriginal = createRequire(resolve(originalRoot, 'package.json'));
  const { Server } = requireOriginal('socket.io') as {
    Server: new(server: HttpServer, options: { path: string }) => { close(callback: () => void): void }
  };
  const setupSocket = requireOriginal('./utils/socket.js') as (io: unknown, rooms: Map<string, unknown>) => void;
  const rooms = new Map<string, unknown>();
  const http = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([...rooms.keys()].map(id => ({ id, isPublic: true, playerCount: 3 }))));
  });
  const upstream = new Server(http, { path: '/api/ws' });
  setupSocket(upstream, rooms);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('本地监听失败');
  const url = `http://127.0.0.1:${address.port}`;
  const service = new CCBOriginalService({ data, serverUrl: url, aesSecret: process.env.CCB_ORIGINAL_AES_SECRET || 'My-Secret-Key' });
  const tokens = new Map<string, string>();
  const execute = async (id: string, message: CCBClientMessage): Promise<unknown> => {
    const result = await service.execute(id, { ...message, sessionToken: tokens.get(id) });
    if (result && typeof result === 'object' && 'sessionToken' in result && typeof result.sessionToken === 'string') tokens.set(id, result.sessionToken);
    return result;
  };
  const original = connect(url, { path: '/api/ws', transports: ['websocket'], reconnection: false });
  const packets: unknown[] = [];
  service.registerConnection({ id: 'host', lobbySubscribed: false, send: value => packets.push(value), close() {} });
  service.registerConnection({ id: 'guest', lobbySubscribed: false, send: value => packets.push(value), close() {} });
  try {
    const entered = await execute('host', { id: 'create', type: 'ccb.room.create', payload: {
      source: 'original', roomId: '1234', name: '混合联调', userName: '增强房主', visibility: 'public', allowSpectators: true,
    } }) as CCBRoomEnterResult;
    expect(entered.snapshot.name).toBe('混合联调');
    if (!original.connected) await once(original, 'connect');
    original.emit('joinRoom', { roomId: '1234', username: '原版玩家' });
    await once(original, 'updatePlayers');
    original.emit('toggleReady', { roomId: '1234' });
    await execute('guest', { id: 'join', type: 'ccb.room.join', roomId: '1234', payload: { source: 'original', userName: '增强玩家' } });
    await execute('guest', { id: 'ready', type: 'ccb.player.ready', payload: { ready: true } });
    await execute('host', { id: 'spectate', type: 'ccb.player.spectate', payload: { spectator: true } });
    await execute('host', { id: 'settings', type: 'ccb.room.settings', payload: {
      settings: { ...createDefaultCCBSettings(), syncMode: true, nonstopMode: true, tagBan: true, timeLimit: 0 },
    } });
    const state = () => execute('guest', { id: crypto.randomUUID(), type: 'ccb.room.requestSync', payload: {} }) as Promise<CCBRoomEnterResult>;
    await execute('host', { id: 'start', type: 'ccb.game.start', payload: {} });
    await execute('guest', { id: 'guess1', type: 'ccb.game.guess', payload: { characterId: 901 } });
    const firstRound = await original.timeout(3000).emitWithAck('playerGuess', { roomId: '1234', sharedMetaTags: ['最后标签'],
      guessResult: { guessData: { id: 902, name: '原版错误', appearances: [], rawTags: [] } } });
    expect(firstRound.tagBanApplied).toBe(true);
    expect((await state()).snapshot.syncRound).toBe(2);
    await execute('guest', { id: 'win1', type: 'ccb.game.guess', payload: { characterId: 900 } });
    const ending = once(original, 'gameEnded');
    const win = await original.timeout(3000).emitWithAck('playerGuess', { roomId: '1234', sharedMetaTags: [],
      guessResult: { guessData: { id: 900, name: '原版猜中', appearances: [], rawTags: [] } } });
    expect(win.settlement.rank).toBe(1);
    await ending;
    await Bun.sleep(30);
    const result = await state();
    expect(result.snapshot.phase).toBe('settled');
    expect(result.snapshot.roundSummary?.scores.filter(score => score.base).map(score => score.rank)).toEqual([1, 1]);
    expect(result.snapshot.roundSummary?.scores.filter(score => score.base).map(score => score.score)).toEqual([4, 4]);
    await execute('guest', { id: 'chat', type: 'ccb.chat.send', payload: { text: '增强版频道' } });
    expect((await state()).snapshot.chat.at(-1)?.text).toBe('增强版频道');
    await execute('host', { id: 'next', type: 'ccb.game.next', payload: {} });
    await Bun.sleep(30);
    expect((await state()).snapshot.roundNumber).toBe(2);
    expect((await state()).privateState.guesses).toEqual([]);
  } finally {
    service.close(); original.disconnect();
    http.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(resolve));
  }
}, 15000);
