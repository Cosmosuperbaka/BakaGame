import type { CCBCharacterView, CCBComparison, CCBFeedback, CCBFeedbackValue, CCBSettings } from '../shared/CCB';
import { AppError } from './Errors';

export function validateCCBSettings(settings: CCBSettings): void {
  if (settings.startYear > settings.endYear) throw new AppError('INVALID_SETTINGS', '起始年份不能晚于结束年份');
  if (settings.useIndex && settings.indexId === null) throw new AppError('INVALID_SETTINGS', '请先导入目录');
  if (settings.timeLimit !== 0 && settings.timeLimit < 15) throw new AppError('INVALID_SETTINGS', '每次时限至少十五秒，或关闭计时');
  if (settings.useHints.some(value => value > settings.maxAttempts) || settings.useImageHint > settings.maxAttempts) {
    throw new AppError('INVALID_SETTINGS', '提示阈值不能超过猜测次数');
  }
}
function compareNumber(value: number, answer: number, equal: number, near: number, unknown = false): CCBFeedbackValue {
  if (unknown && (value === -1 || answer === -1)) return { value: value === -1 ? '?' : value, comparison: value === answer ? '=' : '?' };
  const diff = value - answer;
  const comparison: CCBComparison = Math.abs(diff) <= equal ? '=' : diff > 0 ? (diff <= near ? '+' : '++') : (diff >= -near ? '-' : '--');
  return { value, comparison };
}
export function buildCCBFeedback(guess: CCBCharacterView, answer: CCBCharacterView, settings: CCBSettings): CCBFeedback {
  const answerIds = new Set(answer.comparisonAppearances.filter(item => item.id > 0).map(item => item.id));
  const byId = guess.comparisonAppearances.filter(item => item.id > 0 && answerIds.has(item.id));
  const answerNames = new Set(answer.appearances.map(item => item.name));
  const sharedAppearances = byId.length ? byId : guess.appearances.filter(item => answerNames.has(item.name));
  const tags: CCBFeedback['tags'] = [];
  const appendTags = (values: string[], answers: string[], limit: number, kind: 'subject' | 'character' | 'voice') => {
    const answerSet = new Set(answers);
    const matched = values.filter(value => answerSet.has(value)).slice(0, limit);
    const selected = [...matched, ...values.filter(value => !answerSet.has(value))].slice(0, limit);
    for (const text of selected) if (!tags.some(tag => tag.text === text)) tags.push({ text, matched: answerSet.has(text), hidden: false, kind });
  };
  appendTags(guess.subjectTags, answer.subjectTags, settings.subjectTagNum, 'subject');
  appendTags(guess.characterTags, answer.characterTags, settings.characterTagNum, 'character');
  appendTags(guess.voiceActors, answer.voiceActors, Number.POSITIVE_INFINITY, 'voice');
  return {
    gender: { value: guess.gender, comparison: guess.gender === answer.gender ? 'yes' : 'no' },
    popularity: compareNumber(guess.popularity, answer.popularity, answer.popularity * .05, answer.popularity * .2),
    rating: guess.highestRating === -1 || answer.highestRating === -1
      ? { value: guess.highestRating, comparison: '?' }
      : compareNumber(guess.highestRating, answer.highestRating, .3, 1),
    appearancesCount: compareNumber(guess.appearances.length, answer.appearances.length, 0, 2),
    earliestAppearance: compareNumber(guess.earliestAppearance, answer.earliestAppearance, 0, 2, true),
    latestAppearance: compareNumber(guess.latestAppearance, answer.latestAppearance, 0, 2, true),
    sharedAppearances, tags,
    extraTags: guess.extraTags.map(({ section, tags }) => {
      const matched = new Set(answer.extraTags.find(item => item.section === section)?.tags);
      return { section, tags: tags.map(text => ({ text, matched: matched.has(text) })) };
    }),
  };
}
export function calculateCCBWinnerScore(attempts: number, maxAttempts: number, base: number, personalFavorite = false) {
  const firstGuess = attempts === 1 || personalFavorite ? 12 : 0;
  const quickGuess = firstGuess ? 0 : attempts >= 2 && attempts <= 3 ? 2 : attempts >= 4 && attempts <= Math.ceil(maxAttempts / 2) ? 1 : 0;
  return { base, firstGuess, quickGuess, score: base + firstGuess + quickGuess };
}
export function calculateCCBSetterScore(options: {
  nonstop: boolean; totalPlayers: number; winnerCount: number; firstWinnerAttempts: number;
  maxAttempts: number; bigWinnerScore: number;
}): { score: number; reason: string } {
  const { nonstop, totalPlayers, winnerCount, firstWinnerAttempts, maxAttempts, bigWinnerScore } = options;
  if (bigWinnerScore) return { score: -Math.max(1, Math.floor(bigWinnerScore / 2)), reason: '纯在送分' };
  if (nonstop) {
    const multiplier = Math.max(1, Math.ceil(totalPlayers / 2));
    if (!winnerCount) return { score: -2 * multiplier, reason: '无人猜中' };
    const rate = winnerCount / Math.max(1, totalPlayers);
    return { score: (rate <= .25 || rate >= .75 ? 1 : 2) * multiplier,
      reason: rate <= .25 ? '难度偏高' : rate >= .75 ? '难度偏低' : '难度适中' };
  }
  if (!winnerCount) return { score: -1, reason: '没人猜中' };
  if (firstWinnerAttempts <= 3) return { score: -1, reason: '太简单了' };
  return firstWinnerAttempts > maxAttempts / 2 ? { score: 1, reason: '难度适中' } : { score: 0, reason: '' };
}
export function createCCBHints(summary: string, count: number, random: () => number): string[] {
  const sentences = summary.replaceAll('[mask]', '').replaceAll('[/mask]', '').split(/[。、，。！？ "\n]/u).map(value => value.trim()).filter(Boolean);
  const result: string[] = [];
  while (sentences.length && result.length < count) result.push(`……${sentences.splice(Math.floor(random() * sentences.length), 1)[0]}……`);
  return result;
}
