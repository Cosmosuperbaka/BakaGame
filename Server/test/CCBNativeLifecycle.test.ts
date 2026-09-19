import { afterEach, describe, expect, test } from 'bun:test';
import { ccbTestHarness, character, deferred } from './CCBNativeFixtures';
import type { CCBCharacterView } from '../src/shared/Index';
import type { CCBDataProvider } from '../src/infrastructure/CCBData';
import { HOST_RECONNECT_TIMEOUT_MS } from '../src/config/Constants';

const active: ReturnType<typeof ccbTestHarness>[] = [];
const harness = (data: Partial<CCBDataProvider> = {}) => { const result = ccbTestHarness(data); active.push(result); return result; };
afterEach(() => { active.splice(0).forEach(test => test.service.close()); });

describe('CCB 会话与异步边界', () => {
  test('同队异步提交期间拒绝第二份猜测，数据库完成后只消耗一次机会', async () => {
    const load = deferred<CCBCharacterView>();
    const h = harness({ getCharacter: async () => load.promise });
    const host = await h.create(); const mate = await h.join('队友');
    await h.configure(host, {}); await h.send(host, 'ccb.player.team', { team: 1 }); await h.send(mate, 'ccb.player.team', { team: 1 });
    await h.ready(mate); await h.send(host, 'ccb.game.start', {});
    const first = h.guess(host, 3);
    await expect(h.guess(mate, 4)).rejects.toMatchObject({ code: 'ACTION_PENDING' });
    load.resolve(character(3)); await first;
    expect(h.snapshot(host).players.map(player => player.attempts)).toEqual([1,1]);
    expect(h.privateState(host).guesses).toHaveLength(1);
  });

  test('独立玩家可并发查询，先返回的赢家结束普通局，另一份迟到查询不能改写结算', async () => {
    const load = deferred<CCBCharacterView>();
    const h = harness({ getCharacter: async () => load.promise });
    const host = await h.create(); const guest = await h.join('玩家'); await h.configure(host, {}); await h.ready(guest); await h.send(host, 'ccb.game.start', {});
    const late = h.guess(guest, 3); await h.guess(host, 1); load.resolve(character(3));
    await expect(late).rejects.toMatchObject({ code: 'INVALID_PHASE' });
    expect(h.snapshot(host).roundSummary!.guesses).toHaveLength(1);
    expect(h.snapshot(host).roundSummary!.winners[0].playerId).toBe(host.id!);
  });

  test('查询期间最后一次时限到期会耗尽机会，迟到资料不能重新获胜', async () => {
    const load = deferred<CCBCharacterView>();
    const h = harness({ getCharacter: async () => load.promise });
    const host = await h.create(); const guest = await h.join('玩家');
    await h.configure(host, { timeLimit: 15, maxAttempts: 1, nonstopMode: true }); await h.ready(guest); await h.send(host, 'ccb.game.start', {});
    const late = h.guess(host, 3); h.advance(15_000); load.resolve(character(3));
    await expect(late).rejects.toMatchObject({ code: 'INVALID_PHASE' });
    expect(h.snapshot(host).roundSummary!.winners).toEqual([]);
    expect(h.snapshot(host).players.map(player => player.attempts)).toEqual([1,1]);
  });

  test('同局首次读取角色后冻结反馈，随后资料更新不改变重复猜测结果', async () => {
    let calls = 0;
    const h = harness({ getCharacter: async id => ({ ...character(id), popularity: ++calls === 1 ? 10 : 10000 }) });
    const host = await h.create(); await h.configure(host, {}); await h.send(host, 'ccb.game.start', {});
    await h.guess(host, 3); await h.guess(host, 3);
    expect(calls).toBe(1);
    expect(h.privateState(host).guesses.map(guess => guess.feedback.popularity.value)).toEqual([10,10]);
  });

  test('房主重连宽限内保留权限和会话，宽限后转移给在线玩家', async () => {
    const h = harness(); const host = await h.create(); const guest = await h.join('玩家'); await h.configure(host, {});
    h.service.unregisterConnection(host.record.id); h.advance(HOST_RECONNECT_TIMEOUT_MS - 1);
    expect(h.snapshot(guest).hostPlayerId).toBe(host.id!);
    const recovered = h.connect('恢复房主');
    await h.send(recovered, 'ccb.room.reconnect', { source: 'native', roomId: '1234', sessionToken: host.token! });
    expect(h.snapshot(recovered).hostPlayerId).toBe(host.id!); expect(recovered.id).toBe(host.id!);
    h.service.unregisterConnection(recovered.record.id); h.advance(HOST_RECONNECT_TIMEOUT_MS);
    expect(h.snapshot(guest).hostPlayerId).toBe(guest.id!);
    const oldHost = h.connect('旧房主'); await h.send(oldHost, 'ccb.room.reconnect', { source: 'native', roomId: '1234', sessionToken: host.token! });
    expect(h.snapshot(oldHost).hostPlayerId).toBe(guest.id!);
    await expect(h.send(oldHost, 'ccb.room.transferHost', { playerId: host.id! })).rejects.toMatchObject({ code: 'NOT_HOST' });
  });

  test('连接替换只允许最新会话操作，凭据不会出现在公共快照', async () => {
    const h = harness(); const host = await h.create(); const replacement = h.connect('替换');
    await h.send(replacement, 'ccb.room.reconnect', { source: 'native', roomId: '1234', sessionToken: host.token! });
    expect(host.closed[0].code).toBe(4001); expect(h.snapshot(replacement).players[0].online).toBe(true);
    expect(JSON.stringify(h.snapshot(replacement))).not.toContain(host.token!);
    expect(h.service.getHealthSnapshot().onlinePlayerCount).toBe(1);
  });

  test('同步局未行动者断线后立即推进，重连恢复自己的次数与下一轮', async () => {
    const h = harness(); const host = await h.create(); const guest = await h.join('玩家');
    await h.configure(host, { syncMode: true, nonstopMode: true }); await h.ready(guest); await h.send(host, 'ccb.game.start', {});
    await h.guess(host, 3); expect(h.privateState(host).canGuess).toBe(false);
    h.service.unregisterConnection(guest.record.id);
    expect(h.snapshot(host).syncRound).toBe(2); expect(h.privateState(host).canGuess).toBe(true);
    const recovered = h.connect('恢复'); await h.send(recovered, 'ccb.room.reconnect', { source: 'native', roomId: '1234', sessionToken: guest.token! });
    expect(h.privateState(recovered).canGuess).toBe(true);
    expect(h.snapshot(recovered).players.find(player => player.id === guest.id)?.attempts).toBe(0);
  });

  test('踢出等待者解除同步阻塞，旧令牌失效且被踢者不能继续猜测', async () => {
    const h = harness(); const host = await h.create(); const guest = await h.join('玩家');
    await h.configure(host, { syncMode: true, nonstopMode: true }); await h.ready(guest); await h.send(host, 'ccb.game.start', {});
    await h.guess(host, 3); await h.send(host, 'ccb.room.kick', { playerId: guest.id! });
    expect(h.snapshot(host).syncRound).toBe(2); expect(h.privateState(host).canGuess).toBe(true);
    expect(guest.sent.some(packet => packet.event === 'ccb.player.kicked')).toBe(true);
    const recovered = h.connect('尝试恢复');
    await expect(h.send(recovered, 'ccb.room.reconnect', { source: 'native', roomId: '1234', sessionToken: guest.token! })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  test('中途加入只观战，下局准备后参加，关闭观战的房间拒绝中途加入', async () => {
    const h = harness(); const host = await h.create(); await h.configure(host, {}); await h.send(host, 'ccb.game.start', {});
    const late = await h.join('迟到'); expect(h.privateState(late).canGuess).toBe(false); expect(h.privateState(late).answer?.id).toBe(1);
    await h.guess(host, 1); await h.send(host, 'ccb.game.next', {}); await h.ready(late); await h.send(host, 'ccb.game.start', {});
    expect(h.privateState(late).canGuess).toBe(true);
    await h.guess(host, 1); await h.send(host, 'ccb.game.next', {});
    await h.send(host, 'ccb.room.update', { name: '关闭观战', visibility: 'public', allowSpectators: false });
    await h.ready(late); await h.send(host, 'ccb.game.start', {});
    await expect(h.join('禁止迟到')).rejects.toMatchObject({ code: 'SPECTATING_DISABLED' });
  });

  test('作品搜索禁用只约束正在猜题者，观战者仍可浏览', async () => {
    const h = harness(); const host = await h.create(); const observer = await h.join('观战者');
    await h.configure(host, { subjectSearch: false }); await h.send(observer, 'ccb.player.spectate', { spectator: true }); await h.send(host, 'ccb.game.start', {});
    await expect(h.send(host, 'ccb.subject.search', { keyword: '作品' })).rejects.toMatchObject({ code: 'SUBJECT_SEARCH_DISABLED' });
    await expect(h.send(host, 'ccb.subject.characters', { subjectId: 100 })).rejects.toMatchObject({ code: 'SUBJECT_SEARCH_DISABLED' });
    expect(await h.send(observer, 'ccb.subject.characters', { subjectId: 100 })).toHaveProperty('results');
  });

  test('手动出题人断线自动取消，重新选人后可继续开局', async () => {
    const h = harness(); const host = await h.create(); const setter = await h.join('出题人');
    await h.send(host, 'ccb.game.chooseSetter', { playerId: setter.id! }); h.service.unregisterConnection(setter.record.id);
    expect(h.snapshot(host).phase).toBe('waiting'); expect(h.snapshot(host).setterPlayerId).toBeNull();
    await h.configure(host, {}); await h.send(host, 'ccb.game.start', {}); expect(h.snapshot(host).phase).toBe('guessing');
  });

  test('唯一猜题人刷新不会判负，恢复后继续同局并可猜中', async () => {
    const h = harness(); const host = await h.create(); const guest = await h.join('猜题人');
    await h.configure(host, {});
    await h.send(host, 'ccb.game.chooseSetter', { playerId: host.id! });
    await h.send(host, 'ccb.game.setAnswer', { characterId: 1, hints: [] });
    await h.guess(guest, 3);
    h.service.unregisterConnection(guest.record.id);
    expect(h.snapshot(host).phase).toBe('guessing'); expect(h.snapshot(host).roundSummary).toBeNull();
    const restored = h.connect('恢复连接');
    await h.send(restored, 'ccb.room.reconnect', { source: 'native', roomId: '1234', sessionToken: guest.token! });
    expect(h.privateState(restored).guesses).toHaveLength(1);
    await h.guess(restored, 1);
    expect(h.snapshot(host).roundSummary!.winners[0].playerId).toBe(guest.id!);
    expect(h.snapshot(host).roundNumber).toBe(1);
  });

  test('最后一个离线猜题人过期清除后结束对局', async () => {
    const h = harness(); const host = await h.create(); const guest = await h.join('猜题人');
    await h.configure(host, {}); await h.send(host, 'ccb.game.chooseSetter', { playerId: host.id! });
    await h.send(host, 'ccb.game.setAnswer', { characterId: 1, hints: [] });
    h.service.unregisterConnection(guest.record.id); h.advance(180_000);
    expect(h.snapshot(host).phase).toBe('settled'); expect(h.snapshot(host).roundSummary!.winners).toEqual([]);
  });

  test('取消后同一时刻重开，不接受之前自动出题任务的迟到答案', async () => {
    const first = deferred<CCBCharacterView>(), second = deferred<CCBCharacterView>(); let calls = 0;
    const h = harness({ chooseRandomCharacter: async () => ++calls === 1 ? first.promise : second.promise });
    const host = await h.create(); await h.configure(host, {});
    const previous = h.send(host, 'ccb.game.start', {});
    await h.send(host, 'ccb.game.cancel', {});
    const current = h.send(host, 'ccb.game.start', {});
    first.resolve(character(3));
    const outcome = await previous.then(() => 'accepted', error => error.code as string);
    second.resolve(character(1));
    const currentOutcome = await current.then(() => 'accepted', error => error.code as string);
    expect(outcome).toBe('ROUND_CANCELLED'); expect(currentOutcome).toBe('accepted');
    await h.guess(host, 1); expect(h.snapshot(host).roundSummary!.answer.id).toBe(1);
  });

  test('同步同轮都选过的角色可以由原猜测者再次使用', async () => {
    const h = harness(); const host = await h.create(); const guest = await h.join('玩家');
    await h.configure(host, { syncMode: true, nonstopMode: true, globalPick: true }); await h.ready(guest); await h.send(host, 'ccb.game.start', {});
    await h.guess(host, 3); await h.guess(guest, 3);
    expect(h.privateState(host).bannedCharacterIds).not.toContain(3);
    await h.guess(host, 3); expect(h.snapshot(host).players.find(player => player.id === host.id)?.attempts).toBe(2);
  });

  test('同步猜测查询跨过超时换轮后拒绝旧动作，不替玩家在新一轮提前猜测', async () => {
    const load = deferred<CCBCharacterView>();
    const h = harness({ getCharacter: async () => load.promise }); const host = await h.create(); const guest = await h.join('玩家');
    await h.configure(host, { syncMode: true, nonstopMode: true, timeLimit: 15 }); await h.ready(guest); await h.send(host, 'ccb.game.start', {});
    const previousRound = h.guess(host, 3); h.advance(15_000);
    expect(h.snapshot(host).syncRound).toBe(2);
    load.resolve(character(3));
    await expect(previousRound).rejects.toMatchObject({ code: 'ROUND_CANCELLED' });
    expect(h.snapshot(host).players.find(player => player.id === host.id)?.attempts).toBe(1);
    expect(h.privateState(host).guesses).toHaveLength(0);
    expect(h.privateState(host).canGuess).toBe(true);
  });

  test('同一角色并发读取期间资料变化，全局冻结首次已接受版本用于整局所有玩家', async () => {
    const first = deferred<CCBCharacterView>(), second = deferred<CCBCharacterView>(); let calls = 0;
    const h = harness({ getCharacter: async () => ++calls === 1 ? first.promise : second.promise });
    const host = await h.create(); const guest = await h.join('玩家'); await h.configure(host, { nonstopMode: true }); await h.ready(guest); await h.send(host, 'ccb.game.start', {});
    const firstGuess = h.guess(host, 3), secondGuess = h.guess(guest, 3);
    first.resolve({ ...character(3), popularity: 10 }); await firstGuess;
    second.resolve({ ...character(3), popularity: 10000 }); await secondGuess;
    expect(h.privateState(host).guesses[0].feedback.popularity.value).toBe(10);
    expect(h.privateState(guest).guesses[0].feedback.popularity.value).toBe(10);
    await h.guess(host, 3); expect(h.privateState(host).guesses[1].feedback.popularity.value).toBe(10);
  });

  test('密码校验期间连接断开，不创建幽灵在线成员', async () => {
    const h = harness(); const host = h.connect('房主');
    await h.send(host, 'ccb.room.create', { source: 'native', roomId: '1234', name: '加密房', userName: '房主', visibility: 'private', allowSpectators: true, password: '正确密码' });
    const guest = h.connect('玩家');
    const joining = h.send(guest, 'ccb.room.join', { source: 'native', userName: '玩家', password: '正确密码' });
    h.service.unregisterConnection(guest.record.id);
    await expect(joining).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    expect(h.snapshot(host).players).toHaveLength(1);
    expect(h.service.getHealthSnapshot().onlinePlayerCount).toBe(1);
  });
});
