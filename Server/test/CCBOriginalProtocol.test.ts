import { describe, expect, test } from 'bun:test';
import { createDefaultCCBSettings } from '../src/shared/CCB';
import { decodeOriginalCharacter, encodeOriginalCharacter, originalPlayers, originalScores,
  originalSettings, toOriginalSettings } from '../src/infrastructure/CCBOriginalProtocol';

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
});
