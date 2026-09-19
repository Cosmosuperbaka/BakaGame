import CryptoJS from 'crypto-js';
import { AppError } from '../domain/Errors';
import { createDefaultCCBSettings, type CCBCharacterView, type CCBPlayer, type CCBScoreDetail, type CCBSettings } from '../shared/CCB';

export const originalObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('CCB_ORIGINAL_PROTOCOL', '原版服务器返回了无效数据');
  }
  return value as Record<string, unknown>;
};
export const originalArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const originalString = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
export const originalNumber = (value: unknown, fallback = 0): number => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : fallback;
};
export const originalStrings = (value: unknown): string[] => originalArray(value).filter((item): item is string => typeof item === 'string');

export function decodeOriginalCharacter(value: unknown, secret: string): CCBCharacterView {
  let decoded = value;
  if (typeof value === 'string') {
    try {
      decoded = JSON.parse(CryptoJS.AES.decrypt(value, secret).toString(CryptoJS.enc.Utf8));
    } catch {
      throw new AppError('CCB_ORIGINAL_CIPHER', '无法读取原版题目，请检查服务端兼容配置');
    }
  }
  return originalCharacter(decoded);
}

export function originalCharacter(value: unknown): CCBCharacterView {
  const raw = originalObject(value);
  const id = originalNumber(raw.id);
  if (!Number.isInteger(id) || id <= 0) throw new AppError('CCB_ORIGINAL_PROTOCOL', '原版角色编号无效');
  const names = originalStrings(raw.appearances);
  const namesCn = originalStrings(raw.appearancesCn);
  const ids = originalArray(raw.appearanceIds);
  const comparisonNames = new Map(originalArray(raw.comparisonAppearances).map(value => {
    const item = originalObject(value);
    return [originalNumber(item.id), { name: originalString(item.name), nameCn: originalString(item.nameCn) }];
  }));
  const subjectTags = originalArray(raw.rawTags).flatMap(entry => Array.isArray(entry) && typeof entry[0] === 'string' ? [entry[0]] : []);
  const voiceActors = originalStrings(raw.animeVAs);
  const metaTags = originalStrings(raw.metaTags);
  const characterTags = Array.isArray(raw.characterTags)
    ? originalStrings(raw.characterTags)
    : metaTags.filter(tag => !subjectTags.includes(tag) && !voiceActors.includes(tag));
  return {
    id, name: originalString(raw.name), nameCn: originalString(raw.nameCn),
    imageUrl: originalString(raw.image) || undefined,
    gender: raw.gender === 'male' || raw.gender === 'female' ? raw.gender : '?',
    popularity: originalNumber(raw.popularity), summary: originalString(raw.summary),
    appearances: names.map((name, index) => ({
      id: originalNumber(ids[index]), name, nameCn: namesCn[index] || name,
      year: -1, rating: -1, ratingCount: 0,
    })),
    comparisonAppearances: Array.from({ length: Math.max(names.length, ids.length) }, (_, index) => {
      const id = originalNumber(ids[index]); const extra = comparisonNames.get(id);
      const name = names[index] || extra?.name || '';
      return { id, name, nameCn: namesCn[index] || extra?.nameCn || name };
    }),
    extraTags: originalArray(raw.extraTags).map(value => {
      const section = originalObject(value); return { section: originalString(section.section), tags: originalStrings(section.tags) };
    }),
    highestRating: originalNumber(raw.highestRating, -1), earliestAppearance: originalNumber(raw.earliestAppearance, -1),
    latestAppearance: originalNumber(raw.latestAppearance, -1), subjectTags, characterTags, voiceActors, metaTags,
  };
}

export function toOriginalCharacter(character: CCBCharacterView): Record<string, unknown> {
  return {
    id: character.id, name: character.name, nameCn: character.nameCn, gender: character.gender,
    image: character.imageUrl, summary: character.summary, popularity: character.popularity,
    appearances: character.appearances.map(item => item.name), appearancesCn: character.appearances.map(item => item.nameCn),
    appearanceIds: character.comparisonAppearances.map(item => item.id), highestRating: character.highestRating,
    comparisonAppearances: character.comparisonAppearances, extraTags: character.extraTags,
    earliestAppearance: character.earliestAppearance, latestAppearance: character.latestAppearance,
    rawTags: character.subjectTags.map(tag => [tag, 1]), characterTags: character.characterTags,
    animeVAs: character.voiceActors, metaTags: character.metaTags,
  };
}

export const encodeOriginalCharacter = (character: CCBCharacterView, secret: string): string =>
  CryptoJS.AES.encrypt(JSON.stringify(toOriginalCharacter(character)), secret).toString();

export function originalSettings(value: unknown): CCBSettings {
  const raw = originalObject(value);
  const defaults = createDefaultCCBSettings();
  const result = { ...defaults };
  const numericKeys = ['startYear', 'endYear', 'topNSubjects', 'characterNum', 'maxAttempts', 'timeLimit',
    'subjectTagNum', 'characterTagNum', 'useImageHint'] as const;
  for (const key of numericKeys) result[key] = raw[key] === null && key === 'timeLimit' ? 0 : originalNumber(raw[key], defaults[key]);
  const flags = ['useSubjectPerYear', 'useIndex', 'mainCharacterOnly', 'subjectSearch', 'commonTags',
    'globalPick', 'tagBan', 'syncMode', 'nonstopMode'] as const;
  for (const key of flags) if (typeof raw[key] === 'boolean') result[key] = raw[key];
  result.metaTags = Array.isArray(raw.metaTags) ? originalStrings(raw.metaTags) : defaults.metaTags;
  result.indexId = originalNumber(raw.indexId) || null;
  result.addedSubjects = originalArray(raw.addedSubjects).map(item => originalNumber(typeof item === 'object' && item ? originalObject(item).id : item)).filter(id => id > 0);
  result.useHints = originalArray(raw.useHints).map(value => Math.max(0, originalNumber(value)));
  return result;
}

export const toOriginalSettings = (settings: CCBSettings): Record<string, unknown> => ({
  ...settings, timeLimit: settings.timeLimit || null,
  addedSubjects: settings.addedSubjects.map(id => ({ id })),
});

export interface CCBOriginalPlayer extends CCBPlayer {
  isHost: boolean;
  isSetter: boolean;
  temporaryObserver: boolean;
}

export function originalPlayers(value: unknown, phase: string, syncRound: number): CCBOriginalPlayer[] {
  return originalArray(value).map(value => {
    const raw = originalObject(value);
    const marks = originalString(raw.guesses);
    const temporaryObserver = raw._tempObserver === true;
    const team = raw.team === null || raw.team === undefined || raw.team === '' ? null : originalNumber(raw.team);
    const isSetter = raw.isAnswerSetter === true;
    const status = marks.includes('🏆') ? 'teamWon' : /[✌👑]/u.test(marks) ? 'solved'
      : marks.includes('💀') ? 'exhausted' : marks.includes('🏳') ? 'surrendered'
        : team === 0 || temporaryObserver || isSetter ? 'observing' : phase === 'guessing' ? 'playing' : 'waiting';
    return {
      id: originalString(raw.id), name: originalString(raw.username), online: raw.disconnected !== true,
      ready: raw.ready === true, team: team === 0 ? null : team, membership: team === 0 ? 'spectator' : 'active',
      score: originalNumber(raw.score), status, attempts: (marks.match(/(?:⏱️?|💡|✔|❌)/gu) || []).length,
      marks, syncCompleted: originalNumber(raw.syncCompletedRound) === syncRound,
      isHost: raw.isHost === true, isSetter, temporaryObserver,
    };
  });
}

export function originalScores(value: unknown, players: CCBOriginalPlayer[]): CCBScoreDetail[] {
  return originalArray(value).flatMap(value => {
    const raw = originalObject(value);
    if (raw.type === 'team') return originalScores(raw.members, players);
    const breakdown = raw.breakdown ? originalObject(raw.breakdown) : {};
    const name = originalString(raw.username);
    return [{
      playerId: originalString(raw.id) || players.find(player => player.name === name)?.id || '', playerName: name,
      score: originalNumber(raw.score), base: originalNumber(breakdown.base), firstGuess: originalNumber(breakdown.bigWin),
      quickGuess: originalNumber(breakdown.quickGuess), partial: originalNumber(breakdown.partial),
      setter: raw.type === 'setter' ? originalNumber(raw.score) : 0, reason: originalString(raw.reason),
      ...(breakdown.rank === undefined ? {} : { rank: originalNumber(breakdown.rank) }),
    }];
  });
}
