import type { CCBCharacterView, CCBSettings } from "../shared/CCB";
import type { CCBRawCharacter } from "./CCBData";

const SOURCE_NAMES = new Map([
  ["GAL改", "游戏改"], ["轻小说改", "小说改"], ["轻改", "小说改"], ["原创动画", "原创"],
  ["网文改", "小说改"], ["漫改", "漫画改"], ["漫画改编", "漫画改"], ["游戏改编", "游戏改"], ["小说改编", "小说改"],
]);
const SOURCES = new Set(["原创", "游戏改", "小说改", "漫画改"]);
const REGIONS = new Set(["日本", "欧美", "美国", "中国", "法国", "韩国", "英国", "俄罗斯", "中国香港", "苏联", "捷克", "中国台湾", "马来西亚"]);
const EXPANDED_CHARACTERS = new Set([56822, 56823, 17529, 10956]);
const weighted = (values: Map<string, number>) => [...values].sort((a, b) => b[1] - a[1]);
const add = (values: Map<string, number>, key: string, value: number) => values.set(key, (values.get(key) ?? 0) + value);

/** 出题筛选按第一项，登场作品筛选按原版 includes 的先后顺序。 */
export function resolveCCBSubjectTypes(tags: string[], forPicking = false): number[] {
  const selected = forPicking ? tags.slice(0, 1) : tags;
  if (selected.includes("游戏") || (forPicking && selected.includes("Galgame"))) return [4];
  if (selected.includes("书籍")) return [1];
  if (selected.includes("三次元")) return [6];
  if (selected.includes("全部")) return [1, 2, 4, 6];
  return [2];
}

export function deriveCCBCharacter(raw: CCBRawCharacter, settings: CCBSettings, now: number): CCBCharacterView {
  const types = resolveCCBSubjectTypes(settings.metaTags);
  const preferred = raw.appearances.filter((item) => types.includes(item.type));
  const selected = (preferred.length ? preferred : raw.appearances).filter((item) => {
    const year = Number(item.date.slice(0, 4));
    const date = Date.parse(item.date);
    return Number.isInteger(year) && year > 0 && Number.isFinite(date) && date <= now;
  });
  const sources = new Map<string, number>();
  const rawTags = new Map<string, number>();
  const tags = new Map<string, number>();
  const metas = new Map<string, number>();
  const regions = new Set<string>();
  for (const appearance of selected) {
    const factor = appearance.relationType === 1 ? 3 : 1;
    if (!settings.commonTags) {
      for (const tag of appearance.metaTags) {
        if (SOURCES.has(tag)) continue;
        if (REGIONS.has(tag)) regions.add(tag);
        else add(metas, tag, tags.get(tag) || factor);
      }
    }
    if (!settings.commonTags && appearance.type !== 2 && appearance.type !== 4) continue;
    for (const [tag, votes] of Object.entries(appearance.rawTags)) {
      if (!settings.commonTags && tag.includes("20")) continue;
      if (SOURCES.has(tag)) add(sources, tag, votes * factor);
      else if (!settings.commonTags && REGIONS.has(tag)) regions.add(tag);
      else if (SOURCE_NAMES.has(tag)) add(sources, SOURCE_NAMES.get(tag)!, votes * factor);
      else add(settings.commonTags ? rawTags : tags, tag, votes * factor);
    }
  }
  const topSource = weighted(sources)[0];
  let subjectTags: string[];
  const metaTags = new Set<string>();
  if (settings.commonTags) {
    if (topSource) add(rawTags, topSource[0], topSource[1]);
    const entries = weighted(rawTags).filter(([tag]) => !tag.includes("20"));
    const threshold = (entries[0]?.[1] ?? 0) * 0.1;
    const cutoff = entries.findIndex(([, weight]) => weight < threshold);
    // 保留原版的截断语义：无低于阈值项时，仅保留设置要求的数量。
    subjectTags = entries.slice(0, Math.max(cutoff, settings.subjectTagNum)).map(([tag]) => tag);
  } else {
    if (topSource) metaTags.add(topSource[0]);
    for (const [tag] of [...weighted(metas), ...weighted(tags)]) {
      if (metaTags.size >= settings.subjectTagNum) break;
      metaTags.add(tag);
    }
    subjectTags = [...metaTags];
    for (const tag of raw.characterTags.slice(0, settings.characterTagNum)) metaTags.add(tag);
    for (const tag of regions) metaTags.add(tag);
  }
  const voiceActors = EXPANDED_CHARACTERS.has(raw.id) ? ["展开"] : raw.voiceActors;
  for (const voiceActor of voiceActors) metaTags.add(voiceActor);
  const appearances = selected.map((item) => ({
    id: item.id, name: item.name, nameCn: item.nameCn, year: Number(item.date.slice(0, 4)),
    rating: item.rating, ratingCount: item.ratingCount,
  })).sort((a, b) => b.ratingCount - a.ratingCount);
  return {
    id: raw.id, name: raw.name, nameCn: raw.nameCn, imageUrl: raw.imageUrl,
    gender: raw.gender, popularity: raw.popularity, summary: raw.summary, appearances,
    highestRating: appearances.length ? Math.max(...appearances.map((item) => item.rating)) : -1,
    earliestAppearance: appearances.length ? Math.min(...appearances.map((item) => item.year)) : -1,
    latestAppearance: appearances.length ? Math.max(...appearances.map((item) => item.year)) : -1,
    subjectTags, characterTags: [...raw.characterTags], voiceActors: [...voiceActors], metaTags: [...metaTags],
  };
}
