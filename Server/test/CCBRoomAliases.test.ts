import { afterEach, describe, expect, test } from 'bun:test';
import { CCBOriginalService } from '../src/application/CCBOriginalService';
import { CCBService } from '../src/application/CCBService';
import { AppError } from '../src/domain/Errors';
import { ROOM_ID_TEST_MODE, type CCBClientMessage, type CCBCommand, type CCBPayload, type CCBRoomEnterResult,
  type CCBRoomSnapshot, type CCBRoomSummary, type ConnectionRecord } from '../src/shared/Index';
import { FixtureRoom, originalData } from './CCBOriginalFixtures';

const UUID_PUBLIC = '6b0d3c1e-2f4a-4e5b-9c7d-8e9f0a1b2c3d';
const UUID_PRIVATE = 'c4d5e6f7-0819-4a2b-8c3d-4e5f60718293';

const services: CCBService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); });

function setup() {
  let clock = 1_000_000;
  let fetches = 0;
  let failSockets = false;
  const upstream = new FixtureRoom();
  const upstreamRooms = [
    { id: '4321', isPublic: true, playerCount: 2, hostName: '原版房主', displayRoomName: '原版四位房' },
    { id: UUID_PUBLIC, isPublic: true, playerCount: 3, hostName: '原版玩家', displayRoomName: '原版公开房' },
    { id: UUID_PRIVATE, isPublic: false, playerCount: 1, hostName: '原版好友', displayRoomName: '原版私密房' },
  ];
  const original = new CCBOriginalService({ data: originalData, serverUrl: 'https://aliases.invalid', aesSecret: 'alias-key', now: () => clock,
    socketFactory: () => { if (failSockets) throw new AppError('CCB_ORIGINAL_UNAVAILABLE', '暂时无法连接原版服务器'); return upstream.factory(); },
    fetcher: async () => { fetches++; return Response.json(upstreamRooms); } });
  const service = new CCBService({ data: originalData, now: () => clock, originalService: original });
  services.push(service);
  const tokens = new Map<string, string>();
  const outbox = new Map<string, unknown[]>();
  const connect = (id: string) => {
    const sent: unknown[] = [];
    outbox.set(id, sent);
    const record: ConnectionRecord = { id, lobbySubscribed: false, send: packet => sent.push(structuredClone(packet)), close() {} };
    service.registerConnection(record);
  };
  const send = async <T extends CCBCommand>(id: string, type: T, payload: CCBPayload<T>, roomId?: string) => {
    const result = await service.execute(id, { id: crypto.randomUUID(), type, payload, roomId, sessionToken: tokens.get(id) } as CCBClientMessage);
    if (result && typeof result === 'object' && 'sessionToken' in result) tokens.set(id, String(result.sessionToken));
    return result;
  };
  const snapshot = (id: string) => [...outbox.get(id)!].reverse()
    .map(packet => packet as { event?: string; payload?: CCBRoomSnapshot })
    .find(packet => packet.event === 'ccb.room.snapshot')!.payload!;
  return { service, upstream, connect, send, snapshot,
    fetches: () => fetches, advance: (ms: number) => { clock += ms; }, failSockets: (value: boolean) => { failSockets = value; } };
}

const createNative = (roomId: string, name = '增强房') =>
  ({ source: 'native' as const, roomId, name, userName: '房主', visibility: 'public' as const, allowSpectators: true });
const createOriginal = (roomId: string, name = '原版新房') =>
  ({ source: 'original' as const, roomId, name, userName: '房主', visibility: 'public' as const, allowSpectators: true });

describe('CCB 统一房号路由', () => {
  test('大厅合并增强房与原版公开房，UUID 房显示 4 位别名，非公开房不进大厅，确认包不含服务器标识', async () => {
    const h = setup(); h.connect('host'); h.connect('lobby');
    await h.send('host', 'ccb.room.create', createNative('1234'));
    const lobby = await h.send('lobby', 'ccb.lobby.subscribeRooms', {}) as { rooms: CCBRoomSummary[]; originalAvailable: boolean };
    const alias = h.service.directory.aliasOf(UUID_PUBLIC)!;
    expect(alias).toMatch(/^\d{4}$/);
    expect(lobby).toEqual({ originalAvailable: true, rooms: [
      { roomId: '1234', source: 'native', name: '增强房', phase: 'waiting', playerCount: 1, spectatorCount: 0, hasPassword: false, allowSpectators: true },
      { roomId: '4321', source: 'original', name: '原版四位房', phase: 'waiting', playerCount: 2, spectatorCount: null, hasPassword: false, allowSpectators: true },
      { roomId: alias, source: 'original', name: '原版公开房', phase: 'waiting', playerCount: 3, spectatorCount: null, hasPassword: false, allowSpectators: true },
    ] });
    expect(h.service.directory.aliasOf(UUID_PRIVATE)).toMatch(/^\d{4}$/);
  });

  test('凭别名进入原版 UUID 房：上游收到真实房号，客户端只见到别名，信封用上游房号会被拒绝', async () => {
    const h = setup(); h.connect('lobby'); h.connect('player');
    await h.send('lobby', 'ccb.lobby.subscribeRooms', {});
    const alias = h.service.directory.aliasOf(UUID_PUBLIC)!;
    const entered = await h.send('player', 'ccb.room.join', { userName: '玩家' }, alias) as CCBRoomEnterResult;
    expect(entered).toMatchObject({ roomId: alias, source: 'original' });
    expect(entered.snapshot.roomId).toBe(alias);
    expect(h.upstream.sockets[0].sent[0]).toEqual({ event: 'joinRoom', payload: { roomId: UUID_PUBLIC, username: '玩家' } });
    await h.send('player', 'ccb.chat.send', { text: '你好' }, alias);
    expect(h.snapshot('player')).toMatchObject({ roomId: alias, chat: [{ text: '你好' }] });
    await expect(h.send('player', 'ccb.chat.send', { text: '错号' }, UUID_PUBLIC)).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
  });

  test('原版非公开房不进大厅，但可凭分享的别名进入', async () => {
    const h = setup(); h.connect('lobby'); h.connect('friend');
    const lobby = await h.send('lobby', 'ccb.lobby.subscribeRooms', {}) as { rooms: CCBRoomSummary[] };
    const alias = h.service.directory.aliasOf(UUID_PRIVATE)!;
    expect(lobby.rooms.map(room => room.roomId)).not.toContain(alias);
    const entered = await h.send('friend', 'ccb.room.join', { userName: '好友' }, alias) as CCBRoomEnterResult;
    expect(entered.roomId).toBe(alias);
    expect(h.upstream.sockets[0].sent[0].payload).toEqual({ roomId: UUID_PRIVATE, username: '好友' });
  });

  test('服务重启后首个分享链接回源一次即可解析，缓存期内未知房号不重复回源', async () => {
    const warm = setup(); warm.connect('lobby');
    await warm.send('lobby', 'ccb.lobby.subscribeRooms', {});
    const alias = warm.service.directory.aliasOf(UUID_PUBLIC)!;
    const h = setup(); h.connect('player'); h.connect('stranger');
    expect((await h.send('player', 'ccb.room.join', { userName: '玩家' }, alias) as CCBRoomEnterResult).roomId).toBe(alias);
    h.advance(5_001);
    const before = h.fetches();
    await expect(h.send('stranger', 'ccb.room.join', { userName: '路人' }, '9999')).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
    await expect(h.send('stranger', 'ccb.room.join', { userName: '路人' }, '9998')).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
    expect(h.fetches() - before).toBe(1);
  });

  test('增强房与原版房互不占号，原版建房失败时释放占号', async () => {
    const h = setup(); for (const id of ['lobby', 'a', 'b', 'c']) h.connect(id);
    await h.send('lobby', 'ccb.lobby.subscribeRooms', {});
    const alias = h.service.directory.aliasOf(UUID_PUBLIC)!;
    await expect(h.send('a', 'ccb.room.create', createNative(alias))).rejects.toMatchObject({ code: 'ROOM_EXISTS' });
    await h.send('a', 'ccb.room.create', createNative('2468'));
    await expect(h.send('b', 'ccb.room.create', createOriginal('2468'))).rejects.toMatchObject({ code: 'ROOM_EXISTS' });
    await expect(h.send('b', 'ccb.room.create', createOriginal('4321'))).rejects.toMatchObject({ code: 'ROOM_EXISTS' });
    h.failSockets(true);
    await expect(h.send('b', 'ccb.room.create', createOriginal('1357'))).rejects.toMatchObject({ code: 'CCB_ORIGINAL_UNAVAILABLE' });
    expect(h.service.directory.resolve('1357')).toBeNull();
    await h.send('c', 'ccb.room.create', createNative('1357'));
    expect(h.service.directory.resolve('1357')).toEqual({ source: 'native', roomId: '1357' });
  });

  test('本站新建的原版房在上游列表出现前保留房号，全员离开且上游无此房后释放', async () => {
    const h = setup(); h.connect('host'); h.connect('lobby');
    const entered = await h.send('host', 'ccb.room.create', createOriginal('1357')) as CCBRoomEnterResult;
    expect(entered).toMatchObject({ roomId: '1357', source: 'original' });
    h.advance(5_001);
    await h.send('lobby', 'ccb.lobby.subscribeRooms', {});
    expect(h.service.directory.resolve('1357')).toEqual({ source: 'original', roomId: '1357', upstreamRoomId: '1357' });
    await h.send('host', 'ccb.room.leave', {}, '1357');
    h.advance(5_001);
    await h.send('lobby', 'ccb.lobby.subscribeRooms', {});
    expect(h.service.directory.resolve('1357')).toBeNull();
  });

  test('原版会话凭别名恢复，继续使用同一条上游连接', async () => {
    const h = setup(); h.connect('lobby'); h.connect('player');
    await h.send('lobby', 'ccb.lobby.subscribeRooms', {});
    const alias = h.service.directory.aliasOf(UUID_PUBLIC)!;
    const entered = await h.send('player', 'ccb.room.join', { userName: '玩家' }, alias) as CCBRoomEnterResult;
    await h.service.unregisterConnection('player');
    h.connect('replacement');
    const resumed = await h.send('replacement', 'ccb.room.reconnect', { roomId: alias, sessionToken: entered.sessionToken }) as CCBRoomEnterResult;
    expect(resumed).toMatchObject({ roomId: alias, source: 'original' });
    expect(resumed.privateState.playerId).toBe(entered.privateState.playerId);
    expect(h.upstream.sockets).toHaveLength(1);
  });

  test('测试房号大小写不敏感地解析为增强房', async () => {
    const h = setup(); h.connect('host'); h.connect('guest');
    await h.send('host', 'ccb.room.create', createNative(ROOM_ID_TEST_MODE, '测试房'));
    const entered = await h.send('guest', 'ccb.room.join', { userName: '访客' }, ROOM_ID_TEST_MODE.toLowerCase()) as CCBRoomEnterResult;
    expect(entered).toMatchObject({ roomId: ROOM_ID_TEST_MODE, source: 'native' });
  });
});
