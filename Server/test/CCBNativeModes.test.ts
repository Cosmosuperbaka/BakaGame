import { afterEach, describe, expect, test } from 'bun:test';
import { ccbTestHarness } from './CCBNativeFixtures';

const active: ReturnType<typeof ccbTestHarness>[] = [];
const harness = () => { const result = ccbTestHarness(); active.push(result); return result; };
afterEach(() => { active.splice(0).forEach(test => test.service.close()); });

describe('CCB 原生完整玩法', () => {
  for (let bits = 0; bits < 16; bits++) {
    const modes = { syncMode: Boolean(bits & 1), nonstopMode: Boolean(bits & 2), globalPick: Boolean(bits & 4), tagBan: Boolean(bits & 8) };
    test(`模式组合 ${JSON.stringify(modes)} 从准备到结算及下一局`, async () => {
      const h = harness(); const host = await h.create(); const guest = await h.join('玩家');
      await h.configure(host, modes); await h.ready(guest); await h.send(host, 'ccb.game.start', {});
      expect(h.snapshot(host).phase).toBe('guessing'); expect(h.privateState(host).answer).toBeNull();
      await h.guess(host, 1);
      if (modes.syncMode || modes.nonstopMode) {
        expect(h.snapshot(host).phase).toBe('guessing'); await h.guess(guest, 1);
      }
      const summary = h.snapshot(host).roundSummary!;
      expect(h.snapshot(host).phase).toBe('settled'); expect(summary.answer.id).toBe(1);
      expect(summary.winners).toHaveLength(modes.syncMode || modes.nonstopMode ? 2 : 1);
      expect(summary.scores.find(item => item.playerId === host.id)?.firstGuess).toBe(12);
      await h.send(host, 'ccb.game.next', {});
      expect(h.snapshot(host).phase).toBe('waiting'); expect(h.privateState(host).answer).toBeNull();
      expect(h.snapshot(host).roundNumber).toBe(1); expect(h.snapshot(host).players.find(item => item.id === guest.id)?.ready).toBe(false);
      await h.ready(guest); await h.send(host, 'ccb.game.start', {}); expect(h.snapshot(host).roundNumber).toBe(2);
    });
  }

  test('同步血战同轮并列第一，下一轮排名第三，各赢家按自己次数领奖', async () => {
    const h = harness(); const host = await h.create(); const second = await h.join('乙'); const third = await h.join('丙');
    await h.configure(host, { syncMode: true, nonstopMode: true }); await h.ready(second, third); await h.send(host, 'ccb.game.start', {});
    await h.guess(host, 1); await h.guess(second, 1); await h.guess(third, 3);
    expect(h.snapshot(third).syncRound).toBe(2); expect(h.snapshot(third).phase).toBe('guessing');
    await h.guess(third, 1);
    const summary = h.snapshot(third).roundSummary!;
    expect(summary.winners.map(item => item.rank)).toEqual([1,1,3]);
    expect(summary.scores.filter(item => item.score > 0).map(item => [item.base,item.firstGuess,item.quickGuess,item.score])).toEqual([[3,12,0,15],[3,12,0,15],[1,0,2,3]]);
    expect(h.snapshot(third).players.map(item => item.score)).toEqual([15,15,3]);
  });

  test('团队超时只扣在线成员次数，共用最后一次机会仍能猜中', async () => {
    const h = harness(); const host = await h.create(); const teammate = await h.join('队友'); const opponent = await h.join('对手');
    await h.configure(host, { timeLimit: 15, maxAttempts: 4, nonstopMode: true });
    await h.send(host, 'ccb.player.team', { team: 1 }); await h.send(teammate, 'ccb.player.team', { team: 1 });
    await h.ready(teammate, opponent); await h.send(host, 'ccb.game.start', {});
    h.advance(15_000);
    expect(h.snapshot(host).players.find(item => item.id === host.id)?.attempts).toBe(2);
    h.service.unregisterConnection(teammate.record.id); h.advance(15_000);
    expect(h.snapshot(host).players.find(item => item.id === host.id)?.attempts).toBe(3);
    await h.guess(host, 1); await h.send(opponent, 'ccb.game.surrender', {});
    expect(h.snapshot(host).roundSummary!.scores.find(item => item.playerId === host.id)?.quickGuess).toBe(0);
    expect(h.snapshot(host).players.find(item => item.id === host.id)?.status).toBe('solved');
    expect(h.snapshot(host).players.find(item => item.id === teammate.id)?.status).toBe('teamWon');
    expect(h.snapshot(host).roundSummary!.winners).toHaveLength(1);
  });

  test('最后一次正确提交先获胜，错误提交立即耗尽且不能继续刷次数', async () => {
    const h = harness(); const host = await h.create(); const guest = await h.join('玩家');
    await h.configure(host, { maxAttempts: 2, nonstopMode: true }); await h.ready(guest); await h.send(host, 'ccb.game.start', {});
    await h.guess(host, 3); await h.guess(host, 1); await h.guess(guest, 3); await h.guess(guest, 4);
    expect(h.snapshot(host).phase).toBe('settled');
    expect(h.snapshot(host).players.map(item => [item.status,item.attempts])).toEqual([['solved',2],['exhausted',2]]);
    await expect(h.guess(guest, 1)).rejects.toMatchObject({ code: 'INVALID_PHASE' });
    expect(h.snapshot(host).roundSummary!.guesses).toHaveLength(4);
  });

  test('指定出题人与其队友临时观战，队伍保留并在下一局恢复参与', async () => {
    const h = harness(); const host = await h.create(); const mate = await h.join('队友'); const guest = await h.join('猜题者');
    await h.configure(host, { useHints: [8] }); await h.send(host, 'ccb.player.team', { team: 1 }); await h.send(mate, 'ccb.player.team', { team: 1 });
    await h.send(host, 'ccb.game.chooseSetter', { playerId: host.id! });
    expect(h.privateState(host).canSetAnswer).toBe(true);
    await h.send(host, 'ccb.game.setAnswer', { characterId: 1, hints: ['手动线索'] });
    expect(h.privateState(host).answer?.id).toBe(1); expect(h.privateState(mate).answer?.id).toBe(1);
    expect(h.privateState(guest).answer).toBeNull(); expect(h.privateState(mate).canGuess).toBe(false);
    await expect(h.guess(mate, 1)).rejects.toMatchObject({ code: 'CANNOT_GUESS' });
    await h.guess(guest, 1);
    expect(h.snapshot(host).roundSummary!.scores.find(item => item.playerId === host.id)?.setter).toBe(-7);
    await h.send(host, 'ccb.game.next', {}); await h.ready(mate, guest); await h.send(host, 'ccb.game.start', {});
    expect(h.privateState(host).canGuess).toBe(true); expect(h.privateState(mate).canGuess).toBe(true);
    expect(h.snapshot(host).players.find(item => item.id === mate.id)?.team).toBe(1);
  });

  test('同步角色禁选允许同轮重复、禁止后轮他人已选，正确答案可由多人提交', async () => {
    const h = harness(); const host = await h.create(); const second = await h.join('乙'); const third = await h.join('丙');
    await h.configure(host, { syncMode: true, nonstopMode: true, globalPick: true }); await h.ready(second,third); await h.send(host, 'ccb.game.start', {});
    await h.guess(host, 3); await h.guess(second, 3); await h.guess(third, 4);
    expect(h.snapshot(host).syncRound).toBe(2);
    await expect(h.guess(third, 3)).rejects.toMatchObject({ code: 'CHARACTER_BANNED' });
    await h.guess(host, 1); await h.guess(second, 1); await h.guess(third, 1);
    expect(h.snapshot(host).roundSummary!.winners.map(item => item.rank)).toEqual([1,1,1]);
  });

  test('实时标签禁选遮住后发现者，观察者保留完整标签、公共房态不含猜测与答案', async () => {
    const h = harness(); const host = await h.create(); const guest = await h.join('玩家'); const spectator = await h.join('旁观者');
    await h.configure(host, { nonstopMode: true, tagBan: true }); await h.send(spectator, 'ccb.player.spectate', { spectator: true });
    await h.ready(guest); await h.send(host, 'ccb.game.start', {});
    await h.guess(host, 3); await h.guess(guest, 4);
    expect(h.privateState(host).guesses.map(item => item.playerId)).toEqual([host.id!]);
    expect(h.privateState(guest).guesses[0].feedback.tags.every(tag => tag.hidden)).toBe(true);
    expect(h.privateState(guest).guesses[0].feedback.tags.every(tag => tag.text === '???' && !tag.matched)).toBe(true);
    expect(h.privateState(spectator).guesses).toHaveLength(2);
    expect(h.privateState(spectator).guesses.flatMap(item => item.feedback.tags).every(tag => !tag.hidden)).toBe(true);
    expect(h.snapshot(host).roundSummary).toBeNull();
    expect(JSON.stringify(h.snapshot(host))).not.toContain('Character 1');
  });

  test('队友共享猜测，其他正在参与的队伍看不到对手猜测明细', async () => {
    const h = harness(); const host = await h.create(); const mate = await h.join('队友'); const opponent = await h.join('对手');
    await h.configure(host, {}); await h.send(host, 'ccb.player.team', { team: 1 }); await h.send(mate, 'ccb.player.team', { team: 1 });
    await h.ready(mate,opponent); await h.send(host, 'ccb.game.start', {}); await h.guess(host, 2);
    expect(h.privateState(mate).guesses.map(item => item.playerId)).toEqual([host.id!]);
    expect(h.privateState(opponent).guesses).toHaveLength(0);
    await h.send(host, 'ccb.game.surrender', {}); await h.guess(opponent, 1);
    expect(h.snapshot(opponent).roundSummary!.scores.find(item => item.playerId === host.id)?.partial).toBe(1);
    expect(h.snapshot(opponent).roundSummary!.scores.find(item => item.playerId === mate.id)?.partial).toBe(0);
  });

  test('提示按剩余次数解锁，图片尚未解锁时不能请求答案图', async () => {
    const h = harness(); const host = await h.create();
    await h.configure(host, { maxAttempts: 5, useHints: [3,0,1], useImageHint: 1 }); await h.send(host, 'ccb.game.start', {});
    expect(h.privateState(host).hints).toEqual([]); expect(h.privateState(host).imageHintAvailable).toBe(false);
    await expect(h.send(host, 'ccb.game.imageHint', {})).rejects.toMatchObject({ code: 'HINT_LOCKED' });
    await h.guess(host, 3); await h.guess(host, 4);
    expect(h.privateState(host).hints).toHaveLength(1); expect(h.privateState(host).imageHintAvailable).toBe(false);
    await h.guess(host, 5); await h.guess(host, 6);
    expect(h.privateState(host).hints).toHaveLength(2); expect(h.privateState(host).imageHintAvailable).toBe(true);
    expect(h.privateState(host).answer).toBeNull();
  });

  for (const syncMode of [false, true]) test(`角色禁选仅本人重复豁免，同队共享机会不共享豁免（同步${syncMode}）`, async () => {
    const h = harness(); const host = await h.create(); const mate = await h.join('队友');
    await h.configure(host, { globalPick: true, syncMode });
    await h.send(host, 'ccb.player.team', { team: 1 }); await h.send(mate, 'ccb.player.team', { team: 1 });
    await h.ready(mate); await h.send(host, 'ccb.game.start', {}); await h.guess(host, 3);
    expect(h.privateState(mate).bannedCharacterIds).toContain(3);
    expect(h.privateState(host).bannedCharacterIds).not.toContain(3);
    await expect(h.guess(mate, 3)).rejects.toMatchObject({ code: 'CHARACTER_BANNED' });
    await h.guess(host, 3);
    expect(h.snapshot(host).players.find(player => player.id === host.id)?.attempts).toBe(2);
  });

  for (const nonstopMode of [false, true]) test(`队友猜中角色时保留先前作品命中者的一分（血战${nonstopMode}）`, async () => {
    const h = harness(); const host = await h.create(); const mate = await h.join('队友');
    await h.configure(host, { nonstopMode });
    await h.send(host, 'ccb.player.team', { team: 1 }); await h.send(mate, 'ccb.player.team', { team: 1 });
    await h.ready(mate); await h.send(host, 'ccb.game.start', {}); await h.guess(host, 2); await h.guess(mate, 1);
    const scores = h.snapshot(host).roundSummary!.scores;
    expect(scores.find(score => score.playerId === host.id)).toMatchObject({ partial: 1, score: 1 });
    expect(scores.find(score => score.playerId === mate.id)).toMatchObject({ partial: 0, quickGuess: 2 });
  });

  test('同步标签禁选同轮暂不遮蔽，轮结束后仍向共同发现者公开', async () => {
    const h = harness(); const host = await h.create(); const guest = await h.join('玩家');
    await h.configure(host, { syncMode: true, nonstopMode: true, tagBan: true }); await h.ready(guest); await h.send(host, 'ccb.game.start', {});
    await h.guess(host, 3);
    expect(h.privateState(host).guesses[0].feedback.tags.every(tag => !tag.hidden)).toBe(true);
    await h.guess(guest, 4);
    expect(h.snapshot(host).syncRound).toBe(2);
    expect(h.privateState(host).guesses[0].feedback.tags.every(tag => !tag.hidden)).toBe(true);
    expect(h.privateState(guest).guesses[0].feedback.tags.every(tag => !tag.hidden)).toBe(true);
  });

  test('血战出题奖励仅按开局猜题人数计算，不把出题人队友算进分母', async () => {
    const h = harness(); const setter = await h.create(); const mate = await h.join('出题人队友');
    const winner = await h.join('猜中者'); const loser = await h.join('未猜中者');
    await h.configure(setter, { nonstopMode: true });
    await h.send(setter, 'ccb.player.team', { team: 1 }); await h.send(mate, 'ccb.player.team', { team: 1 });
    await h.send(setter, 'ccb.game.chooseSetter', { playerId: setter.id! });
    await h.send(setter, 'ccb.game.setAnswer', { characterId: 1, hints: [] });
    await h.guess(winner, 3); await h.guess(winner, 1); await h.send(loser, 'ccb.game.surrender', {});
    expect(h.snapshot(setter).roundSummary!.scores.find(score => score.playerId === setter.id)).toMatchObject({ setter: 2, reason: '难度适中' });
    expect(h.snapshot(setter).players.find(player => player.id === mate.id)?.score).toBe(0);
  });

  test('血战猜题者离线清理不会缩小出题奖励的开局分母', async () => {
    const h = harness(); const setter = await h.create(); const winner = await h.join('猜中者');
    const loser = await h.join('未猜中者'); const offline = await h.join('离线者');
    await h.configure(setter, { nonstopMode: true });
    await h.send(setter, 'ccb.game.chooseSetter', { playerId: setter.id! });
    await h.send(setter, 'ccb.game.setAnswer', { characterId: 1, hints: [] });
    await h.guess(winner, 3); await h.guess(winner, 1);
    h.service.unregisterConnection(offline.record.id);
    await h.send(loser, 'ccb.game.surrender', {}); h.advance(180_001);
    expect(h.snapshot(setter).roundSummary!.scores.find(score => score.playerId === setter.id)).toMatchObject({ setter: 4, reason: '难度适中' });
  });
});
