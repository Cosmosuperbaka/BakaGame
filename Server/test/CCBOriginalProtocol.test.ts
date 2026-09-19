import { describe, expect, test } from 'bun:test';
import { createDefaultCCBSettings } from '../src/shared/CCB';
import { decodeOriginalCharacter, encodeOriginalCharacter, originalPlayers, originalScores,
  originalSettings, toOriginalSettings, toOriginalCharacter } from '../src/infrastructure/CCBOriginalProtocol';

describe('原版协议转换', () => {
  test('保留远端答案资料和标签顺序，并在服务端完成加解密', () => {
    const remote = {
      id: 12, name: '角色', nameCn: '角色译名', image: 'https://images.example/12.jpg',
      gender: 'female', popularity: 123, summary: '第一句。第二句。',
      appearances: ['原作'], appearancesCn: ['中文作品'], appearanceIds: [44],
      highestRating: 8.8, earliestAppearance: 1999, latestAppearance: 2024,
      rawTags: [['科幻', 80], ['校园', 30]], animeVAs: ['声优'], metaTags: ['科幻', '校园', '眼镜', '声优'],
    };
    const view = decodeOriginalCharacter(remote, 'fixture-key');
    expect(view.highestRating).toBe(8.8);
    expect(view.popularity).toBe(123);
    expect(view.characterTags).toEqual(['眼镜']);
    expect(view.subjectTags).toEqual(['科幻', '校园']);
    expect(view.appearances[0]).toMatchObject({ id: 44, name: '原作', nameCn: '中文作品' });
    const encrypted = encodeOriginalCharacter(view, 'fixture-key');
    expect(encrypted).not.toContain('角色');
    expect(decodeOriginalCharacter(encrypted, 'fixture-key')).toEqual(view);
    expect(() => decodeOriginalCharacter(encrypted, 'different-fixture')).toThrow('无法读取原版题目');
  });

  test('兼容目录作品对象和关闭计时，不以预设覆盖多人默认设置', () => {
    const settings = originalSettings({ addedSubjects: [{ id: '33' }, 44], timeLimit: null, indexId: '7', useIndex: true });
    expect(settings.addedSubjects).toEqual([33, 44]);
    expect(settings.timeLimit).toBe(0);
    expect(settings.indexId).toBe(7);
    expect(settings.topNSubjects).toBe(20);
    expect(originalSettings(toOriginalSettings(createDefaultCCBSettings()))).toEqual(createDefaultCCBSettings());
  });

  test('原版附加游戏作品编号不改变可见作品数量，增强字段跨客户端保留', () => {
    const view = decodeOriginalCharacter({ id: 12, name: '角色', appearances: ['可见作品'], appearanceIds: [44, 225022] }, 'fixture-key');
    expect(view.appearances).toHaveLength(1);
    expect(view.comparisonAppearances).toEqual([{ id: 44, name: '可见作品', nameCn: '可见作品' }, { id: 225022, name: '', nameCn: '' }]);
    view.comparisonAppearances[1] = { id: 225022, name: '附加游戏', nameCn: '附加游戏' };
    view.extraTags = [{ section: '阵营', tags: ['测试阵营'] }];
    const wire = toOriginalCharacter(view);
    expect(wire.appearanceIds).toEqual([44, 225022]);
    expect(wire.appearances).toEqual(['可见作品']);
    expect(decodeOriginalCharacter(wire, 'fixture-key')).toEqual(view);
  });

  test('保留并列名次、队员实际积分，不向统一玩家视图传播头像和留言', () => {
    const players = originalPlayers([{ id: 'p', username: '玩家', guesses: '⏱️💡🏆', team: '1',
      score: 9, avatarId: 123, message: '旧留言', syncCompletedRound: 2 }], 'guessing', 2);
    expect(players[0]).toMatchObject({ attempts: 2, status: 'teamWon', syncCompleted: true, team: 1 });
    expect(players[0]).not.toHaveProperty('avatarId');
    expect(players[0]).not.toHaveProperty('message');
    const scores = originalScores([{ type: 'team', members: [
      { id: 'p', username: '玩家', score: 15, breakdown: { rank: 1, base: 3, bigWin: 12 } },
      { id: 'q', username: '同伴', score: 0, breakdown: {} },
    ] }], players);
    expect(scores.map(score => score.score)).toEqual([15, 0]);
    expect(scores[0]).toMatchObject({ rank: 1, base: 3, firstGuess: 12 });
  });

  /**
   * 上游 `updatePlayers` 的玩家 id 可能是数字。加入房间的确认谓词要拿它跟 socket.id 比对，
   * 一旦被 `originalString` 静默转成空串，玩家就永远匹配不上、加入只能等 8s 超时失败。
   */
  test('玩家编号兼容数字形态，缺失或非标量才退化为空串', () => {
    expect(originalPlayers([{ id: 0, username: '甲' }], 'waiting', 1)[0]!.id).toBe('0');
    expect(originalPlayers([{ id: 1, username: '甲' }], 'waiting', 1)[0]!.id).toBe('1');
    expect(originalPlayers([{ id: 'abc', username: '甲' }], 'waiting', 1)[0]!.id).toBe('abc');
    expect(originalPlayers([{ username: '甲' }], 'waiting', 1)[0]!.id).toBe('');
  });
});
