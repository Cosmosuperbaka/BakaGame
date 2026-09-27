import { afterEach, describe, expect, test } from 'bun:test';
import { applyPatch, type Operation } from 'fast-json-patch';
import { CCBService } from '../src/application/CCBService';
import { CCBOriginalService } from '../src/application/CCBOriginalService';
import { WhoIsFakerService } from '../src/application/WhoIsFakerService';
import { EventLogger } from '../src/infrastructure/EventLogger';
import { WordBankRepository } from '../src/infrastructure/WordBankRepository';
import { createDefaultCCBSettings, SERVER_SHUTDOWN_MESSAGE, type CCBClientMessage, type CCBCommand,
  type CCBPayload, type CCBPrivateState, type CCBRoomEnterResult, type CCBRoomSnapshot,
  type CCBRoomSummary, type CCBSource, type StateSyncPayload } from '../src/shared/Index';
import { createTestApp } from './AppFixtures';
import { FixtureRoom, originalData } from './CCBOriginalFixtures';

interface Packet { type: string; id?: string; event?: string; payload?: unknown; error?: { code: string } }
class TransportClient {
  readonly socket: WebSocket;
  readonly packets: Packet[] = [];
  readonly states = new Map<string, unknown>();
  private readonly revisions = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  token?: string;
  roomId = '1234';
  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/api/ccb/ws`);
    this.socket.addEventListener('message', (event: MessageEvent<string>) => {
      const packet = JSON.parse(event.data) as Packet;
      this.packets.push(packet);
      if (packet.event === 'ccb.room.snapshot' || packet.event === 'ccb.game.privateState') {
        const sync = packet.payload as StateSyncPayload<unknown>;
        if (sync.mode === 'full') this.states.set(packet.event, sync.state);
        else {
          expect(sync.baseRevision).toBe(this.revisions.get(packet.event)!);
          this.states.set(packet.event, applyPatch(structuredClone(this.states.get(packet.event)), sync.operations as Operation[], true).newDocument);
        }
        this.revisions.set(packet.event, sync.revision);
      }
      for (const listener of this.listeners) listener();
    });
  }
  async open() {
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener('error', () => reject(new Error('测试连接失败')), { once: true });
    });
  }
  wait(predicate: (packet: Packet) => boolean, from = 0): Promise<Packet> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(check); reject(new Error('等待角色游戏消息超时')); }, 3000);
      const check = () => {
        const packet = this.packets.slice(from).find(predicate);
        if (packet) { clearTimeout(timer); this.listeners.delete(check); resolve(packet); }
      };
      this.listeners.add(check); check();
    });
  }
  request(message: CCBClientMessage) {
    const result = this.wait(packet => packet.id === message.id && (packet.type === 'ack' || packet.type === 'error'), this.packets.length);
    this.socket.send(JSON.stringify(message));
    return result;
  }
  /** 未显式给出房号时沿用上次进入的房间，与前端 Store 的信封口径一致。 */
  async command<T = Record<string, never>, K extends CCBCommand = CCBCommand>(type: K, payload: CCBPayload<K>, roomId = this.roomId): Promise<T> {
    const packet = await this.request({ id: crypto.randomUUID(), type, payload, roomId, sessionToken: this.token } as CCBClientMessage);
    expect(packet.type).toBe('ack');
    if (packet.payload && typeof packet.payload === 'object' && 'sessionToken' in packet.payload) {
      this.token = String(packet.payload.sessionToken);
      if ('roomId' in packet.payload) this.roomId = String(packet.payload.roomId);
    }
    return packet.payload as T;
  }
  snapshot() { return this.states.get('ccb.room.snapshot') as CCBRoomSnapshot; }
  privateState() { return this.states.get('ccb.game.privateState') as CCBPrivateState; }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => {
      this.socket.addEventListener('close', () => resolve(), { once: true });
      this.socket.close();
    });
  }
}

const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0)) await release(); });
function setup(options: { fetcher?: typeof fetch; initialClock?: number } = {}) {
  let clock = options.initialClock ?? 1_000_000;
  let fetchCount = 0;
  const logger = new EventLogger(() => {});
  const upstream = new FixtureRoom();
  const original = new CCBOriginalService({ data: originalData, serverUrl: 'https://original.invalid', aesSecret: 'transport-fixture',
    now: () => clock, socketFactory: upstream.factory,
    fetcher: async (...args) => { fetchCount++; return options.fetcher ? options.fetcher(...args) : Response.json([{ id: ORIGINAL_ROOM, isPublic: true, playerCount: upstream.players.length }]); },
  });
  const service = new CCBService({ data: originalData, now: () => clock, originalService: original, eventLogger: logger });
  const { app } = createTestApp({
    env: { clientUrl: 'http://localhost:5173', serverUrl: 'http://127.0.0.1', serverListenHost: '127.0.0.1', serverPort: 0,
      wordBankPath: ':memory:', bangumiApiUrl: 'https://bangumi.invalid', bangumiImageUrl: '' },
    whoIsFakerService: new WhoIsFakerService({ eventLogger: logger, wordBankRepository: new WordBankRepository(':memory:') }),
    ccbService: service, logger,
  });
  app.listen({ hostname: '127.0.0.1', port: 0 });
  const port = app.server!.port!;
  const clients: TransportClient[] = [];
  releases.push(async () => { await Promise.all(clients.map(client => client.close())); await app.stop(true); });
  return { service, original, upstream, port, fetchCount: () => fetchCount,
    advance: (milliseconds: number) => { clock += milliseconds; },
    connect: async () => { const client = new TransportClient(port); clients.push(client); await client.open(); return client; },
  };
}
/** 统一房号：增强房与原版房不能同号，测试各用一个固定号。 */
const NATIVE_ROOM = '1234';
const ORIGINAL_ROOM = '5678';
const create = (client: TransportClient, source: CCBSource, name = '房主') => client.command<CCBRoomEnterResult>('ccb.room.create', {
  source, roomId: source === 'native' ? NATIVE_ROOM : ORIGINAL_ROOM, name: '测试房间', userName: name, visibility: 'public', allowSpectators: true,
});
const join = (client: TransportClient, roomId: string, name = '玩家') => client.command<CCBRoomEnterResult>('ccb.room.join', { userName: name }, roomId);
const errorRequest = (client: TransportClient, token: string) => client.request({ id: crypto.randomUUID(), type: 'ccb.chat.send',
  roomId: '1234', sessionToken: token, payload: { text: '不应发送' } });

describe('角色游戏真实双来源传输', () => {
  test('统一房号下双来源房间隔离聊天与凭据，连接切换后重新发送全量状态，停机通知无重复', async () => {
    const fixture = setup();
    const nativeHost = await fixture.connect(), originalHost = await fixture.connect(), member = await fixture.connect();
    const nativeEntry = await create(nativeHost, 'native');
    const originalEntry = await create(originalHost, 'original');
    await join(member, NATIVE_ROOM);
    await member.command('ccb.chat.send', { text: '仅增强房可见' });
    expect(nativeHost.snapshot().chat.some(chat => chat.text === '仅增强房可见')).toBe(true);
    expect(originalHost.snapshot().chat).toHaveLength(0);
    expect((await errorRequest(nativeHost, originalEntry.sessionToken)).error?.code).toBe('SESSION_INVALID');
    expect((await errorRequest(originalHost, nativeEntry.sessionToken)).error?.code).toBe('SESSION_INVALID');
    await member.command('ccb.room.leave', {});
    const switchFrom = member.packets.length;
    const entered = await join(member, ORIGINAL_ROOM);
    expect(entered.source).toBe('original');
    expect(member.snapshot().source).toBe('original');
    expect(member.snapshot().chat).toHaveLength(0);
    for (const event of ['ccb.room.snapshot', 'ccb.game.privateState']) {
      const first = member.packets.slice(switchFrom).find(packet => packet.event === event)!;
      expect(first.payload).toMatchObject({ mode: 'full', revision: 1 });
    }
    await member.command('ccb.chat.send', { text: '仅兼容房可见' });
    expect(originalHost.snapshot().chat.map(chat => chat.text)).toEqual(['仅兼容房可见']);
    expect(nativeHost.snapshot().chat.some(chat => chat.text === '仅兼容房可见')).toBe(false);
    await member.command('ccb.room.leave', {});
    await join(member, NATIVE_ROOM);
    expect(member.snapshot().source).toBe('native');
    expect(member.snapshot().chat.some(chat => chat.text === '仅兼容房可见')).toBe(false);
    const health = await (await fetch(`http://127.0.0.1:${fixture.port}/health`)).json();
    expect(health).toMatchObject({ roomCount: 2, connectionCount: 3, onlinePlayerCount: 3 });
    fixture.service.notifyShutdown();
    for (const client of [nativeHost, originalHost, member]) {
      await client.wait(packet => packet.event === 'server.shutdown');
      expect(client.packets.filter(packet => packet.event === 'server.shutdown')).toHaveLength(1);
      expect(client.packets.find(packet => packet.event === 'server.shutdown')!.payload).toEqual({ message: SERVER_SHUTDOWN_MESSAGE });
    }
  });

  test('私有猜测使用差量且不广播给对手，原生断线重连返回完整私有状态', async () => {
    const fixture = setup();
    const host = await fixture.connect(), member = await fixture.connect();
    await create(host, 'native');
    const entry = await join(member, NATIVE_ROOM);
    await host.command('ccb.room.settings', { settings: { ...createDefaultCCBSettings(), timeLimit: 0 } });
    await member.command('ccb.player.ready', { ready: true });
    await host.command('ccb.game.start', {});
    const from = member.packets.length;
    await member.command('ccb.game.guess', { characterId: 901 });
    await member.command('ccb.game.guess', { characterId: 902 });
    expect(member.privateState().guesses.map(guess => guess.character.id)).toEqual([901, 902]);
    expect(member.privateState().answer).toBeNull();
    expect(host.privateState().guesses).toHaveLength(0);
    expect(host.privateState().answer).toBeNull();
    expect(member.packets.slice(from).some(packet => packet.event === 'ccb.game.privateState' && (packet.payload as StateSyncPayload<unknown>).mode === 'patch')).toBe(true);
    expect(host.snapshot().roundSummary).toBeNull();
    await member.close();
    const replacement = await fixture.connect();
    const resumed = await replacement.command<CCBRoomEnterResult>('ccb.room.reconnect', { roomId: NATIVE_ROOM, sessionToken: entry.sessionToken });
    expect(resumed.privateState.guesses).toHaveLength(2);
    expect(resumed.privateState.playerId).toBe(entry.privateState.playerId);
    expect(replacement.packets.find(packet => packet.event === 'ccb.game.privateState')!.payload).toMatchObject({ mode: 'full', revision: 1 });
    const syncFrom = replacement.packets.length;
    await replacement.command('ccb.room.requestSync', {});
    expect(replacement.packets.slice(syncFrom).find(packet => packet.event === 'ccb.game.privateState')!.payload).toMatchObject({ mode: 'full', revision: 1 });
  });

  test('原版断线恢复复用上游身份，拒绝跨来源或其他服务器凭据，离线人数准确', async () => {
    const fixture = setup();
    const host = await fixture.connect(), member = await fixture.connect();
    const local = await create(host, 'native');
    const original = await create(member, 'original');
    await member.command('ccb.chat.send', { text: '恢复时保留' });
    await member.close();
    const replacement = await fixture.connect();
    expect(fixture.service.getHealthSnapshot()).toMatchObject({ playerCount: 2, onlinePlayerCount: 1, connectionCount: 2 });
    const wrongNative = await replacement.request({ id: 'wrong-native', type: 'ccb.room.reconnect', payload: {
      roomId: NATIVE_ROOM, sessionToken: original.sessionToken,
    } });
    expect(wrongNative.error?.code).toBe('SESSION_NOT_FOUND');
    for (const token of [local.sessionToken, original.sessionToken.replace(fixture.original.sourceKey, '000000000000')]) {
      const rejected = await replacement.request({ id: crypto.randomUUID(), type: 'ccb.room.reconnect', payload: { roomId: ORIGINAL_ROOM, sessionToken: token } });
      expect(rejected.error?.code).toBe('SESSION_EXPIRED');
    }
    const resumed = await replacement.command<CCBRoomEnterResult>('ccb.room.reconnect', { roomId: ORIGINAL_ROOM, sessionToken: original.sessionToken });
    expect(resumed.privateState.playerId).toBe(original.privateState.playerId);
    expect(resumed.snapshot.chat.map(chat => chat.text)).toEqual(['恢复时保留']);
    expect(fixture.upstream.sockets).toHaveLength(1);
    expect(fixture.service.getHealthSnapshot().onlinePlayerCount).toBe(2);
    const syncFrom = replacement.packets.length;
    await replacement.command('ccb.room.requestSync', {});
    expect(replacement.packets.slice(syncFrom).find(packet => packet.event === 'ccb.game.privateState')?.payload).toMatchObject({ mode: 'full', revision: 1 });
  });

  test('并发及已完成信封重放仅创建一次房间，聊天重放不重复入库且不消耗额度', async () => {
    const fixture = setup();
    const client = await fixture.connect();
    const message: CCBClientMessage = { id: 'create-once', type: 'ccb.room.create', payload: { source: 'original', roomId: ORIGINAL_ROOM,
      name: '幂等房间', userName: '房主', visibility: 'public', allowSpectators: true } };
    client.socket.send(JSON.stringify(message)); client.socket.send(JSON.stringify(message));
    await client.wait(packet => packet.id === message.id && client.packets.filter(item => item.id === message.id).length === 2);
    const first = client.packets.find(packet => packet.id === message.id)!;
    expect(first.type).toBe('ack');
    expect((await client.request(message)).payload).toEqual(first.payload);
    expect(fixture.upstream.sockets).toHaveLength(1);
    const entered = first.payload as CCBRoomEnterResult;
    client.token = entered.sessionToken;
    client.roomId = entered.roomId;
    const chat: CCBClientMessage = { id: 'chat-once', type: 'ccb.chat.send', roomId: ORIGINAL_ROOM, sessionToken: client.token, payload: { text: '只发送一次' } };
    for (let index = 0; index < 10; index++) expect((await client.request(chat)).type).toBe('ack');
    expect(client.snapshot().chat.map(item => item.text)).toEqual(['只发送一次']);
    for (let index = 0; index < 7; index++) await client.command('ccb.chat.send', { text: `有效消息${index}` });
    expect((await client.request({ ...chat, id: 'chat-over-limit' })).error?.code).toBe('RATE_LIMITED');
    expect(client.snapshot().chat).toHaveLength(8);
  });

  test('大厅请求共用上游缓存，操作限流后随时钟恢复，首次零时钟仍加载上游', async () => {
    const fixture = setup({ initialClock: 0 });
    const first = await fixture.connect(), second = await fixture.connect();
    const lobbies = await Promise.all([first.command<{ rooms: CCBRoomSummary[] }>('ccb.lobby.subscribeRooms', {}), second.command<{ rooms: CCBRoomSummary[] }>('ccb.lobby.subscribeRooms', {})]);
    expect(lobbies.map(lobby => lobby.rooms.map(room => room.source))).toEqual([['original'], ['original']]);
    expect(fixture.fetchCount()).toBe(1);
    for (let index = 1; index < 80; index++) await first.command('ccb.lobby.subscribeRooms', {});
    expect((await first.request({ id: 'limited', type: 'ccb.lobby.subscribeRooms', payload: {} })).error?.code).toBe('RATE_LIMITED');
    expect(fixture.fetchCount()).toBe(1);
    fixture.advance(10_001);
    await first.command('ccb.lobby.subscribeRooms', {});
    expect(fixture.fetchCount()).toBe(2);
  });
});
