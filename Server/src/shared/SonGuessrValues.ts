// ==================== 猜歌（SonGuessr）纯值 ====================
// 客户端从这里取值；本文件不得引入任何 schema 构造模块。
import type { BangumiMusicTrackKind, SongLyricLine, SongQuestionType } from "./SonGuessr";

export const SONG_QUESTION_TYPE_LABELS: Record<SongQuestionType, string> = {
  song: "听歌识曲",
  anime: "听歌识番",
};

export const ALL_BANGUMI_TRACK_KINDS: readonly BangumiMusicTrackKind[] = [
  "opening",
  "ending",
  "insert",
  "theme",
  "ost",
  "special",
  "character",
  "remix",
  "doujin",
  "image",
  "vocaloid",
  "drama",
  "vocal",
  "radio",
  "arrange",
  "single",
  "collection",
  "reading",
  "artistAlbum",
] as const;

export const BANGUMI_TRACK_KIND_LABELS: Record<BangumiMusicTrackKind, string> = {
  opening: "OP",
  ending: "ED",
  insert: "插曲",
  theme: "主题曲",
  ost: "OST",
  special: "特典CD",
  character: "角色曲",
  remix: "Remix",
  doujin: "同人音乐",
  image: "印象曲",
  vocaloid: "Vocaloid",
  drama: "Drama",
  vocal: "VOCAL",
  radio: "Radio",
  arrange: "Arrange",
  single: "单曲",
  collection: "精选集",
  reading: "朗读剧",
  artistAlbum: "艺人专辑",
};

/**
 * 从歌曲元数据（曲名 / 专辑 / 标签）中提取无歧义的主题曲类型标注。
 *
 * Bangumi 的关联条目分类经常比网易云歌曲自身标注更粗：官方 MV、单曲碟会被归到
 * 「其他 → 主题曲」，片尾曲的专辑条目也可能挂在「插入歌」下。因此当歌曲元数据里
 * 明确写着「片尾曲 / ED」时，必须以歌曲标注为准确认类型，否则会出现
 * 「片尾曲的歌配着插曲徽章」这类错配。
 *
 * 只认可带「曲 / 歌 / テーマ」后缀或完整英文单词的写法，避免把普通歌名里
 * 偶然出现的 `in`、`ed` 片段误判成插入歌或片尾曲。
 *
 * 服务端曲目校准与客户端徽章展示共用本函数，保证两端判定一致。
 */
export const detectExplicitTrackKind = (text: string): BangumiMusicTrackKind | undefined => {
  if (/片尾曲|片尾歌|片尾主題歌|片尾主题歌|エンディングテーマ|エンディング|\bending\b/i.test(text))
    return "ending";
  if (
    /片头曲|片頭曲|片头歌|片头主題歌|片头主题歌|オープニングテーマ|オープニング|\bopening\b/i.test(
      text
    )
  )
    return "opening";
  if (/插入歌|插曲|挿入歌|剧中歌|劇中歌|\binsert\s*song\b/i.test(text)) return "insert";
  return undefined;
};

/**
 * 条目名 / 专辑名里的**发行形态**关键词 → 曲目类型。
 *
 * 为什么必须有这一层：Bangumi 的关联条目分类远比条目名粗。关系码 3001 是「主题歌」，
 * 而 Bangumi 把原声带、特典 CD、广播剧 CD 全挂在它下面。只按关系码标注，玩家就会看到
 * 「主题曲」标签贴在校歌、OST 曲目、特典盘曲目上。条目名里的发行形态词是免费的区分信号。
 *
 * 判定顺序 = 具体优先：显式标注（ED/OP/插曲）> 原声带 > 特典 CD > 角色歌 > 印象曲
 * > 广播剧 > 电台 > 其余形态。只认完整词，避免普通曲名里的偶然片段被误判
 * （`\b` 边界 + 足够长的词）。
 *
 * 注意**带空格的写法必须覆盖**：正常发行名常把 soundtrack 写成两个词，只认连写会漏判。
 */
export const detectTrackKindFromText = (text: string): BangumiMusicTrackKind | undefined => {
  const explicit = detectExplicitTrackKind(text);
  if (explicit) return explicit;
  if (
    /サウンドトラック|sound\s*track|オリジナルサウンド|原声|原聲|\bost\b|劇伴|剧伴|\bbgm\b|音楽集|音乐集/i.test(
      text
    )
  )
    return "ost";
  if (/特典|special\s*cd|初回限定|限定盤|限定盘/i.test(text)) return "special";
  if (/キャラクターソング|キャラソン|角色歌|角色曲|character\s*song/i.test(text))
    return "character";
  if (/イメージソング|印象[曲歌]|image\s*song/i.test(text)) return "image";
  // 广播剧看 `ドラマ`（片假名）—— 旧规则只认拉丁 `drama`，把满篇 `ドラマCD` 放进了主题曲。
  // 「ドラマチック / ドラマティック」（dramatic）是正常曲名，必须排除。
  if (
    /ドラマ(?!チック|ティック|ツルギー)|sound\s*drama|voice\s*drama|audio\s*drama|ボイスドラマ|\bdrama\s*(?:cd|album|track)\b|广播剧|廣播劇/i.test(
      text
    )
  )
    return "drama";
  if (
    /ラジオ\s*cd|ラジオ\s*「|\bradio\s*(?:cd|digest|show)\b|\baudio\s*drama\s*&\s*radio\b/i.test(
      text
    )
  )
    return "radio";
  if (/リミックス|\bremix\b|重混/i.test(text)) return "remix";
  if (/同人/i.test(text)) return "doujin";
  if (/vocaloid/i.test(text)) return "vocaloid";
  if (/オーケストラ|\borchestra\b|交響|交响|管弦|改编|改編|编曲|編曲|\barra\w*/i.test(text))
    return "arrange";
  if (/ボーカル|\bvocal\b|歌集|ソング集/i.test(text)) return "vocal";
  if (/单曲|單曲|\bsingle\b/i.test(text)) return "single";
  if (/精选|精選|ベスト|\bbest\b|collection|コレクション|コンプリート|complete/i.test(text))
    return "collection";
  if (/朗读|朗讀/i.test(text)) return "reading";
  if (/艺人|藝人|\balbum\b/i.test(text)) return "artistAlbum";
  if (/主题[曲歌]|主題[曲歌]|テーマソング|テーマ|\btheme\b/i.test(text)) return "theme";
  return undefined;
};

/**
 * 在关联条目已有的粗分类（`kind`）基础上，用歌曲 / 条目自身文本细化类型。
 *
 * 服务端曲目校准与客户端徽章展示共用本函数，保证两端判定一致：先认无歧义的显式标注
 * （「片尾曲」覆盖 Bangumi 的「插入歌」粗分类），`theme` 这个桶再用发行形态细化
 * （见 `detectTrackKindFromText`），其余具体分类原样保留。
 */
export const refineTrackKindByText = (
  kind: BangumiMusicTrackKind,
  text: string
): BangumiMusicTrackKind => {
  const explicit = detectExplicitTrackKind(text);
  if (explicit) return explicit;
  if (kind !== "theme") return kind;
  return detectTrackKindFromText(text) ?? kind;
};

/** 手动片段的最短长度：再短就听不出旋律。最长不超过整首歌。 */
export const SONG_CLIP_MIN_MS = 5_000;

export const LYRIC_CLIP_LEAD_MS = 1_000;
/**
 * 上一句没有真实结束时间戳时使用的提前量。
 *
 * 行级兜底歌词的 `endTime` 是清洗时按「下一句起始时间」补算出来的，拿它当边界等于把提前量
 * 压成 0，首句会在静音渐入中唱完；因此这种情况下仍给固定提前量，只是比有逐字时间时短。
 */
export const LYRIC_CLIP_LEAD_WITHOUT_END_MS = 700;
/** 片段终点在最后一句唱完后的留白，给客户端渐出让位。 */
export const LYRIC_CLIP_TAIL_MS = 1_000;
export const MAX_LYRIC_LINE_DURATION_MS = 12_000;

/** 与 `sanitizeLyrics` 同一口径：只有带逐字且原始终点晚于起点的行，才算有真实结束时间戳。 */
export const hasRealLyricEnd = (line: SongLyricLine) =>
  Boolean(line.words && line.words.length > 0) && line.endTime > line.time;

/**
 * 一句歌词实际唱到的时刻。行级歌词的 `endTime` 只是下一句的起始时间，后面可能跟着长间奏，
 * 所以按单句跨度上限收口，不能把间奏当成这句还在唱。
 */
export const lyricSungEnd = (line: SongLyricLine) =>
  hasRealLyricEnd(line)
    ? line.endTime
    : Math.min(line.endTime, line.time + MAX_LYRIC_LINE_DURATION_MS);

/**
 * 出题窗口可用的提前量：最多退到窗口前最后一句（含和声）的结束时刻。
 *
 * 退得比上一句唱完更早，玩家会在题目开始前先听半句无关唱词，歌词也跟着亮出窗口外的行。
 */
export const lyricLeadMs = (lyrics: readonly SongLyricLine[], windowStartTime: number): number => {
  let previous: SongLyricLine | undefined;
  for (const line of lyrics) {
    if (line.time >= windowStartTime) continue;
    if (!previous || line.time > previous.time) previous = line;
  }
  if (!previous) return LYRIC_CLIP_LEAD_MS;
  if (!hasRealLyricEnd(previous)) return LYRIC_CLIP_LEAD_WITHOUT_END_MS;
  return Math.min(LYRIC_CLIP_LEAD_MS, Math.max(0, windowStartTime - previous.endTime));
};

/**
 * 一句歌词算不算在手动片段里。服务端写回合、编辑器画选区都用这一条，两边看到的行才一致。
 *
 * 起点落在某句中间时那一句仍算在内，但只剩提前量那点尾巴的不算：它在渐入里就结束了，
 * 留下来只会让歌词组件把一句根本没唱的行摆在最前面，读作「首句一开始就播完了」。
 * 终点同理，渐出段里才起头的下一句不算。
 */
export const isLyricLineInClip = (line: SongLyricLine, startTime: number, endTime: number) => {
  if (line.time >= endTime - LYRIC_CLIP_TAIL_MS) return false;
  return line.time >= startTime || lyricSungEnd(line) - startTime > LYRIC_CLIP_LEAD_MS;
};

/**
 * 能不能开局看「有没有账号可用」：网易云与 QQ 是并列可选项，服务端 `startGame` 也是
 * 「池内两端都没有可用号」才拒。`musicAccountReady` 只代表网易云（账号面板等处仍按
 * 单平台语义用它），所以这里取「任一」而不是复用它。
 */
export const hasMusicAccount = (snapshot: {
  musicAccountReady: boolean;
  qqMusicAccountReady?: boolean;
}): boolean => snapshot.musicAccountReady || Boolean(snapshot.qqMusicAccountReady);
