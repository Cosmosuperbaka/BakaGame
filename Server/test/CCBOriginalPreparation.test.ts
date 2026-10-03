import { afterEach, describe, expect, test } from 'bun:test';
import { CCBOriginalService } from '../src/application/CCBOriginalService';
import type { ConnectionRecord } from '../src/domain/Model';
import { encodeOriginalCharacter } from '../src/infrastructure/CCBOriginalProtocol';
import { originalRequest } from '../src/infrastructure/CCBOriginalSocket';
import { createDefaultCCBSettings, type CCBClientMessage, type CCBRoomSnapshot } from '../src/shared/CCB';
import { deferred } from './CCBNativeFixtures';
import { FixtureRoom, FixtureSocket, originalCharacter as character, originalData as data } from './CCBOriginalFixtures';

/** 对齐相邻原版 socket.js 的阶段、房主、准备和出题权检查，不用无条件成功 ACK 证明事务有效。 */
class PreparationRoom extends FixtureRoom {
  phase: 'waiting' | 'answering' | 'guessing' | 'settled' = 'waiting';
  setterId: string | null = null;
  accepted: string[] = [];
  ackMode: 'normal' | 'reject' | 'hold' = 'normal';
  pendingAck?: (payload: unknown) => void;
  override factory = () => {
    const socket = new PreparationSocket(`original-${this.sockets.length}`, this);
    this.sockets.push(socket); return socket;
  };
  override broadcast(event: string, value: unknown) {
    const payload = value as Record<string, unknown>;
    if (event === 'waitForAnswer') { this.phase = 'answering'; this.setterId = String(payload.answerSetterId); }
    if (event === 'waitForAnswerCanceled') { this.phase = 'waiting'; this.setterId = null; }
    if (event === 'gameStart') this.phase = 'guessing';
    if (event === 'gameEnded') this.phase = 'settled';
    super.broadcast(event, value);
  }
}
class PreparationSocket extends FixtureSocket {
  declare readonly room: PreparationRoom;
  override emit(event: string, payload: unknown, ack?: (payload: unknown) => void) {
    if (event !== 'gameStart' && event !== 'setAnswer') return super.emit(event, payload, ack);
    const me = this.room.players.find(player => player.id === this.id);
    const permitted = this.connected && !!me && this.room.phase !== 'guessing' && (event === 'gameStart'
      ? me.isHost && this.room.players.every(player => player.isHost || player.ready || player.disconnected)
      : this.room.phase === 'answering' && this.room.setterId === this.id);
    if (!permitted || this.room.ackMode === 'reject') {
      this.sent.push({ event, payload }); ack?.({ ok: false, message: '阶段或操作权限已变化' }); return;
    }
    this.room.accepted.push(event);
    super.emit(event, payload, this.room.ackMode === 'hold' ? response => {
      this.room.pendingAck = () => ack?.(response);
    } : ack);
  }
}

const services: CCBOriginalService[] = [];
afterEach(() => services.splice(0).forEach(service => service.close()));
async function setup(options: Partial<ConstructorParameters<typeof CCBOriginalService>[0]> = {}) {
  const room = new PreparationRoom(); const packets: Array<{ event: string; payload: unknown }> = [];
  const service = new CCBOriginalService({ data, serverUrl: 'https://original.example', aesSecret: 'fixture-key',
    socketFactory: room.factory, fetcher: async () => Response.json([{ id: '1234' }]), ...options });
  services.push(service);
  const connection = (id: string): ConnectionRecord => ({ id, lobbySubscribed: false,
    send: packet => packets.push(packet as { event: string; payload: unknown }), close() {} });
  service.registerConnection(connection('first'));
  const target = { source: 'original' as const, roomId: '1234', upstreamRoomId: '1234' };
  const entry = await service.create('first', target, { source: 'original', roomId: '1234', name: '准备归属',
    userName: '房主', visibility: 'public', allowSpectators: true });
  service.registerConnection(connection('second'));
  await service.join('second', target, { userName: '队友' });
  const request = (type: 'ccb.game.start' | 'ccb.game.next' | 'ccb.game.setAnswer' | 'ccb.room.leave', id = 'first') => service.execute(id,
    { id: crypto.randomUUID(), type, roomId: '1234', sessionToken: entry.sessionToken,
      payload: type === 'ccb.game.setAnswer' ? { characterId: 900, hints: ['提示'] } : {} } as CCBClientMessage);
  const snapshot = () => [...packets].reverse().find(packet => packet.event === 'ccb.room.snapshot')?.payload as CCBRoomSnapshot;
  return { service, room, request, connection, entry, target, snapshot };
}

describe('原版准备事务的异步归属', () => {
  test('FixtureSocket 明确拒绝错误房主、未准备、进行中对局和错误出题人', async () => {
    const h = await setup(); const socket = h.room.sockets[0];
    const payload = { roomId: '1234', character: encodeOriginalCharacter(character(), 'fixture-key') };
    h.room.players[0].isHost = false;
    await expect(originalRequest(socket, 'gameStart', payload)).rejects.toMatchObject({ code: 'CCB_ORIGINAL_REJECTED' });
    h.room.players[0].isHost = true; h.room.players[1].ready = false;
    await expect(originalRequest(socket, 'gameStart', payload)).rejects.toMatchObject({ code: 'CCB_ORIGINAL_REJECTED' });
    h.room.players[1].ready = true; h.room.broadcast('waitForAnswer', { answerSetterId: h.room.sockets[1].id });
    await expect(originalRequest(socket, 'setAnswer', payload)).rejects.toMatchObject({ code: 'CCB_ORIGINAL_REJECTED' });
    h.room.phase = 'guessing';
    await expect(originalRequest(socket, 'gameStart', payload)).rejects.toMatchObject({ code: 'CCB_ORIGINAL_REJECTED' });
    expect(h.room.accepted).toEqual([]);
  });

  test('旧连接排队的命令不能在另一页面恢复后继承操作权', async () => {
    const loading = deferred<ReturnType<typeof character>>(); const entered = deferred<void>();
    const h = await setup({ data: { ...data, async chooseRandomCharacter() { entered.resolve(); return loading.promise; } } });
    const first = h.request('ccb.game.start'); await entered.promise;
    const queued = h.request('ccb.game.start');
    const outcomes = Promise.allSettled([first, queued]);
    h.service.registerConnection(h.connection('replacement'));
    h.service.reconnect('replacement', h.target, h.entry.sessionToken);
    loading.resolve(character());
    expect(await outcomes).toMatchObject([
      { status: 'rejected', reason: { code: 'CCB_ROUND_CHANGED' } },
      { status: 'rejected', reason: { code: 'CCB_ROUND_CHANGED' } },
    ]);
    expect(h.room.accepted).toEqual([]);
    expect(h.service.hasSession('replacement')).toBe(true);
  });

  test('续局查询期间相同答案重新开局也不能复活旧准备或回滚新局', async () => {
    const loading = deferred<ReturnType<typeof character>>(); const entered = deferred<void>(); let calls = 0;
    const h = await setup({ data: { ...data, async chooseRandomCharacter() {
      if (++calls === 1) return character(); entered.resolve(); return loading.promise;
    } } });
    await h.request('ccb.game.start');
    h.room.broadcast('gameEnded', { guesses: [], scoreDetails: [] });
    const pending = h.request('ccb.game.next'); await entered.promise;
    h.room.broadcast('gameStart', { character: encodeOriginalCharacter(character(), 'fixture-key'),
      settings: createDefaultCCBSettings(), players: h.room.players });
    loading.resolve(character());
    await expect(pending).rejects.toMatchObject({ code: 'CCB_ROUND_CHANGED' });
    expect(h.room.sockets[0].sent.filter(item => item.event === 'gameStart')).toHaveLength(1);
    expect(h.snapshot().phase).toBe('guessing'); expect(h.snapshot().roundNumber).toBe(2);
  });

  const changes = ['leave', 'detach', 'resume', 'disconnect', 'closed', 'kicked', 'host-return', 'setter-return', 'cancel-return', 'new-round', 'peer-new-round', 'settings', 'unready-return'] as const;
  for (const command of ['ccb.game.start', 'ccb.game.setAnswer'] as const) {
    const event = command === 'ccb.game.start' ? 'gameStart' : 'setAnswer';
    for (const stage of ['character', 'image'] as const) for (const change of changes) {
      test(`${command} 等待${stage}后遇到${change}${change === 'unready-return' && command === 'ccb.game.setAnswer' ? '不影响出题权' : '不转发上游'}`, async () => {
        const loading = deferred<ReturnType<typeof character>>(); const image = deferred<string>(); const entered = deferred<void>();
        const waitCharacter = async () => {
          if (stage === 'character') { entered.resolve(); return loading.promise; }
          return { ...character(), imageUrl: undefined };
        };
        const h = await setup({ data: { ...data, chooseRandomCharacter: waitCharacter, getCharacter: waitCharacter,
          async resolveCharacterImage() { entered.resolve(); return image.promise; } } });
        const first = h.room.sockets[0]; const second = h.room.sockets[1];
        if (command === 'ccb.game.setAnswer') h.room.broadcast('waitForAnswer', { answerSetterId: first.id });
        const pending = h.request(command);
        await Promise.race([entered.promise, pending.then(() => { throw new Error('未经过资料查询'); })]);
        let leave: Promise<unknown> | undefined;
        if (change === 'leave') leave = h.request('ccb.room.leave');
        if (change === 'detach' || change === 'resume') h.service.unregisterConnection('first');
        if (change === 'resume') {
          h.service.registerConnection(h.connection('replacement'));
          h.service.reconnect('replacement', h.target, h.entry.sessionToken);
        }
        if (change === 'disconnect') first.disconnect();
        if (change === 'closed') h.room.broadcast('roomClosed', {});
        if (change === 'kicked') h.room.broadcast('playerKicked', { playerId: first.id });
        if (change === 'host-return') {
          h.room.players[0].isHost = false; h.room.players[1].isHost = true;
          h.room.broadcast('updatePlayers', { players: h.room.players });
          h.room.players[0].isHost = true; h.room.players[1].isHost = false;
          h.room.broadcast('updatePlayers', { players: h.room.players });
        }
        if (change === 'setter-return') {
          h.room.broadcast('waitForAnswer', { answerSetterId: second.id });
          h.room.broadcast('waitForAnswer', { answerSetterId: first.id });
        }
        if (change === 'cancel-return') {
          h.room.broadcast('waitForAnswerCanceled', {});
          if (command === 'ccb.game.setAnswer') h.room.broadcast('waitForAnswer', { answerSetterId: first.id });
        }
        if (change === 'new-round') h.room.broadcast('gameStart', {
          character: encodeOriginalCharacter(character(901), 'fixture-key'), settings: createDefaultCCBSettings(), players: h.room.players });
        // 本连接尚未收到广播时，也必须以另一连接已推进的共享局为准。
        if (change === 'peer-new-round') second.receive('gameStart', {
          character: encodeOriginalCharacter(character(901), 'fixture-key'), settings: createDefaultCCBSettings(), players: h.room.players });
        if (change === 'settings') h.room.broadcast('updateGameSettings', { settings: { ...createDefaultCCBSettings(), maxAttempts: 20 } });
        if (change === 'unready-return') {
          h.room.players[1].ready = false; h.room.broadcast('updatePlayers', { players: h.room.players });
          h.room.players[1].ready = true; h.room.broadcast('updatePlayers', { players: h.room.players });
        }
        const allowed = change === 'unready-return' && command === 'ccb.game.setAnswer';
        loading.resolve(character()); image.resolve('https://images.example/900.jpg');
        // 手动出题不要求猜题玩家准备，准备状态变化不会取消有效出题权。
        if (allowed) await pending; else await expect(pending).rejects.toMatchObject({ code: 'CCB_ROUND_CHANGED' });
        if (leave) await leave;
        expect(first.sent.filter(item => item.event === event)).toHaveLength(change === 'unready-return' && command === 'ccb.game.setAnswer' ? 1 : 0);
        if (change === 'new-round') { expect(h.snapshot().phase).toBe('guessing'); expect(h.snapshot().roundNumber).toBe(1); }
        if (change === 'setter-return' || (change === 'cancel-return' && command === 'ccb.game.setAnswer')) expect(h.snapshot().phase).toBe('answering');
      });
    }

    test(`${command} 无关广播不取消有效事务，设置使用冻结副本`, async () => {
      const loading = deferred<ReturnType<typeof character>>(); const entered = deferred<void>();
      let captured: unknown;
      const choose = async (settings: unknown) => { captured = settings; entered.resolve(); return loading.promise; };
      const h = await setup({ data: { ...data, chooseRandomCharacter: choose, getCharacter: (_id, settings) => choose(settings) } });
      if (command === 'ccb.game.setAnswer') h.room.broadcast('waitForAnswer', { answerSetterId: h.room.sockets[0].id });
      const settings = h.snapshot().settings;
      const pending = h.request(command); await entered.promise;
      h.room.broadcast('updatePlayers', { players: h.room.players });
      h.room.broadcast('roomNameUpdated', { roomName: '仅改房名' });
      expect(captured).toEqual(settings); expect(captured).not.toBe(settings);
      loading.resolve(character());
      await expect(pending).resolves.toMatchObject({ ok: true });
      expect(h.room.accepted).toEqual([event]);
    });

    test(`${command} 查询失败释放准备归属且可以重试`, async () => {
      let broken = true;
      const choose = async () => { if (broken) throw new Error('夹具资料故障'); return character(); };
      const h = await setup({ data: { ...data, chooseRandomCharacter: choose, getCharacter: choose } });
      if (command === 'ccb.game.setAnswer') h.room.broadcast('waitForAnswer', { answerSetterId: h.room.sockets[0].id });
      await expect(h.request(command)).rejects.toThrow('夹具资料故障');
      expect(h.snapshot().phase).toBe(command === 'ccb.game.start' ? 'waiting' : 'answering');
      expect(h.room.accepted).toEqual([]);
      broken = false;
      await expect(h.request(command)).resolves.toMatchObject({ ok: true });
      expect(h.room.accepted).toEqual([event]);
    });

    test(`${command} 上游已接受但ACK超时不能假报成功或回滚新局`, async () => {
      const h = await setup();
      if (command === 'ccb.game.setAnswer') h.room.broadcast('waitForAnswer', { answerSetterId: h.room.sockets[0].id });
      h.room.ackMode = 'hold';
      await expect(h.request(command)).rejects.toMatchObject({ code: 'CCB_ORIGINAL_TIMEOUT' });
      expect(h.room.accepted).toEqual([event]); expect(h.snapshot().phase).toBe('guessing');
      h.room.pendingAck?.({ ok: true });
      expect(h.snapshot().phase).toBe('guessing');
    }, 10_000);

    for (const ackMode of ['normal', 'reject', 'hold'] as const) test(`${command} 有效归属区分${ackMode}确认`, async () => {
      const h = await setup(); const socket = h.room.sockets[0];
      if (command === 'ccb.game.setAnswer') h.room.broadcast('waitForAnswer', { answerSetterId: socket.id });
      h.room.ackMode = ackMode;
      let finished = false;
      const pending = h.request(command).then(value => { finished = true; return value; });
      if (ackMode === 'reject') {
        await expect(pending).rejects.toMatchObject({ code: 'CCB_ORIGINAL_REJECTED' });
        expect(h.snapshot().phase).toBe(command === 'ccb.game.start' ? 'waiting' : 'answering');
        expect(h.room.accepted).toEqual([]);
      } else {
        if (ackMode === 'hold') {
          // 等待夹具处理请求，而非人为延时绕过时序。
          for (let i = 0; i < 20 && !h.room.pendingAck; i++) await Promise.resolve();
          expect(h.room.pendingAck).toBeDefined(); expect(finished).toBe(false);
          h.room.pendingAck?.({ ok: true });
        }
        await expect(pending).resolves.toMatchObject({ ok: true });
        expect(h.room.accepted).toEqual([event]); expect(h.snapshot().phase).toBe('guessing');
      }
      expect(socket.sent.filter(item => item.event === event)).toHaveLength(1);
    });
  }
});
