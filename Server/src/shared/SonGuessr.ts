import { Type as t, type Static } from "@sinclair/typebox";
import { schemaUnion } from "./SchemaUnion";
import { AgentFocusInputSchema } from "./AgentActivity";
import {
  createClientEnvelopeSchema,
  RoomVisibilitySchema,
  type ChatMessage,
  type PlayerAccount,
  type RoomVisibility,
} from "./Model";
import type { ClientEnvelope } from "./Protocol";
import {
  MinPopularitySchema,
  SongAutoFiltersInputSchema,
  type SongAutoFilters,
} from "./SonGuessrFilters";

export const SONGUESSR_PHASES = [
  "waiting",
  "choosingSubmitter",
  "submittingSong",
  "playing",
  "roundResult",
] as const;

export type SonGuessrPhase = (typeof SONGUESSR_PHASES)[number];

export const MAX_SONGUESSR_COOKIE_LENGTH = 16_384;

const strict = { additionalProperties: false } as const;
const questionTypeSchema = t.Union([t.Literal("song"), t.Literal("anime")]);
const questionModeSchema = t.Union([t.Literal("manual"), t.Literal("automatic")]);
export type SongQuestionType = Static<typeof questionTypeSchema>;
export const SONG_QUESTION_TYPE_LABELS: Record<SongQuestionType, string> = {
  song: "听歌识曲",
  anime: "听歌识番",
};
export type SongQuestionMode = Static<typeof questionModeSchema>;

export * from "./SonGuessrFilters";

export interface BangumiSubjectSearchResult {
  id: string;
  name: string;
  nameCn: string;
  imageUrl?: string;
  year?: number;
  rating?: number;
  ratingCount?: number;
  tags: string[];
  metaTags: string[];
}

export type BangumiMusicTrackKind =
  | "opening"
  | "ending"
  | "insert"
  | "theme"
  | "ost"
  /**
   * 特典 CD（`特典CD` / `Special CD` / 初回限定盤）。
   *
   * 单列一档是因为它在 Bangumi 里既不是原声带也不是主题歌：整张特典盘挂在关系码
   * 3001（主题歌）下，实测 636 条。若沿用主题曲标签，玩家看到的「主题曲」里会混进
   * 添い寝タペストリー赠品盘、BD 各卷附赠 CD —— 这正是用户截图反馈的那类误标。
   */
  | "special"
  | "character"
  | "remix"
  | "doujin"
  | "image"
  | "vocaloid"
  | "drama"
  | "vocal"
  | "radio"
  | "arrange"
  | "single"
  | "collection"
  | "reading"
  | "artistAlbum";

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
 * 而 Bangumi 把原声带、特典 CD、广播剧 CD 全挂在它下面 —— 实测本地数据集 38554 条
 * 关联曲目里 18117 条是 `theme`，其中 `ORIGINAL SOUND TRACK` 类 5215 条、特典 CD
 * 636 条、精选集 505 条。只按关系码标注，玩家就会看到「主题曲」标签贴在校歌、
 * OST 曲目、特典盘曲目上（用户截图反馈）。条目名里的发行形态词是免费的区分信号。
 *
 * 判定顺序 = 具体优先：显式标注（ED/OP/插曲）> 原声带 > 特典 CD > 角色歌 > 印象曲
 * > 广播剧 > 电台 > 其余形态。只认完整词，避免普通曲名里的偶然片段被误判
 * （`\b` 边界 + 足够长的词）。
 *
 * 注意**带空格的写法必须覆盖**：实测《K-ON!! ORIGINAL SOUND TRACK Vol.2》正是因为
 * 旧规则只认连写的 `soundtrack` 而漏判成主题曲。
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

/**
 * 判断 Bangumi 关联条目是否为「版权署名 / 制作委员会」伪条目。
 *
 * Bangumi 的关联条目里混入了大量并非歌曲的署名条目，例如
 * `©BanG Dream! Project`、`©SUNRISE`、`©Visual Art's`、`©2007 竜騎士07`、
 * `（C）2009 NEOPLE`、`Ⓒ 創通・タツノコプロ`、`時をかける少女」製作委員会2006`。
 * 它们本地的 `music_id` 为负数（实测全库 7762 条），却被归到 `opening` 类目，
 * 按 `KIND_PRIORITY` 排在所有真实曲目之前。
 *
 * 若不剔除，解析关联歌曲时会拿「版权署名」去网易云搜歌，再经宽松的子串
 * 匹配把完全无关的歌曲当成 OP——例如把 2019 年专辑《Music For All》里的
 * 《Bang Dream!》当作 2023 年《BanG Dream! It's MyGO!!!!!》的 OP。
 *
 * 判定必须**只认无歧义的版权标记**，否则会误杀带美术字符的正常曲名。
 * 实测教训：把 `♡ / ❤ / ※ / Project$ / オール` 列入规则会误杀 126 首正版歌曲
 * （`unconditional L♡VE`、`♡km/h`、`Love❤Island`、`μ's オリジナルソングCD`、
 * `のだめカンタービレ オールシーズンズベスト` 等），故一概不予采用。
 *
 * 服务端两个 Bangumi Provider 与本模块的曲名门禁共用本函数，保证判定一致。
 */
export const isBangumiCreditsEntry = (title: string): boolean => {
  const value = title.trim();
  if (!value) return true;
  // 版权 / 商标 / 录音权标记：© ® ℗ 与 (C)/(R)/(P) 全角变体，任意位置出现即视为署名条目。
  // 注意：❤ ♡ ※ ☆ 等美术字符是正常曲名常用元素，绝不能纳入判定。
  if (
    /[©®℗Ⓒⓒ]|\(\s*[cC]\s*\)|（\s*[cCｃＣ]\s*）|\(\s*[rR]\s*\)|（\s*[rRＲ]\s*）|\(\s*[pP]\s*\)|（\s*[pPＰ]\s*）/.test(
      value
    )
  )
    return true;
  // 制作 / 製作委員会署名（且不含任何歌曲语义关键词）。如「時をかける少女」製作委員会2006。
  if (
    /(?:製作|制作)委員会|製作委員会/.test(value) &&
    !/曲|歌|テーマ|theme|opening|ending|insert/i.test(value)
  ) {
    return true;
  }
  return false;
};

export interface BangumiMusicTrack {
  title: string;
  artist?: string;
  kind: BangumiMusicTrackKind;
}

export interface BangumiSubjectDetails extends BangumiSubjectSearchResult {
  summary?: string;
  locked?: boolean;
  musicTracks: BangumiMusicTrack[];
}

export interface BangumiSongCandidate {
  track: BangumiMusicTrack;
  song: SongSearchResult;
}

/** 曲目类型枚举只有一份来源：`ALL_BANGUMI_TRACK_KINDS`，新增一档不必回来改 schema。 */
const trackKindSchema = schemaUnion(ALL_BANGUMI_TRACK_KINDS.map((kind) => t.Literal(kind)));

const AnimeAutoFiltersSchema = t.Object(
  {
    startYear: t.Optional(t.Integer({ minimum: 1900, maximum: 2200 })),
    endYear: t.Optional(t.Integer({ minimum: 1900, maximum: 2200 })),
    ranking: t.Optional(t.Union([t.Literal("all"), t.Literal("year")])),
    subjectLimit: t.Optional(t.Integer({ minimum: 1, maximum: 1000 })),
    songMinPopularity: t.Optional(MinPopularitySchema),
    trackKinds: t.Optional(t.Array(trackKindSchema, { maxItems: ALL_BANGUMI_TRACK_KINDS.length })),
  },
  strict
);
export type AnimeAutoFilters = Static<typeof AnimeAutoFiltersSchema>;

export interface SonGuessrSettings {
  questionType: SongQuestionType;
  questionMode: SongQuestionMode;
  autoRotateSubmitter: boolean;
  autoFilters: SongAutoFilters;
  animeAutoFilters?: AnimeAutoFilters;
  lyricsLineCount: number;
  showLyrics: boolean;
  bloodMode: boolean;
  maxGuessesPerRound: number;
  guessDurationSeconds: number;
  showGuessTimer: boolean;
  /** 是否允许 Agent（MCP）加入；缺省 false。 */
  allowAgents?: boolean;
}

export interface SonGuessrMusicAccount {
  platform?: "netease" | "qq";
  userId?: string;
  nickname: string;
  avatarUrl?: string;
  /** 当前账号会员状态；未知表示音乐平台会员接口暂时不可用。 */
  vipStatus?: "vip" | "nonVip" | "unknown";
  vipType?: number;
  vipExpireTime?: number;
  /**
   * 展示用的会员档位，按优先级取最高的一档：
   * 网易云：超级黑胶（svip）> 黑胶（vip）> 音乐包（musicPackage）；
   * QQ音乐：超级会员（svip）> 豪华绿钻（vip）（QQ音乐已无音乐包档位）。
   * 到期时间 `vipExpireTime` 与之对应；非会员或状态未知时缺席。
   */
  vipTier?: SonGuessrVipTier;
  /** 成长等级：网易云 1–7，QQ音乐 1–10；无等级档位缺席 */
  vipLevel?: number;
  /** 是否年费会员（QQ音乐年费绿钻/年费超级会员） */
  vipYear?: boolean;
}

export type SonGuessrVipTier = "svip" | "vip" | "musicPackage";

/**
 * 房间音乐账号池里的一号：某个玩家自愿贡献给本房使用的账号。
 *
 * 下发给全房（房主面板要列出每号的归属玩家、档位、在途与成功率），所以**不带 cookie**；
 * 凭据只留在服务端内存的房间记录里，房间关闭或贡献者离房即释放。
 */
export interface SonGuessrMusicPoolView {
  /** 贡献者玩家 id。 */
  playerId: string;
  /** 贡献者昵称：快照里已经带名字，前端不必再按 id 反查。 */
  playerName: string;
  platform: "netease" | "qq";
  account: SonGuessrMusicAccount;
  /** 共享开关：号主关掉、或凭据被判死时代服务端关闭，此时不参与取号。 */
  enabled: boolean;
  /**
   * 冷却截止时刻（毫秒）；冷却中不参与取号。风控与限流到点自动恢复（开关不动），
   * 凭据被判死则要号主重新登录才解除。只在冷却仍生效时下发，号主端据此提示「服务端已暂停」。
   */
  cooldownUntil?: number;
  /** 当前在途上游请求数：取号按最小在途平衡，单号另有并发上限。 */
  inFlight: number;
  /** 近期取号成功数与总数；前端按 `recentOk / recentTotal` 显示成功率。 */
  recentOk: number;
  recentTotal: number;
  /** 最近一次失败原因，供房主判断是账号问题还是曲目本身的问题。 */
  lastFailureReason?: string;
}

export interface SongLyricWord {
  startTime: number;
  endTime: number;
  word: string;
  romanWord?: string;
}

export interface SongLyricLine {
  time: number;
  endTime: number;
  text: string;
  words?: SongLyricWord[];
  translatedLyric?: string;
  romanLyric?: string;
  isBG?: boolean;
  isDuet?: boolean;
}

export interface SongLyricClip {
  startTime: number;
  endTime: number;
  lines: SongLyricLine[];
}

/** 手动出题选定的音频区间（毫秒），由客户端片段编辑器提交。 */
export interface SongClipRange {
  startTime: number;
  endTime: number;
}

/** 手动片段的最短长度：再短就听不出旋律。最长不超过整首歌。 */
export const SONG_CLIP_MIN_MS = 5_000;

/** 手动出题时的歌曲预览：只下发给当前出题人，供片段编辑器试听、选词与逐字演出。 */
export interface SongClipPreview {
  id: string;
  title: string;
  artist: string;
  album?: string;
  pictureUrl?: string;
  durationMs?: number;
  audioUrl: string;
  lyrics: SongLyricLine[];
  chorus?: SongChorus;
  /** 本曲的可用音源 URN（首个是当前播放源），提交时原样回传用于主源失败后的兜底。 */
  sources?: string[];
  /** 当前播放源是否会员专享；QQ 会员曲手动提交时要据此租会员号。 */
  requiresVip?: boolean;
  /**
   * 服务端按房间设置随机抽出的建议区间（与自动抽题同一套切片逻辑）。客户端用它作为
   * 片段编辑器的初始选择；出题人直接确认时播放的就是这一段。
   */
  suggestedClip?: SongClipRange;
}

export interface SongSearchResult {
  id: string;
  title: string;
  artist: string;
  album?: string;
  pictureUrl?: string;
  durationMs?: number;
  requiresVip?: boolean;
  /**
   * 聚合检索给出的同作品音源 URN（首个是当前主实体）。客户端选曲时原样回传；
   * 服务端在主源取不到音频时按序尝试，避免再按歌名重新搜索。
   */
  sources?: string[];
  /** 网易云接口中的热度/播放热度字段；部分接口会对超大值做模糊化处理。 */
  popularity?: number;
  /**
   * 网易云自标的版本关系：`1` = 原唱，`2` = 翻唱，`0` / 缺席 = 未标注。
   *
   * 这是判定「这首到底是不是原版」的**唯一可靠信号** —— 文本维度（曲名、专辑名）
   * 在翻唱面前完全失效：翻唱常把曲名与专辑名都照抄原曲（实测《裸の勇者》里 Vaundy
   * 原版与柯奇翻版的曲名、专辑名一字不差）。实测事故见 `Server/docs/BangumiApi.md`
   * 「原版优先排序」。
   *
   * 注意：只有歌曲**详情**接口（`/api/v3/song/detail`）稳定返回该字段，检索结果不带，
   * 因此它只能用于候选验证阶段，进不了检索阶段的排序。
   */
  originCoverType?: number;
  /**
   * 翻唱曲目所指向的原曲 ID（网易云随详情返回 `originSongSimpleData.songId`）。
   *
   * 有了它就能在「原版压根没进候选池」时直接回指原版（实测：Bangumi 存中文译名
   * 《你所不知道的故事》时，按译名检索只召回中文重填词的翻唱，原版
   * 《君の知らない物語》永远进不了池子），而不必依赖检索词补全。
   */
  originSongId?: string;
  /**
   * 本房当下能不能播这首：网易云有解灰兜底恒可播；QQ 免费曲（`pay_play=0`）匿名
   * 也可播，会员专享曲才要求池里有会员账号。
   *
   * 只是**展示与排序**用的提示，不是出题可用性判定 —— 真正的判据仍是取到一段
   * 码率正常的真实音频（见 `Server/docs/NeteaseMusicApi.md`「猜歌接入约束」），
   * 选曲链路也**不得**据此预剔除候选。
   */
  playable?: boolean;
  /** `playable === false` 时给玩家看的原因（如「需要 QQ 音乐会员账号」）。 */
  unplayableReason?: string;
}

export interface SongPlaylistInfo {
  id: string;
  name: string;
  songCount: number;
}

export interface SongArtistSearchResult {
  id: string;
  name: string;
  avatarUrl?: string;
}

/**
 * 专辑检索结果。
 *
 * 存在的理由：Bangumi 的 character / image / theme / ost 等关联条目经常指向**整张专辑**
 * （条目名就是专辑名，如《マジンボーン オリジナルサウンドトラック2》《キラッとプリ☆チャン♪
 * ソングコレクション》），拿专辑名当歌名去检索单曲必然一无所获。这类条目必须走
 * 「先按名搜专辑、再取专辑曲目」的路径才能拿到真正可出的歌。
 */
export interface SongAlbumSearchResult {
  id: string;
  name: string;
  artist?: string;
  pictureUrl?: string;
  songCount?: number;
}

export interface SongEncyclopedia {
  summary?: string;
  aliases?: string[];
  tags: string[];
}

export interface SongChorus {
  startTime: number;
  endTime?: number;
}

export interface SongDetails extends SongSearchResult {
  audioUrl: string;
  lyrics: SongLyricLine[];
  releaseYear?: number;
  popularity?: number;
  language?: string;
  encyclopedia: SongEncyclopedia;
  chorus?: SongChorus;
}

export type SongGuessDirection = "higher" | "lower" | "equal" | "unknown";

export interface SongGuessFeedback {
  releaseYear?: number;
  releaseYearDirection: SongGuessDirection;
  popularity?: number;
  popularityDirection: SongGuessDirection;
  languageMatch?: boolean;
  sharedTags: string[];
}

export interface SongGuessAttempt {
  id: string;
  playerId: string;
  playerName: string;
  guessNumber: number;
  createdAt: number;
  result: "wrong" | "timeout" | "correct" | "gaveUp";
  guessedSong?: SongSearchResult;
  guessedAnime?: BangumiSubjectSearchResult;
  feedback?: SongGuessFeedback;
}

export interface SonGuessrScore {
  playerId: string;
  playerName: string;
  score: number;
  delta: number;
  correctGuesses: number;
  totalGuesses: number;
}

/** 新计分（三因子模型）的逐人拆解，仅作展示：`score = round(10 × speed × precision)`。 */
export interface SonGuessrScoreFactor {
  playerId: string;
  speed: number;
  precision: number;
  score: number;
}

export interface SonGuessrScoreBreakdown {
  /** 难度分 D，出题人得分由它决定。 */
  difficulty: number;
  /** 可作答单元数，也就是正确率与血战排名的分母。 */
  answerableCount: number;
  players: SonGuessrScoreFactor[];
}

export interface SonGuessrRoundSummary {
  roundNumber: number;
  song: SongSearchResult & {
    releaseYear?: number;
    popularity?: number;
    language?: string;
    encyclopedia: SongEncyclopedia;
    audioUrl?: string;
    chorus?: SongChorus;
  };
  anime?: BangumiSubjectSearchResult;
  animeTrack?: BangumiMusicTrack;
  submitterPlayerId: string;
  correctPlayerIds: string[];
  attempts: SongGuessAttempt[];
  scores: SonGuessrScore[];
  /**
   * 计分拆解。历史对局与异常路径可能没有这个字段，前端只在拿到时展示，
   * 不假设它一定存在。
   */
  breakdown?: SonGuessrScoreBreakdown;
}

/** 协议允许的队伍号，与 CEE 一致；`null` 是个人游玩。 */
export const SONGUESSR_MAX_TEAM = 8;

/**
 * 一个玩家在一轮里的结局。
 *
 * 与单次猜测的 `SongGuessAttempt["result"]` 不是一回事：猜错还能再猜，
 * 用完次数、超时、投降与猜中才是「这一轮对他而言怎么结束的」。
 */
export type SonGuessrRoundMark = "correct" | "gaveUp" | "outOfGuesses" | "timeout";

export interface SonGuessrPlayerView {
  id: string;
  name: string;
  score: number;
  /**
   * 队伍号 1–8，`null` 为个人游玩；只在等待阶段由本人更改，旁观者没有队伍。
   * 同队共用一份猜测次数、猜测记录与限时：一人猜中全队结束，分数记给猜中者；出题人的队友本局观战。
   */
  team: number | null;
  membership: "active" | "spectator" | "kicked";
  nextRoundMembership?: "active" | "spectator";
  online: boolean;
  isReady: boolean;
  isBot: boolean;
  isAgent?: boolean;
  /** 该座位当前由 MCP 连接控制；人类会话只读。 */
  mcpControlled?: boolean;
  isHost: boolean;
  account?: PlayerAccount;
  correctGuesses: number;
  totalGuesses: number;
  /**
   * 本局逐轮的作答结果，按轮次追加；不作答的轮（出题人、其队友、旁观者）不产生条目，
   * 所以数组长度就是「他真正作答过的轮数」。
   *
   * 用枚举数组而不是猜猜呗那种标记串：那串 emoji 是为兼容原版房的上游输出而原样透传的，
   * 拿它当判定依据要解析字符、要处理变体选择符，加一档结果就得改解析器。
   * 数组直接由服务端算好，客户端只做一次穷举映射，漏一档是编译错误而不是画出一个空格。
   */
  roundMarks: SonGuessrRoundMark[];
  /** `teamCorrect`：队友已猜中，本人不再作答；`observing`：队友出题，本局观战。 */
  roundStatus:
    | "waiting"
    | "submitter"
    | "guessing"
    | "correct"
    | "teamCorrect"
    | "finished"
    | "spectator"
    | "observing";
  guessesUsed: number;
}

export interface SonGuessrRoomSummary {
  roomId: string;
  name: string;
  visibility: RoomVisibility;
  allowSpectators: boolean;
  hasPassword: boolean;
  playerCount: number;
  spectatorCount: number;
  onlineCount: number;
  phase: SonGuessrPhase;
  questionType: SongQuestionType;
  /** 房间是否允许 MCP / Agent 接入；大厅据此显示 MCP 徽标。 */
  allowAgents?: boolean;
}

export interface SonGuessrRoomSnapshot {
  roomId: string;
  name: string;
  /** 单人房间：无玩家栏、无聊天、由系统自动出题，不允许其他玩家加入。 */
  solo: boolean;
  visibility: RoomVisibility;
  allowSpectators: boolean;
  hasPassword: boolean;
  hostPlayerId: string;
  testMode: boolean;
  musicAccountReady: boolean;
  qqMusicAccountReady?: boolean;
  musicAccounts?: {
    netease?: SonGuessrMusicAccount;
    qq?: SonGuessrMusicAccount;
  };
  /**
   * 房间音乐账号池（每个玩家贡献的账号各一条）。等待阶段由贡献者自己开关；
   * 池内有号就能取号、池空即降级。只下发归属与统计，不含凭据。
   */
  musicPool?: SonGuessrMusicPoolView[];
  settings: SonGuessrSettings;
  phase: SonGuessrPhase;
  roundNumber: number;
  pendingSubmitterPlayerId?: string;
  /**
   * 出题人失效退回「选出题人」的原因。这个阶段页面会收起选歌面板，
   * 不写清楚为什么退回，房主会以为是页面自己跳的、玩家会以为房间卡住了。
   */
  submitterPrompt?: string;
  currentRound?: {
    roundNumber: number;
    submitterPlayerId: string;
    audioUrl: string;
    lyricClip: SongLyricClip;
  };
  players: SonGuessrPlayerView[];
  chat: ChatMessage[];
  roundSummary?: SonGuessrRoundSummary;
  finalScores?: SonGuessrScore[];
}

/**
 * 能不能开局看「有没有账号可用」：网易云与 QQ 是并列可选项，服务端 `startGame` 也是
 * 「池内两端都没有可用号」才拒。`musicAccountReady` 只代表网易云（账号面板等处仍按
 * 单平台语义用它），所以这里取「任一」而不是复用它。
 */
export const hasMusicAccount = (snapshot: {
  musicAccountReady: boolean;
  qqMusicAccountReady?: boolean;
}): boolean => snapshot.musicAccountReady || Boolean(snapshot.qqMusicAccountReady);

export interface SonGuessrPrivateState {
  playerId: string;
  sessionToken: string;
  /** 本座位已交给 MCP；人类连接收到的是脱敏私有状态。 */
  mcpControlled?: boolean;
  isSubmitter: boolean;
  /** 队友出题、本局观战：与出题人同样看得到答案与全房猜测，但不能作答。 */
  teamObserver: boolean;
  /**
   * 可指定的出题人，只下发给房主、只在手动出题的等待与选人阶段计算：在线真人，且他出题后
   * （连同队友一起观战）仍留得下猜歌的人。测试房的出题人自己也能猜，不受这一条限制。
   */
  submitterCandidateIds: string[];
  canSubmitSong: boolean;
  canGuess: boolean;
  canGiveUp: boolean;
  remainingGuesses: number;
  guessDeadlineAt?: number;
  submittedSong?: SongSearchResult;
  submittedAnime?: BangumiSubjectSearchResult;
  visibleAttempts: SongGuessAttempt[];
}

// ==================== 猜歌客户端指令契约（单一真相源） ====================
// 命令清单只有 `SonGuessrPayloadSchemas` 这一份：命令 union、载荷类型与运行时信封全部由它派生，
// 结构类型与 schema 不可能各写一份再漂移（猜歌封面命令曾因传输层漏键被恒定拒绝）。

/** 大厅房间列表的事件名；口径同 `WHOISFAKER_LOBBY_ROOMS_EVENT`，服务端与传输层丢弃判定读同一个常量。 */
export const SONGUESSR_LOBBY_ROOMS_EVENT = "song.lobby.rooms";

const emptyPayload = t.Object({}, strict);
const roomId = t.String({ minLength: 1, maxLength: 32 });
const roomName = t.String({ minLength: 1, maxLength: 40 });
const userName = t.String({ minLength: 1, maxLength: 32 });
const password = t.Optional(t.String({ maxLength: 64 }));
const playerId = t.String({ minLength: 1, maxLength: 64 });
const positiveInt = t.Integer({ minimum: 1 });
const keyword = t.String({ minLength: 1, maxLength: 200 });
const subjectId = t.String({ minLength: 1, maxLength: 32 });
const sessionToken = t.String({ minLength: 1, maxLength: 128 });
// 限定字符集：支持统一音源 URN (如 netease:123, qq:001...) 以及常见单平台 ID 形态。
const songId = t.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_:-]+$" });
/** 选曲时回传的备用音源：数量有上限，避免用协议放大上游请求。 */
const songPickSources = t.Optional(t.Array(songId, { maxItems: 6 }));
const musicPlatform = t.Union([t.Literal("netease"), t.Literal("qq")]);
const qrChannelType = t.Union([t.Literal("qq"), t.Literal("wx"), t.Literal("mobile")]);

export const SonGuessrPayloadSchemas = {
  "song.lobby.subscribeRooms": emptyPayload,
  "song.room.create": t.Object(
    {
      roomId,
      name: roomName,
      visibility: RoomVisibilitySchema,
      password,
      allowSpectators: t.Boolean(),
      userName,
      solo: t.Optional(t.Boolean()),
      allowAgents: t.Optional(t.Boolean()),
    },
    strict
  ),
  "song.room.join": t.Object({ userName, password }, strict),
  "song.room.reconnect": t.Object({ roomId, sessionToken }, strict),
  "song.room.leave": emptyPayload,
  "song.room.requestSync": emptyPayload,
  /** MCP 连接凭人类会话凭证认领座位；只有 Agent 连接可用。 */
  "mcp.claim": t.Object(
    { roomId, sessionToken: t.String({ minLength: 1, maxLength: 128 }) },
    strict
  ),
  /** 人类或控制器主动收回座位。 */
  "mcp.release": emptyPayload,
  /** MCP 上报「正在操作哪类界面」；不得携带答案、词语或搜索词。 */
  "mcp.focus": AgentFocusInputSchema,
  "song.player.setReady": t.Object({ ready: t.Boolean() }, strict),
  "song.player.setSpectator": t.Object({ spectator: t.Boolean() }, strict),
  "song.player.setTeam": t.Object(
    { team: t.Union([t.Integer({ minimum: 1, maximum: SONGUESSR_MAX_TEAM }), t.Null()]) },
    strict
  ),
  "song.room.updateSettings": t.Object(
    {
      name: t.Optional(roomName),
      visibility: t.Optional(RoomVisibilitySchema),
      password,
      allowSpectators: t.Optional(t.Boolean()),
      questionType: t.Optional(questionTypeSchema),
      questionMode: t.Optional(questionModeSchema),
      autoRotateSubmitter: t.Optional(t.Boolean()),
      autoFilters: t.Optional(SongAutoFiltersInputSchema),
      animeAutoFilters: t.Optional(AnimeAutoFiltersSchema),
      lyricsLineCount: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
      showLyrics: t.Optional(t.Boolean()),
      maxGuessesPerRound: t.Optional(positiveInt),
      guessDurationSeconds: t.Optional(t.Integer({ minimum: 5 })),
      bloodMode: t.Optional(t.Boolean()),
      showGuessTimer: t.Optional(t.Boolean()),
      allowAgents: t.Optional(t.Boolean()),
    },
    strict
  ),
  "song.room.kick": t.Object({ playerId }, strict),
  "song.room.transferHost": t.Object({ playerId }, strict),
  "song.chat.send": t.Object({ text: t.String({ minLength: 1, maxLength: 500 }) }, strict),
  "song.auth.qr.create": t.Object(
    { platform: t.Optional(musicPlatform), type: t.Optional(qrChannelType) },
    strict
  ),
  "song.auth.qr.check": t.Object(
    {
      platform: t.Optional(musicPlatform),
      key: t.String({ minLength: 1, maxLength: 512 }),
      type: t.Optional(qrChannelType),
    },
    strict
  ),
  "song.auth.useCookie": t.Object(
    {
      platform: t.Optional(musicPlatform),
      cookie: t.String({ minLength: 1, maxLength: MAX_SONGUESSR_COOKIE_LENGTH }),
    },
    strict
  ),
  "song.auth.clear": t.Object(
    {
      platform: t.Optional(t.Union([t.Literal("netease"), t.Literal("qq"), t.Literal("all")])),
    },
    strict
  ),
  /**
   * 贡献者开关自己的账号是否供本房使用。只在等待阶段可改，开局即锁死（服务端按阶段拒）。
   * 只影响自己的号；号不在池里时按「尚未登录」拒绝，不做隐式登录。
   */
  "song.auth.setPoolSharing": t.Object({ platform: musicPlatform, enabled: t.Boolean() }, strict),
  "song.music.search": t.Object({ keyword }, strict),
  /**
   * 出题人预览自己选中的歌：音频地址与行级歌词用于片段编辑。只允许当前待出题人调用，
   * 猜歌阶段的玩家拿不到答案的歌词与试听。
   */
  "song.music.detail": t.Object(
    { songId, sources: songPickSources, requiresVip: t.Optional(t.Boolean()) },
    strict
  ),
  "song.music.playlist.resolve": t.Object(
    { value: t.String({ minLength: 1, maxLength: 500 }) },
    strict
  ),
  "song.music.artist.search": t.Object({ keyword }, strict),
  "song.bangumi.search": t.Object({ keyword }, strict),
  "song.bangumi.songs": t.Object({ subjectId }, strict),
  /** 番剧封面：只读数据集不含图片，列表缺的封面滚进视口时按需补一条。 */
  "song.subject.image": t.Object({ subjectId }, strict),
  "song.game.start": emptyPayload,
  "song.game.chooseSubmitter": t.Object({ playerId }, strict),
  "song.game.submitSong": t.Object(
    {
      songId,
      /** 手动选定片段；缺省时沿用自动切片，越界或无效时服务端退回整曲。 */
      clip: t.Optional(
        t.Object(
          {
            startTime: t.Number({ minimum: 0 }),
            endTime: t.Number({ minimum: 0 }),
          },
          strict
        )
      ),
      /** 检索时给出的同作品备用音源；主源取不到音频时按序兜底。 */
      sources: songPickSources,
      /** 主源是否会员专享；QQ 会员曲据此租会员号。 */
      requiresVip: t.Optional(t.Boolean()),
    },
    strict
  ),
  "song.game.submitAnime": t.Object({ subjectId, songId: t.Optional(songId) }, strict),
  "song.game.audioReady": t.Object({ roundNumber: positiveInt }, strict),
  "song.game.audioFailed": t.Object({ roundNumber: positiveInt }, strict),
  "song.game.guess": t.Object({ songId }, strict),
  "song.game.guessAnime": t.Object({ subjectId }, strict),
  "song.game.giveUp": emptyPayload,
  "song.game.skipRound": emptyPayload,
  "song.game.nextRound": emptyPayload,
  "song.game.finish": emptyPayload,
  "song.test.addBot": t.Object({ count: t.Optional(positiveInt) }, strict),
  "song.test.removeBot": t.Object({ count: t.Optional(positiveInt) }, strict),
} as const;

export type SonGuessrCommand = keyof typeof SonGuessrPayloadSchemas;
export type SonGuessrPayload<TCommand extends SonGuessrCommand> = Static<
  (typeof SonGuessrPayloadSchemas)[TCommand]
>;
export type SonGuessrClientMessage = {
  [K in SonGuessrCommand]: ClientEnvelope<K, SonGuessrPayload<K>>;
}[SonGuessrCommand];

const createSonGuessrMessageSchema = <K extends SonGuessrCommand>(type: K) =>
  createClientEnvelopeSchema(type, SonGuessrPayloadSchemas[type]);

export const SonGuessrMessageSchemas = Object.fromEntries(
  (Object.keys(SonGuessrPayloadSchemas) as SonGuessrCommand[]).map((type) => [
    type,
    createSonGuessrMessageSchema(type),
  ])
) as { [K in SonGuessrCommand]: ReturnType<typeof createSonGuessrMessageSchema<K>> };

export const SonGuessrClientMessageSchema = schemaUnion(Object.values(SonGuessrMessageSchemas));

/**
 * 猜歌进房 ack 会带上首屏快照与私有态，客户端据此直接进入房间，不必再等一次 event。
 * 与卧底的 ack 形态不同，所以两份各自声明，不合并成一个「通用进房结果」。
 */
export interface SonGuessrRoomEnterAck {
  roomId: string;
  playerId: string;
  sessionToken: string;
  snapshot: SonGuessrRoomSnapshot;
  privateState: SonGuessrPrivateState;
}

/**
 * 扫码登录二维码：服务端把上游 `MusicQrLogin` 原样透传，这里是它在线路上的形状。
 * 客户端 `SongAccountSettings` 原先自己抄了一份同名接口，现在两边引用这里。
 */
export interface SonGuessrQrCreateAck {
  key: string;
  qrUrl: string;
  qrImage: string;
}

/** 轮询扫码结果：未完成时只有状态与提示，授权成功才带上会话凭据。 */
export interface SonGuessrQrCheckAck {
  status: "waiting" | "scanned" | "expired" | "authorized";
  message: string;
  cookie?: string;
  account?: SonGuessrMusicAccount;
}

/** Cookie 登录的回包（`useMusicCookie` 成功后总是给出账号与凭据）。 */
export interface SonGuessrCookieAuthAck {
  account: SonGuessrMusicAccount;
  cookie: string;
}

/** 命令 → ack 载荷：客户端 facade 的类型由这里推导，不再另写一份映射。 */
export type SonGuessrAck<TCommand extends SonGuessrCommand> = TCommand extends
  "song.room.create" | "song.room.join" | "song.room.reconnect"
  ? SonGuessrRoomEnterAck
  : TCommand extends "song.auth.qr.create"
    ? SonGuessrQrCreateAck
    : TCommand extends "song.auth.qr.check"
      ? SonGuessrQrCheckAck
      : TCommand extends "song.auth.useCookie"
        ? SonGuessrCookieAuthAck
        : TCommand extends "song.auth.clear"
          ? { cleared: true }
          : TCommand extends "song.auth.setPoolSharing"
            ? { enabled: boolean }
            : TCommand extends "song.music.search"
              ? { results: SongSearchResult[] }
              : TCommand extends "song.music.detail"
                ? { song: SongClipPreview }
                : TCommand extends "song.bangumi.search"
                  ? { results: BangumiSubjectSearchResult[] }
                  : TCommand extends "song.bangumi.songs"
                    ? { results: BangumiSongCandidate[] }
                    : TCommand extends "song.music.artist.search"
                      ? { results: SongArtistSearchResult[] }
                      : TCommand extends "song.music.playlist.resolve"
                        ? { playlist: SongPlaylistInfo }
                        : TCommand extends "song.subject.image"
                          ? { imageUrl: string | undefined }
                          : Record<string, unknown>;
