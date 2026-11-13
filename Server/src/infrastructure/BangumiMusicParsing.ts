import { stripVersionInfo } from "../domain/TitlePatterns";
import { isBangumiCreditsEntry } from "../shared/Index";
import type { BangumiMusicTrack, BangumiMusicTrackKind } from "../shared/Index";
import { asArray, asRecord, readString } from "./JsonReaders";

const STAFF_KEY_PATTERN =
  /分[镜鏡]|演出|作画|動画|动画|制作|製作|设定|設定|设计|設計|监[督修]|企画|企划|录音|録音|混音|音效|音响|音響|选曲|選曲|协助|協力|协力|角色[设設]|主要角色|CAST|STAFF|作[词詞]|作曲|编曲|編曲|制作人|制片人/i;

export const extractPerformers = (infobox: unknown): string[] => {
  const artists: string[] = [];
  for (const entry of asArray(infobox)) {
    const record = asRecord(entry);
    const key = readString(record.key ?? record.name) ?? "";
    if (!/演出/.test(key) || !/歌|曲|主题|插入/.test(key)) continue;
    const text = readString(record.value);
    const values = asArray(record.value);
    const rawList = text
      ? [text]
      : (values
          .map((v) => (typeof v === "string" ? v : readString(asRecord(v).v ?? asRecord(v).value)))
          .filter(Boolean) as string[]);
    for (const raw of rawList) {
      for (const item of raw.split(/[\r\n/／；;,，]+/)) {
        const cleaned = item.replace(/[（(【[][^）)】\]]*[）)】\]]/g, "").trim();
        if (
          cleaned &&
          cleaned.length >= 2 &&
          cleaned.length <= 50 &&
          !/^(?:OP|ED|IN|TM)\d*$/i.test(cleaned)
        ) {
          artists.push(cleaned);
        }
      }
    }
  }
  return [...new Set(artists)];
};

/**
 * `其他` 关联的 kind 还没定：按条目名再分原声带 / Remix / 广播剧 CD；
 * 明示的关系文本直接采用 normalizeKind 的结果。
 */
const refineRelatedMusicKind = (relation: string, rawName: string): BangumiMusicTrackKind => {
  const kind = normalizeKind(relation);
  if (kind !== "theme" || relation !== "其他") return kind;
  if (/原声|soundtrack|\bost\b/i.test(rawName)) return "ost";
  if (/remix|重混/i.test(rawName)) return "remix";
  if (/drama|广播剧|ドラマ/i.test(rawName)) return "drama";
  return kind;
};

/** 从条目名剥掉「」引号块后的余部解析歌手：斜杠尾巴优先，否则短余部视作歌手名。 */
const parseArtistFromQuotedRelation = (
  rawName: string,
  quoteMatches: string[]
): string | undefined => {
  let remaining = rawName;
  for (const quoted of quoteMatches) {
    remaining = remaining.replace(`「${quoted}」`, "");
  }
  remaining = remaining.replace(/TVアニメ|キャラクターソング|イメージソング|[「」]/gi, "").trim();
  const artistMatch = remaining.match(/[/／]\s*(.+)$/) || remaining.match(/^(.+?)\s*[/／]/);
  if (artistMatch) return artistMatch[1].trim();
  return remaining.length >= 2 && remaining.length <= 20 ? remaining : undefined;
};

const VERSION_ONLY_SPLIT_PART_PATTERN = /^(?:instrumental|off\s*vocal|tv\s*size|ver(?:sion)?)$/i;

/** 斜杠拆分的候选段：至少 2 字符且不是纯版本残留（instrumental / TV size 等）。 */
const splitRelatedTrackCandidates = (rawName: string): string[] =>
  rawName
    .split(/\s*[/／]\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !VERSION_ONLY_SPLIT_PART_PATTERN.test(part));

/** 真正的多曲并列（≥2 段）才拆成独立曲目：跳过与歌手重名的段与版本残留段。 */
const slashSplitRelatedTracks = (
  rawName: string,
  artist: string | undefined,
  kind: BangumiMusicTrackKind
): BangumiMusicTrack[] => {
  const candidates = splitRelatedTrackCandidates(rawName);
  if (candidates.length <= 1) return [];
  const tracks: BangumiMusicTrack[] = [];
  for (const part of candidates) {
    if (artist && part.toLowerCase() === artist.toLowerCase()) continue;
    const cleanPart = stripVersionInfo(part).trim();
    if (cleanPart.length >= 2) {
      tracks.push({ title: cleanPart, artist, kind });
    }
  }
  return tracks;
};

/** 单个音乐关联条目展开成候选曲目：引号题名、剥版本名、斜杠拆曲、原条目名，按历史顺序。 */
const relatedMusicTracksFor = (
  rawName: string,
  kind: BangumiMusicTrackKind,
  performers: string[]
): BangumiMusicTrack[] => {
  const quoteMatches = [...rawName.matchAll(/「([^」]+)」/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  const subTitle = quoteMatches.length > 0 ? quoteMatches.at(-1) : undefined;
  let artist: string | undefined;
  if (quoteMatches.length > 0) {
    artist = parseArtistFromQuotedRelation(rawName, quoteMatches);
  }
  if (!artist && performers.length === 1) {
    artist = performers[0];
  }

  const tracks: BangumiMusicTrack[] = [];
  if (subTitle && subTitle.length >= 2) {
    tracks.push({ title: subTitle, artist, kind });
  }

  const stripped = stripVersionInfo(rawName).trim();
  if (stripped && stripped !== rawName && stripped.length >= 2) {
    tracks.push({ title: stripped, artist, kind });
  }

  tracks.push(...slashSplitRelatedTracks(rawName, artist, kind));

  tracks.push({ title: rawName, artist, kind });
  return tracks;
};

const extractRelatedMusicTracks = (
  relations: unknown,
  performers: string[] = []
): BangumiMusicTrack[] => {
  const tracks: BangumiMusicTrack[] = [];
  for (const item of asArray(relations)) {
    const record = asRecord(item);
    if (record.type !== 3) continue;
    const relation = readString(record.relation) ?? "";
    const rawName = readString(record.name) ?? "";
    if (!rawName) continue;
    // 版权署名 / 制作委员会伪条目不是歌曲，混进曲目池会被当成 OP 拿去联网搜歌。
    if (isBangumiCreditsEntry(rawName)) continue;
    tracks.push(
      ...relatedMusicTracksFor(rawName, refineRelatedMusicKind(relation, rawName), performers)
    );
  }
  return tracks;
};

/**
 * 关联类型文本 → 曲目类型。规则顺序即优先级：靠前的先命中，没有任何规则命中时按主题曲处理
 * （原先末尾的「主题」规则与缺省结果相同，所以不再单列）。同一段文本可能同时命中多条规则，
 * 调整顺序会改变归类结果。
 */
const KIND_RULES: ReadonlyArray<readonly [RegExp, BangumiMusicTrackKind]> = [
  [/片头|片頭|opening|\bop\d*\b/i, "opening"],
  [/片尾|ending|\bed\d*\b/i, "ending"],
  [/插[入]?[曲歌]|insert|\bin\d*\b/i, "insert"],
  [/原声|soundtrack|\bost\b/i, "ost"],
  [/角色[歌曲]|character(?:\s*song)?/i, "character"],
  [/\bremix\b|重混/i, "remix"],
  [/同人/i, "doujin"],
  [/印象[曲歌]|image(?:\s*song)?/i, "image"],
  [/vocaloid/i, "vocaloid"],
  [/\bdrama\b|广播剧|廣播劇/i, "drama"],
  [/\bvocal\b/i, "vocal"],
  [/\bradio\b|广播|廣播/i, "radio"],
  [/\barrange\b|改编|改編|编曲|編曲/i, "arrange"],
  [/单曲|單曲|\bsingle\b/i, "single"],
  [/精选|精選|\bbest\b|collection/i, "collection"],
  [/朗读|朗讀/i, "reading"],
  [/艺人|藝人|album/i, "artistAlbum"],
];

const normalizeKind = (key: string): BangumiMusicTrackKind => {
  const normalized = key.trim();
  for (const [pattern, kind] of KIND_RULES) if (pattern.test(normalized)) return kind;
  return "theme";
};

const LINE_PREFIX_REGEX =
  /^\s*[（(【[]?(?:(OP\d*|ED\d*|IN\d*|TM\d*|片头曲\d*|片尾曲\d*|插入曲\d*|插曲\d*|主题歌\d*|主题曲\d*|OST|Remix|重混|角色[歌曲]\d*|同人音乐|印象曲|Vocaloid|Drama|VOCAL|Radio|Arrange|单曲|精选集|朗读剧|艺人专辑|Soundtrack|Character(?:\s*Song)?|Image(?:\s*Song)?))[^：:：-]*[:：-]?\s*/i;

const parseTrackText = (
  value: string,
  fallbackKind: BangumiMusicTrackKind
): BangumiMusicTrack[] => {
  const result: BangumiMusicTrack[] = [];
  for (const item of value.split(/[\r\n]+|[；;]+/)) {
    const trimmed = item.trim();
    if (!trimmed || trimmed.length < 2 || trimmed.length > 200) continue;
    let trackKind = fallbackKind;
    const prefixMatch = trimmed.match(LINE_PREFIX_REGEX);
    if (prefixMatch && prefixMatch[1]) {
      trackKind = normalizeKind(prefixMatch[1]);
    }
    const text = trimmed.replace(LINE_PREFIX_REGEX, "").trim();
    if (!text || text.length < 2) continue;
    const parts = text
      .split(/\s+[-－—]\s+|\s+\/\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    const title = parts[0];
    if (!title) continue;
    result.push({ title, artist: parts[1], kind: trackKind });
  }
  return result;
};

/** infobox 键与逐条 value 的 k 字段共用的音乐字段判定，两处口径必须一致。 */
const MUSIC_INFO_KEY_PATTERN =
  /(主题|片头|片尾|插入|插曲|opening|ending|insert|\bop\b|\bed\b|\bin\b|\btm\b|原声|\bost\b|soundtrack|remix|重混|角色|character|同人|印象|vocaloid|drama|vocal|radio|arrange|单曲|精选|朗读|艺人)/i;

/** Staff 字段（分镜 / 演出 / 作曲…）先排除，其余只保留音乐相关的 infobox 键。 */
const isMusicInfoboxKey = (key: string): boolean =>
  !STAFF_KEY_PATTERN.test(key) && MUSIC_INFO_KEY_PATTERN.test(key);

/**
 * 单个 infobox value：字符串走文本解析；对象形态用 k/name 细化 kind 或补歌手，
 * 文本解析无结果时退回原始标题。
 */
const infoboxValueTracks = (value: unknown, kind: BangumiMusicTrackKind): BangumiMusicTrack[] => {
  if (typeof value === "string") return parseTrackText(value, kind);
  const item = asRecord(value);
  const rawTitle = readString(item.v ?? item.value ?? item.title ?? item.name);
  if (!rawTitle) return [];
  const rawKey = readString(item.k ?? item.name);
  const rawArtist = readString(item.artist);
  let trackKind = kind;
  let artist = rawArtist;
  if (rawKey) {
    if (STAFF_KEY_PATTERN.test(rawKey)) return [];
    if (MUSIC_INFO_KEY_PATTERN.test(rawKey)) trackKind = normalizeKind(rawKey);
    else if (!artist) artist = rawKey;
  }
  const parsed = parseTrackText(rawTitle, trackKind);
  if (parsed.length === 0) return [{ title: rawTitle, artist, kind: trackKind }];
  return parsed.map((track) => ({
    title: track.title,
    artist: track.artist || artist,
    kind: track.kind,
  }));
};

/** 单条 infobox 键值行：键非音乐则整行跳过；values 为空数组时 value 可能是纯字符串。 */
const infoboxEntryTracks = (entry: unknown): BangumiMusicTrack[] => {
  const record = asRecord(entry);
  const key = readString(record.key ?? record.name) ?? "";
  if (!isMusicInfoboxKey(key)) return [];
  const kind = normalizeKind(key);
  const values = asArray(record.value);
  if (values.length === 0) {
    const text = readString(record.value);
    return text ? parseTrackText(text, kind) : [];
  }
  const tracks: BangumiMusicTrack[] = [];
  for (const value of values) {
    tracks.push(...infoboxValueTracks(value, kind));
  }
  return tracks;
};

/** 按 `kind:标题:歌手` 去重并剔除版权署名伪条目；保持条目原有顺序。 */
const dedupeMusicTracks = (tracks: BangumiMusicTrack[]): BangumiMusicTrack[] => {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    if (isBangumiCreditsEntry(track.title)) return false;
    const key = `${track.kind}:${track.title.trim().toLowerCase()}:${track.artist?.trim().toLowerCase() ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const extractBangumiMusicTracks = (
  infobox: unknown,
  relations?: unknown,
  performers: string[] = []
): BangumiMusicTrack[] => {
  const tracks: BangumiMusicTrack[] = [];
  if (relations) {
    tracks.push(...extractRelatedMusicTracks(relations, performers));
  }

  for (const entry of asArray(infobox)) {
    tracks.push(...infoboxEntryTracks(entry));
  }

  // 曲目顺序不再承载任何优先级：早期这里按 KIND_PRIORITY 把 opening 排到最前，
  // 与「按顺序取首个可播放曲目」叠加后，让线上近乎每轮都出片头曲。
  // 出题随机性统一由服务层洗牌决定（见 SonGuessrService.resolveAnimeSong）。
  return dedupeMusicTracks(tracks);
};
