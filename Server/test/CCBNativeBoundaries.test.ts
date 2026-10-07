import { afterEach, describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { CCBImageHints } from '../src/infrastructure/CCBImageHints';
import { ccbTestHarness, character, deferred } from './CCBNativeFixtures';
import { ROOM_EMPTY_GRACE_PERIOD_MS, ROOM_IDLE_TIMEOUT_MS } from '../src/config/Constants';
import { ROOM_ID_TEST_MODE } from '../src/shared/Index';

const SOLO = { roomId: ROOM_ID_TEST_MODE };

const active: ReturnType<typeof ccbTestHarness>[] = [];
const keep = (h: ReturnType<typeof ccbTestHarness>) => { active.push(h); return h; };
afterEach(() => { active.splice(0).forEach(test => test.service.close()); });

describe('CCB 房间与提示边界', () => {
  test('普通房至少两人才能开局，测试房允许房主一人试玩', async () => {
    const h = keep(ccbTestHarness()); const host = await h.create(); await h.configure(host, {});
    expect(h.privateState(host).canStart).toBe(false);
    await expect(h.send(host, 'ccb.game.start', {})).rejects.toMatchObject({ code: 'PLAYERS_NOT_READY' });
    const guest = await h.join('猜题人'); expect(h.privateState(host).canStart).toBe(false);
    await h.ready(guest); expect(h.privateState(host).canStart).toBe(true);
    await h.send(guest, 'ccb.player.spectate', { spectator: true }); expect(h.privateState(host).canStart).toBe(false);
    const test = keep(ccbTestHarness({}, undefined, SOLO)); const tester = await test.create(); await test.configure(tester, {});
    expect(test.privateState(tester).canStart).toBe(true);
    await test.send(tester, 'ccb.game.start', {}); expect(test.snapshot(tester).phase).not.toBe('waiting');
  });

  test('手动出题开始后进入选人阶段：出题人不必准备，候选排除无法留下猜题者的队伍，取消保留准备', async () => {
    const h = keep(ccbTestHarness()); const host = await h.create(); const setter = await h.join('尚未准备');
    expect(h.privateState(host).canStart).toBe(false);
    await h.configure(host, { answerMode: 'manual' });
    // 手动出题不要求其他人准备，等待阶段也不提前下发候选名单。
    expect(h.privateState(host).canStart).toBe(true); expect(h.privateState(host).setterCandidateIds).toEqual([]);
    await expect(h.send(host, 'ccb.game.chooseSetter', { playerId: setter.id! })).rejects.toMatchObject({ code: 'INVALID_PHASE' });
    await expect(h.send(setter, 'ccb.game.start', {})).rejects.toMatchObject({ code: 'NOT_HOST' });
    await h.send(host, 'ccb.game.start', {});
    expect(h.snapshot(host).phase).toBe('choosingSetter');
    expect(h.privateState(host).setterCandidateIds).toContain(setter.id!);
    expect(h.privateState(setter).setterCandidateIds).toEqual([]);
    // 选人阶段不能改队伍与设置；取消回到等待，准备状态原样保留。
    await expect(h.send(setter, 'ccb.player.team', { team: 1 })).rejects.toMatchObject({ code: 'INVALID_PHASE' });
    await h.send(host, 'ccb.game.cancel', {}); expect(h.snapshot(host).phase).toBe('waiting');
    await h.send(host, 'ccb.player.team', { team: 1 }); await h.send(setter, 'ccb.player.team', { team: 1 });
    expect(h.privateState(host).canStart).toBe(false);
    await h.send(host, 'ccb.player.team', { team: null }); await h.send(host, 'ccb.game.start', {});
    await expect(h.send(host, 'ccb.game.chooseSetter', { playerId: 'missing' })).rejects.toMatchObject({ code: 'PLAYER_NOT_FOUND' });
    await h.send(host, 'ccb.game.chooseSetter', { playerId: setter.id! });
    expect(h.snapshot(host).phase).toBe('answering');
    expect(h.privateState(host).setterCandidateIds).toEqual([]); expect(h.privateState(setter).canSetAnswer).toBe(true);
    await h.send(setter, 'ccb.game.setAnswer', { characterId: 1, hints: [] });
    expect(h.privateState(host).canGuess).toBe(true); expect(h.privateState(setter).canGuess).toBe(false);
  });

  test('房主没有准备态：准备指令对房主无效，转让后新房主视同已准备、卸任者需重新准备', async () => {
    const h = keep(ccbTestHarness()); const host = await h.create(); const guest = await h.join('玩家');
    await h.send(host, 'ccb.player.ready', { ready: false });
    expect(h.snapshot(host).players.find(item => item.id === host.id)?.ready).toBe(true);
    await h.send(host, 'ccb.room.transferHost', { playerId: guest.id! });
    const players = h.snapshot(guest).players;
    expect(players.find(item => item.id === guest.id)?.ready).toBe(true);
    expect(players.find(item => item.id === host.id)?.ready).toBe(false);
    expect(h.privateState(guest).canStart).toBe(false);
    await h.ready(host); expect(h.privateState(guest).canStart).toBe(true);
  });

  test('额外游戏作品命中获得作品分，外部标签反馈不泄漏答案未命中标签', async () => {
    const game = { id: 284157, name: 'Genshin', nameCn: '原神' };
    const answer = { ...character(1), comparisonAppearances: [...character(1).comparisonAppearances, game],
      extraTags: [{ section: '属性', tags: ['风', '答案独有属性'] }] };
    const guess = { ...character(2), comparisonAppearances: [...character(2).comparisonAppearances, game],
      extraTags: [{ section: '属性', tags: ['风', '水'] }] };
    const h = keep(ccbTestHarness({ chooseRandomCharacter: async () => answer, getCharacter: async id => id === 1 ? answer : guess }));
    const host = await h.create(); const guest = await h.join('另一位玩家');
    await h.configure(host, { tagBan: true }); await h.ready(guest); await h.send(host, 'ccb.game.start', {});
    await h.guess(host, 2);
    const state = h.privateState(host);
    expect(state.answer).toBeNull(); expect(JSON.stringify(state)).not.toContain('答案独有属性');
    expect(state.guesses[0].partial).toBe(true);
    expect(state.guesses[0].feedback.sharedAppearances).toEqual([game]);
    expect(state.guesses[0].feedback.appearancesCount.value).toBe(1);
    expect(state.guesses[0].feedback.extraTags).toEqual([{ section: '属性', tags: [{ text: '风', matched: true }, { text: '水', matched: false }] }]);
    await h.guess(guest, 1);
    expect(h.snapshot(host).roundSummary!.scores.find(score => score.playerId === host.id)?.partial).toBe(1);
  });

  test('解锁图片由服务端处理，返回WebP字节而公开及私有快照仍不公开答案', async () => {
    const png = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#ee99aa' } }).png().toBuffer();
    const hints = new CCBImageHints({ fetcher: async () => new Response(png) });
    const h = keep(ccbTestHarness({}, hints, SOLO)); const host = await h.create();
    await h.configure(host, { maxAttempts: 3, useImageHint: 2 }); await h.send(host, 'ccb.game.start', {}); await h.guess(host, 3);
    const image = await h.send(host, 'ccb.game.imageHint', {}) as { dataUrl: string };
    expect(image.dataUrl.startsWith('data:image/webp;base64,')).toBe(true);
    expect(image.dataUrl).not.toContain('https://images.invalid/1.jpg');
    expect(h.privateState(host).answer).toBeNull(); expect(h.snapshot(host).roundSummary).toBeNull();
  });

  test('无图片时明确告知，图片加载跨过结算后不返回旧提示', async () => {
    const unavailable = keep(ccbTestHarness({ resolveCharacterImage: async () => undefined }, undefined, SOLO)); const host = await unavailable.create();
    await unavailable.configure(host, { maxAttempts: 2, useImageHint: 2 }); await unavailable.send(host, 'ccb.game.start', {});
    await expect(unavailable.send(host, 'ccb.game.imageHint', {})).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
    const download = deferred<Response>();
    const hints = new CCBImageHints({ fetcher: async () => download.promise });
    const h = keep(ccbTestHarness({}, hints, SOLO)); const player = await h.create();
    await h.configure(player, { maxAttempts: 2, useImageHint: 2 }); await h.send(player, 'ccb.game.start', {});
    const pending = h.send(player, 'ccb.game.imageHint', {}); await h.send(player, 'ccb.game.surrender', {});
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ee99aa' } }).png().toBuffer();
    download.resolve(new Response(png));
    await expect(pending).rejects.toMatchObject({ code: 'HINT_LOCKED' });
  });

  test('私密即有密码并带锁列出，人数只计在线成员，聊天修剪空白并且退房使旧身份失效', async () => {
    const h = keep(ccbTestHarness()); const host = await h.create(); const guest = await h.join('玩家');
    expect(h.service.listRooms()).toMatchObject([{ roomId: '1234', playerCount: 2, spectatorCount: 0, hasPassword: false, source: 'native' }]);
    await expect(h.send(host, 'ccb.room.update', { name: '私密房', visibility: 'private', allowSpectators: true }))
      .rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
    await h.send(host, 'ccb.room.update', { name: '私密房', visibility: 'private', allowSpectators: true, password: ' 口令 ' });
    expect(h.service.listRooms()).toMatchObject([{ roomId: '1234', name: '私密房', hasPassword: true }]);
    await h.send(host, 'ccb.room.update', { name: '私密房', visibility: 'private', allowSpectators: true });
    expect(h.service.listRooms()[0].hasPassword).toBe(true);
    await h.send(guest, 'ccb.player.spectate', { spectator: true });
    expect(h.service.listRooms()).toMatchObject([{ playerCount: 1, spectatorCount: 1 }]);
    await h.send(host, 'ccb.room.update', { name: '公开房', visibility: 'public', allowSpectators: true });
    expect(h.service.listRooms()).toMatchObject([{ name: '公开房', hasPassword: false }]);
    await h.send(guest, 'ccb.chat.send', { text: '  你好  ' });
    expect(h.snapshot(host).chat.at(-1)).toMatchObject({ playerId: guest.id, playerName: '玩家', text: '你好', system: false });
    const longMessage = '完整消息'.repeat(125);
    await h.send(guest, 'ccb.chat.send', { text: longMessage });
    expect(h.snapshot(host).chat.at(-1)?.text).toBe(longMessage);
    await expect(h.send(guest, 'ccb.chat.send', { text: '   ' })).rejects.toMatchObject({ code: 'EMPTY_MESSAGE' });
    await h.send(guest, 'ccb.room.leave', {}); expect(h.snapshot(host).players).toHaveLength(1);
    const recovered = h.connect('恢复');
    await expect(h.send(recovered, 'ccb.room.reconnect', { roomId: '1234', sessionToken: guest.token! })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await h.send(host, 'ccb.room.leave', {}); expect(h.service.getHealthSnapshot().roomCount).toBe(0);
    // 最后一人离开随即关房，但离开者自己不再收到关闭通知，不弹多余提示
    expect(host.sent.some(packet => packet.event === 'ccb.room.closed')).toBe(false);
  });

  test('房间空置宽限后清理，出题超时回到等待且服务器关闭通知到达客户端', async () => {
    const h = keep(ccbTestHarness()); const host = await h.create(); const setter = await h.join('出题人');
    await h.chooseSetter(host, setter.id!); h.advance(120_000);
    expect(h.snapshot(host).phase).toBe('waiting'); expect(h.snapshot(host).setterPlayerId).toBeNull();
    h.service.notifyShutdown(); expect(host.sent.some(packet => packet.event === 'server.shutdown')).toBe(true);
    h.service.unregisterConnection(host.record.id); h.service.unregisterConnection(setter.record.id);
    h.advance(ROOM_EMPTY_GRACE_PERIOD_MS - 1); expect(h.service.getHealthSnapshot().roomCount).toBe(1);
    h.advance(1); expect(h.service.getHealthSnapshot().roomCount).toBe(0);
  });

  test('在线房间长时间无操作也会关闭并解绑成员', async () => {
    const h = keep(ccbTestHarness()); const host = await h.create();
    h.advance(ROOM_IDLE_TIMEOUT_MS);
    expect(h.service.getHealthSnapshot().roomCount).toBe(0);
    expect(host.record.roomId).toBeUndefined();
    expect(host.sent.some(packet => packet.event === 'ccb.room.closed')).toBe(true);
  });

  for (const [winnerCount, expected] of [[0,-4],[1,2],[2,4],[3,2]]) {
    test(`血战手动出题四人参与且${winnerCount}人猜中时出题分为${expected}`, async () => {
      const h = keep(ccbTestHarness()); const setter = await h.create();
      const players = await Promise.all([h.join('甲'),h.join('乙'),h.join('丙'),h.join('丁')]);
      await h.configure(setter, { nonstopMode: true });
      await h.chooseSetter(setter, setter.id!); await h.send(setter, 'ccb.game.setAnswer', { characterId: 1, hints: [] });
      for (const [index, player] of players.entries()) {
        if (index < winnerCount) { await h.guess(player, 3); await h.guess(player, 1); }
        else await h.send(player, 'ccb.game.surrender', {});
      }
      expect(h.snapshot(setter).phase).toBe('settled');
      expect(h.snapshot(setter).roundSummary!.scores.find(score => score.playerId === setter.id)?.setter).toBe(expected);
      expect(h.snapshot(setter).players.find(player => player.id === setter.id)?.score).toBe(expected);
    });
  }
});
