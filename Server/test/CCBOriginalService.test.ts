import { afterEach, describe, expect, test } from 'bun:test';
import { CCBOriginalService } from '../src/application/CCBOriginalService';
import type { ConnectionRecord } from '../src/domain/Model';
import { encodeOriginalCharacter } from '../src/infrastructure/CCBOriginalProtocol';
import { createDefaultCCBSettings, type CCBClientMessage, type CCBRoomEnterResult } from '../src/shared/CCB';

import { originalCharacter as character, originalData as data, FixtureRoom } from './CCBOriginalFixtures';

const services: CCBOriginalService[] = [];
afterEach(() => services.splice(0).forEach(service => service.close()));

function setup(options: Partial<ConstructorParameters<typeof CCBOriginalService>[0]> = {}) {
  const upstream = new FixtureRoom();
  const service = new CCBOriginalService({ data, serverUrl: 'https://original.example', aesSecret: 'fixture-key',
    socketFactory: upstream.factory, fetcher: async () => Response.json([{ id: '1234', isPublic: true, playerCount: 2 }]),
    imageHints: { async render(_url, level) { return `data:image/webp;base64,blur-${level}`; } }, ...options });
  services.push(service);
  const packets: unknown[] = [];
  const connection = (id: string): ConnectionRecord => ({ id, lobbySubscribed: false, send: packet => packets.push(packet), close() {} });
  const first = connection('first'); service.registerConnection(first);
  return { service, upstream, packets, first, connection };
}
const tokens = new WeakMap<CCBOriginalService, Map<string, string>>();
const request = async (service: CCBOriginalService, id: string, message: CCBClientMessage): Promise<unknown> => {
  if (!tokens.has(service)) tokens.set(service, new Map());
  const result = await service.execute(id, { ...message, sessionToken: message.sessionToken ?? tokens.get(service)!.get(id) });
  if (result && typeof result === 'object' && 'sessionToken' in result && typeof result.sessionToken === 'string') tokens.get(service)!.set(id, result.sessionToken);
  return result;
};
const create = (service: CCBOriginalService, id = 'first', name = '甲') => request(service, id, {
  id: 'create', type: 'ccb.room.create', payload: { source: 'original', roomId: '1234', name: '测试房间', userName: name, visibility: 'public', allowSpectators: true },
}) as Promise<CCBRoomEnterResult>;
const sync = (service: CCBOriginalService, id = 'first') => request(service, id, { id: 'sync', type: 'ccb.room.requestSync', payload: {} }) as Promise<CCBRoomEnterResult>;

describe('原版房间适配', () => {
  test('加入检查尚未完成时拒绝重复加入，客户端断线后不创建上游会话', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const { service, upstream } = setup({ fetcher: () => pending });
    const join = { id: 'join', type: 'ccb.room.join', roomId: '1234', payload: { source: 'original', userName: '甲' } } as const;
    const first = request(service, 'first', join);
    expect(service.hasSession('first')).toBe(true);
    await expect(request(service, 'first', { ...join, id: 'duplicate' })).rejects.toMatchObject({ code: 'CCB_JOIN_PENDING' });
    service.unregisterConnection('first');
    release(Response.json([{ id: '1234' }]));
    await expect(first).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
    expect(upstream.sockets).toHaveLength(0);
  });

  test('配置缺失明确不可用，陌生房号不发送会意外建房的加入事件', async () => {
    const missing = setup({ serverUrl: undefined, aesSecret: undefined });
    await expect(create(missing.service)).rejects.toMatchObject({ code: 'CCB_ORIGINAL_UNAVAILABLE' });
    expect(missing.upstream.sockets).toHaveLength(0);
    const { service, upstream } = setup({ fetcher: async () => Response.json([]) });
    await expect(request(service, 'first', { id: 'join', type: 'ccb.room.join', roomId: '5678', payload: { source: 'original', userName: '甲' } })).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
    expect(upstream.sockets).toHaveLength(0);
  });

  test('原版私密房可按房号加入，但不展示在大厅列表', async () => {
    const { service, upstream } = setup({ fetcher: async () => Response.json([{ id: '1234', isPublic: false, playerCount: 1 }]) });
    expect(await service.listRooms()).toEqual([]);
    const entered = await request(service, 'first', { id: 'private-join', type: 'ccb.room.join', roomId: '1234', payload: { source: 'original', userName: '甲' } }) as CCBRoomEnterResult;
    expect(entered.roomId).toBe('1234');
    expect(upstream.sockets[0].sent[0]).toMatchObject({ event: 'joinRoom' });
  });

  test('创建和更新长房名按原版三十字限制确认，不误报已成功的操作超时', async () => {
    const { service } = setup();
    const name = '很长的角色猜测房间名称'.repeat(3).slice(0, 32);
    const entered = await request(service, 'first', { id: 'long-create', type: 'ccb.room.create', payload: {
      source: 'original', roomId: '1234', name, userName: '甲', visibility: 'public', allowSpectators: true,
    } }) as CCBRoomEnterResult;
    expect(entered.snapshot.name).toBe(name.slice(0, 30));
    const updated = '另一间用于多人猜测的角色房间名称';
    await request(service, 'first', { id: 'long-update', type: 'ccb.room.update', payload: {
      name: updated, visibility: 'public', allowSpectators: true,
    } });
    expect((await sync(service)).snapshot.name).toBe(updated);
  });

  test('关闭作品搜索时猜题者不能绕过查询限制，零阈值提示对观战者也不显示', async () => {
    const { service, upstream } = setup();
    await create(service);
    upstream.broadcast('gameStart', { character: encodeOriginalCharacter(character(), 'fixture-key'),
      settings: { ...createDefaultCCBSettings(), subjectSearch: false, useHints: [0, 3] },
      players: upstream.players, hints: ['禁用提示', '允许提示'] });
    for (const command of [
      { type: 'ccb.subject.search', payload: { keyword: '作品' } },
      { type: 'ccb.subject.characters', payload: { subjectId: 10 } },
    ] as const) await expect(request(service, 'first', { id: crypto.randomUUID(), ...command })).rejects.toMatchObject({ code: 'SUBJECT_SEARCH_DISABLED' });
    upstream.players[0].team = '0';
    upstream.broadcast('updatePlayers', { players: upstream.players });
    expect((await sync(service)).privateState.hints).toEqual(['允许提示']);
    expect(await request(service, 'first', { id: 'observer-search', type: 'ccb.subject.search', payload: { keyword: '作品' } })).toEqual({ results: [] });
    upstream.broadcast('gameEnded', { guesses: [], scoreDetails: [] });
    expect((await sync(service)).privateState.hints).toEqual(['允许提示']);
  });

  test('每位玩家独立上游会话，仅确认加入的增强玩家共享聊天，离开即撤权', async () => {
    const { service, upstream, first, connection } = setup();
    const created = await create(service);
    expect(created.source).toBe('original'); expect(first.roomId).toBe('original:1234');
    expect(upstream.sockets[0].sent[0].payload).toEqual({ roomId: '1234', username: '甲' });
    const second = connection('second'); service.registerConnection(second);
    await request(service, 'second', { id: 'join', type: 'ccb.room.join', roomId: '1234', payload: { source: 'original', userName: '乙' } });
    expect(upstream.sockets).toHaveLength(2);
    await expect(request(service, 'first', { id: 'invalid', type: 'ccb.chat.send', sessionToken: 'wrong-token', payload: { text: '冒名消息' } })).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    await request(service, 'first', { id: 'chat', type: 'ccb.chat.send', payload: { text: '你好' } });
    expect((await sync(service, 'second')).snapshot.chat[0].text).toBe('你好');
    expect(upstream.sockets.every(socket => socket.sent.every(item => item.event !== 'updatePlayerMessage'))).toBe(true);
    await request(service, 'first', { id: 'leave', type: 'ccb.room.leave', payload: {} });
    await expect(request(service, 'first', { id: 'chat', type: 'ccb.chat.send', payload: { text: '不能发送' } })).rejects.toMatchObject({ code: 'NOT_IN_ROOM' });
    expect(first.roomId).toBeUndefined();
  });

  test('裁剪敌方历史、答案及被禁标签，解锁后仅返回加工后的图片', async () => {
    const { service, upstream, packets } = setup();
    await create(service);
    const me = upstream.players[0];
    const other = { id: 'enemy', username: '原版玩家', ready: true, isHost: false, team: null, guesses: '', score: 0 };
    upstream.players.push(other);
    const settings = { ...createDefaultCCBSettings(), tagBan: true, useHints: [3], useImageHint: 3 };
    upstream.broadcast('gameStart', { character: encodeOriginalCharacter(character(), 'fixture-key'), settings, players: upstream.players, isPublic: true, hints: ['不会泄露的提示'] });
    const rawGuess = { id: 901, name: '猜测', appearances: ['作品'], appearanceIds: [10], rawTags: [['校园', 1]], metaTags: ['校园'] };
    upstream.broadcast('guessHistoryUpdate', { guesses: [
      { username: '甲', guesses: [{ playerId: me.id, guessData: rawGuess, isCorrect: false, isPartialCorrect: true }] },
      { username: '原版玩家', guesses: [{ playerId: 'enemy', guessData: { ...rawGuess, id: 902 }, isCorrect: false }] },
    ] });
    upstream.broadcast('tagBanStateUpdate', { tagBanState: [{ tag: '校园', revealer: ['enemy'] }] });
    let state = await sync(service);
    expect(state.privateState.answer).toBeNull(); expect(state.privateState.hints).toEqual([]);
    expect(state.privateState.guesses).toHaveLength(1);
    expect(state.privateState.guesses[0].feedback.tags[0]).toEqual({ text: '', matched: false, hidden: true, kind: 'subject' });
    expect(state.snapshot.roundSummary).toBeNull();
    await expect(request(service, 'first', { id: 'hint', type: 'ccb.game.imageHint', payload: {} })).rejects.toMatchObject({ code: 'CCB_HINT_LOCKED' });
    me.guesses = '❌'.repeat(7);
    upstream.broadcast('updatePlayers', { players: upstream.players });
    upstream.broadcast('resetTimer', { deadlineAt: 123456 });
    state = await sync(service);
    expect(state.privateState.hints).toEqual(['不会泄露的提示']);
    expect(state.privateState.deadlineAt).toBe(123456);
    upstream.broadcast('resetTimer', undefined);
    expect(service.hasSession('first')).toBe(true);
    expect(await request(service, 'first', { id: 'hint', type: 'ccb.game.imageHint', payload: {} })).toEqual({ dataUrl: 'data:image/webp;base64,blur-3' });
    expect(JSON.stringify(packets)).not.toContain('https://images.example/900.jpg');
  });

  test('拒绝猜测不登记标签，接受猜测只传服务端算出的反馈', async () => {
    const { service, upstream } = setup(); await create(service);
    upstream.broadcast('gameStart', { character: encodeOriginalCharacter(character(), 'fixture-key'),
      settings: { ...createDefaultCCBSettings(), tagBan: true }, players: upstream.players, isPublic: true });
    const socket = upstream.sockets[0]; socket.failGuess = true;
    await expect(request(service, 'first', { id: 'guess', type: 'ccb.game.guess', payload: { characterId: 901 } })).rejects.toMatchObject({ code: 'CCB_ORIGINAL_REJECTED' });
    expect(socket.sent.some(item => item.event === 'tagBanSharedMetaTags')).toBe(false);
    socket.failGuess = false;
    await request(service, 'first', { id: 'guess', type: 'ccb.game.guess', payload: { characterId: 901 } });
    expect(socket.sent.at(-1)).toMatchObject({ event: 'tagBanSharedMetaTags', payload: { tags: ['校园', '眼镜', '声优'] } });
    expect(socket.sent.filter(item => item.event === 'playerGuess').at(-1)).toMatchObject({ payload: { guessResult: { isCorrect: false, isPartialCorrect: true } } });
    socket.atomicTags = true;
    const previousTagEvents = socket.sent.filter(item => item.event === 'tagBanSharedMetaTags').length;
    await request(service, 'first', { id: 'guess-new', type: 'ccb.game.guess', payload: { characterId: 902 } });
    expect(socket.sent.at(-1)).toMatchObject({ event: 'playerGuess', payload: { sharedMetaTags: ['校园', '眼镜', '声优'] } });
    expect(socket.sent.filter(item => item.event === 'tagBanSharedMetaTags')).toHaveLength(previousTagEvents);
  });

  test('前端重连复用上游连接，超时清会话聊天，被踢立即撤权', async () => {
    let now = 100;
    const { service, upstream, connection } = setup({ now: () => now });
    const entered = await create(service);
    await request(service, 'first', { id: 'chat', type: 'ccb.chat.send', payload: { text: '旧房聊天' } });
    service.unregisterConnection('first');
    const replacement = connection('replacement'); service.registerConnection(replacement);
    const restored = await request(service, 'replacement', { id: 'reconnect', type: 'ccb.room.reconnect',
      payload: { source: 'original', roomId: '1234', sessionToken: entered.sessionToken } }) as CCBRoomEnterResult;
    expect(restored.snapshot.chat).toHaveLength(1); expect(upstream.sockets).toHaveLength(1);
    upstream.sockets[0].receive('playerKicked', { playerId: upstream.sockets[0].id });
    expect(service.hasSession('replacement')).toBe(false); expect(replacement.roomId).toBeUndefined();
    expect(service.getHealthSnapshot().rooms).toBe(0);
    const next = await create(service, 'replacement', '丙');
    expect(next.snapshot.chat).toEqual([]);
    service.unregisterConnection('replacement'); now += 60_001; service.runHousekeeping();
    expect(service.getHealthSnapshot().sessions).toBe(0);
  });

  test('原版结算保留分数和并列名次，下一局清空历史并保留房间聊天', async () => {
    const { service, upstream } = setup(); await create(service);
    await request(service, 'first', { id: 'start', type: 'ccb.game.start', payload: {} });
    upstream.broadcast('nonstopProgress', { winners: [{ username: '甲', rank: 1, score: 15 }] });
    upstream.broadcast('gameEnded', { guesses: [], scoreDetails: [{ type: 'player', id: upstream.sockets[0].id, username: '甲', score: 15,
      breakdown: { rank: 1, base: 3, bigWin: 12 } }] });
    expect((await sync(service)).snapshot.roundSummary?.scores[0]).toMatchObject({ score: 15, rank: 1, firstGuess: 12 });
    await request(service, 'first', { id: 'next', type: 'ccb.game.next', payload: {} });
    const next = await sync(service);
    expect(next.snapshot.phase).toBe('guessing'); expect(next.snapshot.roundNumber).toBe(2);
    expect(next.snapshot.roundSummary).toBeNull(); expect(next.privateState.guesses).toEqual([]);
  });
});
