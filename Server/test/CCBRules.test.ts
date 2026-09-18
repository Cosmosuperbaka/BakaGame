import { describe, expect, test } from 'bun:test';
import { buildCCBFeedback, calculateCCBWinnerScore, calculateCCBSetterScore, validateCCBSettings } from '../src/domain/CCBRules';
import { createDefaultCCBSettings, type CCBCharacterView } from '../src/shared/CCB';
const character = (id: number): CCBCharacterView => ({ id, name: `角色${id}`, nameCn: `角色${id}`,
  gender: 'female', popularity: 100, summary: '', appearances: [{ id: 1, name: '作品', nameCn: '作品', year: 2020, rating: 8, ratingCount: 100 }],
  highestRating: 8, earliestAppearance: 2020, latestAppearance: 2020,
  subjectTags: ['校园', '奇幻'], characterTags: ['黑发'], voiceActors: ['声优甲'], metaTags: ['校园'],
});
describe('CCB 玩法规则', () => {
  test('数值反馈保留原版近似档和箭头所需方向', () => {
    const guess = { ...character(2), popularity: 120, highestRating: 9, earliestAppearance: 2017 };
    const feedback = buildCCBFeedback(guess, character(1), createDefaultCCBSettings());
    expect(feedback.popularity.comparison).toBe('+');
    expect(feedback.rating.comparison).toBe('+');
    expect(feedback.earliestAppearance.comparison).toBe('--');
    expect(feedback.sharedAppearances.map(value => value.id)).toEqual([1]);
  });
  test('共同标签先取交集再补足，声优不受标签数量截断', () => {
    const settings = { ...createDefaultCCBSettings(), subjectTagNum: 1, characterTagNum: 0 };
    const feedback = buildCCBFeedback({ ...character(2), subjectTags: ['推理', '校园'] }, character(1), settings);
    expect(feedback.tags).toEqual([
      { text: '校园', matched: true, hidden: false, kind: 'subject' },
      { text: '声优甲', matched: true, hidden: false, kind: 'voice' },
    ]);
  });
  test('未知年份双方相同而未知评分始终未知', () => {
    const unknown = { ...character(1), highestRating: -1, earliestAppearance: -1 };
    const feedback = buildCCBFeedback(unknown, unknown, createDefaultCCBSettings());
    expect(feedback.earliestAppearance).toEqual({ value: '?', comparison: '=' });
    expect(feedback.rating).toEqual({ value: -1, comparison: '?' });
  });
  test('每位胜者独立计奖，并列只共享基础分', () => {
    expect(calculateCCBWinnerScore(1, 10, 3)).toEqual({ base: 3, firstGuess: 12, quickGuess: 0, score: 15 });
    expect(calculateCCBWinnerScore(3, 10, 3)).toEqual({ base: 3, firstGuess: 0, quickGuess: 2, score: 5 });
    expect(calculateCCBWinnerScore(5, 10, 2).score).toBe(3);
    expect(calculateCCBWinnerScore(6, 10, 2).score).toBe(2);
  });
  test('无人猜中与大赢家的出题奖惩', () => {
    const settings = { nonstop: true, totalPlayers: 5, winnerCount: 0, firstWinnerAttempts: 0, maxAttempts: 10, bigWinnerScore: 0 };
    expect(calculateCCBSetterScore(settings)).toEqual({ score: -6, reason: '无人猜中' });
    expect(calculateCCBSetterScore({ ...settings, bigWinnerScore: 17 })).toEqual({ score: -8, reason: '纯在送分' });
  });
  test('拒绝倒置年份与无法解锁的提示', () => {
    expect(() => validateCCBSettings({ ...createDefaultCCBSettings(), startYear: 2100 })).toThrow('起始年份不能晚于结束年份');
    expect(() => validateCCBSettings({ ...createDefaultCCBSettings(), useHints: [11] })).toThrow('提示阈值不能超过猜测次数');
  });
});
