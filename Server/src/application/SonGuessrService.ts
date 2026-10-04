import {
  BOT_NAME_SUFFIXES,
  CHAT_LIMIT,
  HOST_RECONNECT_TIMEOUT_MS,
  JOIN_PASSWORD_MAX_ATTEMPTS,
  JOIN_PASSWORD_WINDOW_MS,
  PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS,
  ROOM_EMPTY_GRACE_PERIOD_MS,
  ROOM_IDLE_TIMEOUT_MS,
  TEST_BOT_BATCH_LIMIT,
  TEST_MODE_MAX_PLAYERS,
} from "../config/Constants";
import { AppError } from "../domain/Errors";
import {
  ensureRoomId,
  normalizeName,
  normalizeWord,
  safeEqualToken,
  shuffle,
  type RandomSource,
} from "../domain/Rules";
import { ROOM_ID_TEST_MODE, type ConnectionRecord, type RoomVisibility } from "../domain/Model";
import { describeError, type EventLogger } from "../infrastructure/EventLogger";
import { SlidingWindowRateLimiter } from "../infrastructure/RateLimiter";
import {
  musicIpScope,
  type MusicLoginSession,
  type MusicProvider,
} from "../infrastructure/NeteaseMusicProvider";
import {
  ALL_BANGUMI_TRACK_KINDS,
  detectExplicitTrackKind,
  isBangumiCreditsEntry,
  MAX_SONGUESSR_COOKIE_LENGTH,
  SERVER_SHUTDOWN_MESSAGE,
} from "../shared/Index";
import type {
  ChatMessage,
  SongDetails,
  SongGuessAttempt,
  SongGuessDirection,
  SongGuessFeedback,
  SonGuessrClientMessage,
  SonGuessrPhase,
  SonGuessrPlayerView,
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
  SonGuessrRoomSummary,
  SonGuessrRoundSummary,
  SonGuessrScore,
  SonGuessrSettings,
  SongAutoFilters,
  SongAutoFiltersInput,
  SongSearchResult,
  SongAlbumSearchResult,
  SongLyricClip,
  BangumiSubjectDetails,
  BangumiSubjectSearchResult,
  BangumiMusicTrack,
  BangumiMusicTrackKind,
  AnimeAutoFilters,
  BangumiSongCandidate,
} from "../shared/Index";

import type { BangumiDataProvider } from "../infrastructure/LocalBangumiProvider";
import { createEvent } from "../transport/Packets";
import { ConnectionRegistry } from "./ConnectionRegistry";
import { unsupportedCommand } from "./handlers/CommandHandler";

const DEFAULT_SETTINGS: SonGuessrSettings = {
  questionType: "song",
  questionMode: "manual",
  autoRotateSubmitter: false,
  autoFilters: { artists: [], minPopularity: 0 },
  animeAutoFilters: { ranking: "all", subjectLimit: 50, songMinPopularity: 0, trackKinds: [...ALL_BANGUMI_TRACK_KINDS] },
  lyricsLineCount: 5,
  showLyrics: true,
  bloodMode: false,
  maxGuessesPerRound: 3,
  guessDurationSeconds: 60,
  showGuessTimer: true,
};

/** 未配置歌单或歌手时使用网易云热歌榜作为默认题库。 */
const DEFAULT_AUTO_PLAYLIST_ID = "3778678";

const SCORING = {
  correct: 1,
  submitterPerCorrect: 3,
  /**
   * 无人猜中时出题人的保底奖励。
   *
   * 必须严格小于 `submitterPerCorrect`（一人猜中），否则「出无人能猜的题」比
   * 「出有人猜中的题」收益更高，出题人的最优策略会与游戏目标相反。
   * 取 2 而非 3：0 人猜中 = 2、1 人猜中 = 3、2 人猜中 = 6，单调性成立。
   * 「取 2 还是取 0」属手感调优，留到有真实对局数据后再定。
   */
  submitterNobodyCorrect: 2,
} as const;

interface SonGuessrPlayerRecord {
  id: string;
  sessionToken: string;
  name: string;
  membership: "active" | "spectator" | "kicked";
  nextRoundMembership?: "active" | "spectator";
  online: boolean;
  isReady: boolean;
  score: number;
  correctGuesses: number;
  totalGuesses: number;
  isBot: boolean;
  joinedAt: number;
  lastSeenAt: number;
  connectionId?: string;
}

interface SonGuessrRoundPlayerState {
  audioReady: boolean;
  guessesUsed: number;
  correct: boolean;
  gaveUp: boolean;
  deadlineAt?: number;
  inFlight?: boolean;
}

interface SonGuessrRoundRecord {
  number: number;
  submitterPlayerId: string;
  song: SongDetails;
  anime?: BangumiSubjectDetails;
  animeTrack?: BangumiMusicTrack;
  lyricClip: SongLyricClip;
  attempts: SongGuessAttempt[];
  correctPlayerIds: string[];
  startScores: Record<string, number>;
  players: Record<string, SonGuessrRoundPlayerState>;
  settings: SonGuessrSettings;
  audioPreparationDeadlineAt: number;
  audioReadyDeadlineAt?: number;
  /**
   * 回合硬截止。全程锚定「首名玩家真正具备答题条件的时刻」，
   * 因此绝不能在建回合时按「建回合时刻 + N 秒」预设：自动模式的选曲会跨多次上游请求，
   * 本字段若在玩家能答题之前就耗尽，房间会在倒计时还剩几十秒时直接结算。
   */
  hardDeadlineAt?: number;
}

interface SonGuessrRoomRecord {
  id: string;
  name: string;
  solo: boolean;
  visibility: RoomVisibility;
  password?: string;
  allowSpectators: boolean;
  hostPlayerId: string;
  settings: SonGuessrSettings;
  phase: SonGuessrPhase;
  roundNumber: number;
  pendingSubmitterPlayerId?: string;
  currentRound?: SonGuessrRoundRecord;
  roundSummary?: SonGuessrRoundSummary;
  finalScores?: SonGuessrScore[];
  musicAuthOperation?: symbol;
  musicSession?: {
    ownerPlayerId: string;
    cookie: string;
    account: MusicLoginSession["account"];
  };
  players: Record<string, SonGuessrPlayerRecord>;
  chat: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  emptySinceAt?: number;
  automaticRoundLoading?: boolean;
  automaticRoundOperation?: symbol;
  manualRoundStarting?: boolean;
  hostReconnectDeadlineAt?: number;
  recentSongIds?: string[];
  recentSubjectIds?: string[];
  /** 空闲关闭预警是否已经广播过，避免每个巡检周期重复下发。 */
  expiringNotified?: boolean;
}

export interface SonGuessrServiceOptions {
  musicProvider: MusicProvider;
  bangumiProvider?: BangumiDataProvider;
  now?: () => number;
  random?: RandomSource;
  eventLogger?: EventLogger;
}

const clampInt = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, Math.round(value)));

const cloneSettings = (settings: SonGuessrSettings): SonGuessrSettings => ({
  ...settings,
  autoFilters: {
    ...settings.autoFilters,
    playlist: settings.autoFilters.playlist ? { ...settings.autoFilters.playlist } : undefined,
    artists: settings.autoFilters.artists.map((artist) => ({ ...artist })),
  },
  animeAutoFilters: settings.animeAutoFilters ? {
    ...settings.animeAutoFilters,
    trackKinds: [...(settings.animeAutoFilters.trackKinds ?? ALL_BANGUMI_TRACK_KINDS)],
  } : undefined,
});

const normalizeSongText = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_'"“”‘’·.，,。!！?？()（）[\]【】]/g, "");
const VERSION_MARKER_PATTERN = /(?:伴奏|纯音乐|电视尺寸|动画剪辑|\b(?:inst(?:rumental)?\.?|off\s*vocal|karaoke|tv\s*size|anime\s*edit|radio\s*edit|ver(?:sion)?\.?|version|mix|edit|remaster(?:ed)?|live|acoustic|demo|cover|remix|feat(?:uring)?\.?)\b)/iu;
const BRACKETED_VERSION_PATTERN = /\s*[（(【[]\s*([^）)】\]]*)\s*[）)】\]]/gu;
const DECORATED_VERSION_SUFFIX_PATTERN = /\s*[-~～–—]+\s*(.*?)\s*(?:[-~～–—]+\s*)?$/u;
const BARE_VERSION_SUFFIX_PATTERN = /\s+(?:inst(?:rumental)?\.?|off\s*vocal|karaoke|伴奏|纯音乐|电视尺寸|动画剪辑|tv\s*size|anime\s*edit|radio\s*edit|remix|(?:[^\s]+\s+)?ver(?:sion)?\.?)\s*$/iu;
const FEAT_SUFFIX_PATTERN = /\s*(?:[（(【[]\s*)?feat(?:uring)?\.?\s*[^）)】\]]+[）)】\]]?\s*$/iu;

const stripSongVersionInfo = (value: string) => {
  let result = value.replace(
    BRACKETED_VERSION_PATTERN,
    (match, metadata: string) => VERSION_MARKER_PATTERN.test(metadata) ? "" : match,
  );

  while (true) {
    const next = result
      .replace(
        DECORATED_VERSION_SUFFIX_PATTERN,
        (match, metadata: string) => VERSION_MARKER_PATTERN.test(metadata) ? "" : match,
      )
      .replace(BARE_VERSION_SUFFIX_PATTERN, "")
      .replace(FEAT_SUFFIX_PATTERN, "");
    if (next === result) return result;
    result = next;
  }
};

const normalizeSongTitle = (value: string) =>
  normalizeSongText(stripSongVersionInfo(value));

/**
 * 「候选名是期望名的截断」这一方向的匹配门槛。
 *
 * 反方向（候选名**包含**期望名，如 `曲名 - 番剧名`、`曲名 (TV Size)`）是合法常态，
 * 保持宽松即可；但反过来，候选只是期望名的一小段时，实测全是误匹配事故：
 * Bangumi《いつだってYELL》（忍者乱太郎 ED）匹配上 2026 年毫无关系的《Yell》，
 * 《ぼくらは小さな悪魔》匹配上《ぼくら》。要求截断名既够长、又占原名足够比例。
 */
export const MIN_TRUNCATED_TITLE_LENGTH = 4;
export const MIN_TRUNCATED_TITLE_RATIO = 0.6;

/**
 * 曲名里的「多曲并列」分隔符：双 A 面单曲、合作曲会把两首歌写进同一个条目名。
 *
 * Bangumi 记 `メグメル／だんご大家族`（《CLANNAD》双 A 面单曲），网易云候选只是其中
 * 一首《だんご大家族》 —— 两者指同一张单曲、同一首可出的歌。这类并列必须先拆段再比对，
 * 否则会被「截断门槛」误判成「候选只是原名的一小段」而拒掉。
 */
const TITLE_SEGMENT_SEPARATOR_PATTERN = /[\/／・&＆+＋、,，;；]|\bfeat(?:uring)?\.?\b|\bwith\b/iu;

const splitTitleSegments = (value: string): string[] =>
  value.split(TITLE_SEGMENT_SEPARATOR_PATTERN).map(normalizeSongTitle).filter(Boolean);

export const isSongTitleMatch = (candidateTitle: string, expectedTitle: string): boolean => {
  // 版权署名 / 制作委员会条目不是歌曲。若放任其参与子串匹配，
  // `©BanG Dream! Project` 会因包含 `banGdream` 而与《Bang Dream!》误判为同一首，
  // 从而把完全无关的歌曲当成番剧主题曲（实测事故）。
  if (isBangumiCreditsEntry(candidateTitle) || isBangumiCreditsEntry(expectedTitle)) return false;
  const normCandidate = normalizeSongTitle(candidateTitle);
  const normExpected = normalizeSongTitle(expectedTitle);
  if (!normCandidate || !normExpected) return false;
  if (normCandidate === normExpected) return true;
  // 多曲并列：条目名或候选名拆段后任一段完全一致，即视为同一首。
  const expectedSegments = splitTitleSegments(expectedTitle);
  if (expectedSegments.length > 1) {
    const candidateSegments = new Set(splitTitleSegments(candidateTitle));
    if (expectedSegments.some((segment) => segment.length >= 2 && candidateSegments.has(segment))) {
      return true;
    }
  }
  const minLen = Math.min(normCandidate.length, normExpected.length);
  if (minLen < 2) return false;
  // 候选名更长：`曲名 - 番剧名` / `曲名 (TV Size)` 这类合法形态，照旧放行。
  if (normCandidate.includes(normExpected)) return true;
  // 候选名更短：只接受「截断得不多」的情形（见上面的门槛注释）。
  const maxLen = Math.max(normCandidate.length, normExpected.length);
  return normExpected.includes(normCandidate)
    && minLen >= MIN_TRUNCATED_TITLE_LENGTH
    && minLen / maxLen >= MIN_TRUNCATED_TITLE_RATIO;
};

export const normalizedArtists = (value: string) =>
  new Set(
    value
      .split(/\s*(?:,|，|、|&|＆|\/|／|;|；|\bx\b|\bfeat(?:uring)?\.?\b|\bwith\b)\s*/iu)
      .map(normalizeSongText)
      .filter(Boolean),
  );

/** 明确指向翻唱、改编或非原唱的标记（标题、专辑与标签通用）。 */
const COVER_MARKER_PATTERN =
  /翻唱|翻錄|翻录|カバー|커버|\bcover(?:ed|s|ing)?\b|重唱|再唱|自翻|试唱|試唱|模仿|リミックス|カヴァー/iu;
/** 没有人声的版本标记：伴奏、纯音乐、卡拉 OK —— 这类音轨根本无法当题面。 */
const NO_VOCAL_VERSION_PATTERN =
  /伴奏|純伴奏|纯伴奏|纯音乐|纯音楽|純音樂|純音楽|off\s*vocal|インスト|karaoke|カラオケ|伴唱|和声伴奏|ボーカルレス|\binstrumental\b/iu;
/** 非原唱演绎版本标记：无人声版本 + 现场 / 不插电 / demo 等演绎形态。 */
const NON_ORIGINAL_VERSION_PATTERN = new RegExp(
  `${NO_VOCAL_VERSION_PATTERN.source}|live|现场|現場|演唱会|演唱會|acoustic|不插电|不插電|demo|试听|試聽`,
  "iu",
);
/**
 * 台词 / 广播剧音轨标记。这类「曲目」里没有人唱歌，放进题面等于放一段对白，
 * 玩家根本无从猜起。实测事故：Bangumi 把《サイコパス2 第5巻 特典CD》与
 * 《コードギアス…Sound Episode 1》挂成关联曲目，而网易云对应专辑里排在前面的
 * 正是「ドラマ」「短編ドラマ…」这类台词轨，曲名门禁靠「专辑名 == 条目名」放行。
 * 注意「ドラマチック / ドラマティック」（dramatic）是正常曲名，必须排除。
 */
const DRAMA_TRACK_PATTERN =
  /ドラマ(?!チック|ティック|ツルギー)|sound\s*drama|voice\s*drama|\bdrama\s*(?:cd|part|track)\b|ミニドラマ|ボイスドラマ|短編ドラマ|台詞|セリフ/iu;
/**
 * 器乐改编 / 二次演奏标记：管弦、交响、钢琴、八音盒等。它们与原唱原版
 * 完全不是同一次录音，即使曲名一模一样也必须排在原版之后。
 *
 * 实测事故：网易云检索《君の名は。》时，帝玖管弦乐团的《交响组曲「君の名は。」》
 * 因曲名包含番剧原名而通过门禁，并以「原声带」身份出现在结算卡片上。
 */
const INSTRUMENTAL_ARRANGEMENT_PATTERN =
  /交响|交響|管弦|オーケストラ|\borchestra\b|吹奏楽|吹奏乐|弦乐|弦樂|钢琴|鋼琴|ピアノ|\bpiano\b|八音盒|音乐盒|音樂盒|オルゴール|music\s*box|演奏|器乐版|純器樂|instrumental|アレンジ|\barra[gn]\w*|改编|改編|アコースティック/iu;
/**
 * 非原唱标记与其降权分。命中即降权，但**只在 Bangumi 曲目自身没有该标记时生效**：
 * 题面本身就是 Cover / Arrange / Remix 版本时，不该把候选都当成「非原版」罚一遍
 * （否则该曲目所有候选一起被降权，等于随机）。
 */
const NON_ORIGINAL_MARKERS: ReadonlyArray<readonly [RegExp, number]> = [
  [COVER_MARKER_PATTERN, 5],
  [NON_ORIGINAL_VERSION_PATTERN, 4],
  [INSTRUMENTAL_ARRANGEMENT_PATTERN, 5],
];

const songTitleSimilarity = (candidateTitle: string, expectedTitle: string): number => {
  const normCandidate = normalizeSongTitle(candidateTitle);
  const normExpected = normalizeSongTitle(expectedTitle);
  if (!normCandidate || !normExpected) return 0;
  if (normCandidate === normExpected) return 2;
  // 候选名只是「长条目名里的一小截」时不给分 —— 必须复用 `isSongTitleMatch` 的截断门槛。
  // 实测事故：Bangumi 把《TVアニメ Free! キャラクターソング・デュエットシングル Vol.1》
  // 挂成关联曲目，网易云在「Free! + 角色歌」的检索里召回了毫不相关的外文歌
  // 《Free》(Bling047)：它靠「被包含」拿到 1 分，再靠「番剧上下文命中」凑够证据出了题。
  // `isSongTitleMatch` 早就有这道门槛，而准入判定走的是本函数 —— 两处口径必须一致。
  if (
    normExpected.includes(normCandidate)
    && (normCandidate.length < MIN_TRUNCATED_TITLE_LENGTH
      || normCandidate.length / normExpected.length < MIN_TRUNCATED_TITLE_RATIO)
  ) {
    // 双 A 面单曲例外：条目名拆段后整段完全一致仍是同一首（见 isSongTitleMatch）。
    const expectedSegments = splitTitleSegments(expectedTitle);
    if (expectedSegments.length > 1) {
      const candidateSegments = new Set(splitTitleSegments(candidateTitle));
      if (expectedSegments.some((segment) => segment.length >= 2 && candidateSegments.has(segment))) {
        return 1;
      }
    }
    return 0;
  }
  return normCandidate.includes(normExpected) || normExpected.includes(normCandidate) ? 1 : 0;
};

/**
 * 候选歌曲的专辑名与 Bangumi 曲目名完全一致（规范化后）时，视为「原版发行」特征。
 *
 * 为什么必须认这个特征：
 * 1. **单曲版原版**：原唱原版通常发行在同名单曲/专辑里（YOASOBI《勇者》的专辑名
 *    就是《勇者》），而同名翻唱挂在《勇者-葬送的芙莉莲OP》这类自建合辑下。两者曲名
 *    完全相同（相似度并列）时，专辑名是否命中是唯一能区分原版的免费信号。
 * 2. **整张原声带条目**：Bangumi 会把动画原声带整张专辑挂成一条关联曲目
 *    （曲目名 = 专辑名，如《君の名は。》），此时按曲名检索只能召回同名翻奏
 *    （《交响组曲「君の名は。」》），官方原声带里真正的曲目（前前前世 / スパークル…）
 *    只有专辑名能命中。允许专辑名命中，才能让官方原版进入候选池。
 */
export const isSongAlbumMatch = (
  candidateAlbum: string | undefined,
  expectedTitle: string,
): boolean => {
  if (!candidateAlbum) return false;
  const normalizedAlbum = normalizeSongTitle(candidateAlbum);
  const normalizedTitle = normalizeSongTitle(expectedTitle);
  return Boolean(normalizedAlbum) && normalizedAlbum === normalizedTitle;
};

/**
 * 候选是否与 Bangumi 曲目相关：曲名命中，或专辑名与原曲目名完全一致。
 * 比 isSongTitleMatch 宽松一档，专供关联曲目解析使用（结算展示与手动猜歌门禁
 * 仍走严格曲名判定）。
 */
export const isSongCandidateMatch = (
  candidate: SongSearchResult,
  expectedTitle: string,
): boolean =>
  isSongTitleMatch(candidate.title, expectedTitle) || isSongAlbumMatch(candidate.album, expectedTitle);

/** 歌手名是否与 Bangumi 记录有交集，无记录时返回 undefined（不参与加减分）。 */
const artistOverlap = (candidate: SongSearchResult, track: BangumiMusicTrack): boolean | undefined => {
  const trackArtists = track.artist ? normalizedArtists(track.artist) : new Set<string>();
  if (trackArtists.size === 0) return undefined;
  const candidateArtists = normalizedArtists(candidate.artist);
  return [...trackArtists].some((artist) => candidateArtists.has(artist));
};

/**
 * 候选出现在「曲名 + 番剧名 / 中文名」检索结果里的加分。
 *
 * 取 3 是针对实测的错配场景定的：别人家的同名原创常拿满「曲名 + 专辑名」4 分，
 * 而番剧原版的专辑名多为「番剧名 - 曲名」这类形态、只拿曲名 2 分；加 3 后原版 5 分
 * 反超，同时又不会盖过「歌手与 Bangumi 记录有交集 +4」这条更硬的证据。
 */
const ANIME_SCOPED_BONUS = 3;

/**
 * 「非音乐」曲目 kind：条目本身是广播剧 / 电台 / 朗读，走专辑路径会把分轨对白当歌出题。
 *
 * 其余 kind 一律允许专辑兜底（**黑名单制**，不是白名单）：实测看似「单曲型」的
 * `opening` / `ending` 条目里同样塞着整张角色歌 CD
 * （《B-PROJECT～絶頂＊エモーション～ キャラクターソングCD 2》、
 * 《TVアニメ「恋する天使アンジェリーク」キャラクターソング VOL.19》），
 * 按白名单把它们排除掉，这些条目就永远零候选 —— 第一版白名单正是这么错的。
 *
 * 「单曲名撞上别人同名专辑」的风险由两道闸门压住：① 只在常规检索**完全无候选**时
 * 才走这条路；② 专辑名必须与条目名对得上（`isAlbumNameMatch`，全等或互相包含）。
 */
const NON_MUSIC_TRACK_KINDS: ReadonlySet<BangumiMusicTrackKind> = new Set<BangumiMusicTrackKind>([
  "drama",
  "radio",
  "reading",
]);

export const isAlbumLikeTrackKind = (kind: BangumiMusicTrackKind): boolean => !NON_MUSIC_TRACK_KINDS.has(kind);

/** 专辑检索取回的候选专辑数。 */
const ALBUM_SEARCH_LIMIT = 10;

/**
 * 专辑名里的通用词：不承载「这是哪部作品」的信息，不能作为匹配依据。
 * 判重时必须先剔除，否则同系列的两张专辑（《X 角色歌集》与《Y 角色歌集》）会因为
 * 共享「角色歌集」而被判成同一张。
 */
const ALBUM_GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "tv", "tvアニメ", "アニメ", "アニメーション", "剧场版", "劇場版", "映画", "ova", "oad",
  "character", "キャラクター", "キャラクターソング", "キャラソン", "角色歌", "角色曲",
  "soundtrack", "サウンドトラック", "オリジナルサウンドトラック", "ost", "原声", "原声带", "原声集",
  "album", "アルバム", "mini", "ミニアルバム", "collection", "コレクション", "best", "ベスト",
  "song", "songs", "ソング", "ソングス", "music", "ミュージック", "vocal", "ボーカル",
  "theme", "テーマ", "主题歌", "主題歌", "opening", "ending", "オープニング", "エンディング",
  "vol", "シリーズ", "series", "disc", "cd", "特典", "初回", "限定", "盤", "编", "篇",
]);

/** 把名称拆成有区分度的词元（归一化 → 按分隔符切分 → 去通用词、纯数字与单字）。 */
const albumNameTokens = (value: string): string[] =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .split(/[\s/／・,，、＆&+＋\-–—_:：'"'"'"'"「」『』【】()（）[\]]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !/^\d+$/u.test(token) && !ALBUM_GENERIC_TOKENS.has(token));

/** 名称里的数字词元（归一化去掉前导零）：专辑系列号靠它区分。 */
const nameDigits = (value: string): Set<string> =>
  new Set((value.normalize("NFKC").match(/\d+/gu) ?? []).map((digits) => String(Number(digits))));

/**
 * 专辑名与条目名的相似度分（0 表示不是同一张专辑）。
 *
 * 为什么不能只用「全等 / 包含」：网易云的专辑名与 Bangumi 条目名经常对不齐 ——
 * 条目《TVアニメ『ひみつのアイプリ』キャラクターソングミニアルバム VERSE IN SONG 03》
 * 在网易云叫《TVアニメ『ひみつのアイプリ リング編』VERSEIN SONG 03》（少了
 * 「キャラクターソングミニアルバム」、多了「リング編」、「VERSEIN」还没空格）。
 * 只用全等/包含会把这类**真的同一张专辑**全部判死，条目永远零候选。
 *
 * 分档：
 * - 100：归一化后全等（最稳）；
 * - 60：互相包含且短名 ≥ 4 字符（原有的宽松档）；
 * - 10+：专辑名含**番剧名**（任一形态）**且**与条目名共享一个 ≥ 4 字符的特征词元
 *   ——「作品名 + 特征词」双命中才认，单靠共享「角色歌集」这类通用词不算（已剔除）；
 *   同系列专辑只差一个序号，因此**数字词元命中额外 +20**，避免抽到隔壁那张
 *   （VERSE IN SONG **02** 与 **03** 的差别全在序号上）。
 */
export const albumNameScore = (
  albumName: string,
  trackTitle: string,
  animeNames: readonly string[] = [],
): number => {
  const normalizedAlbum = normalizeSongTitle(albumName);
  const normalizedTitle = normalizeSongTitle(trackTitle);
  if (!normalizedAlbum || !normalizedTitle) return 0;
  if (normalizedAlbum === normalizedTitle) return 100;
  const shorter = normalizedAlbum.length <= normalizedTitle.length ? normalizedAlbum : normalizedTitle;
  const longer = shorter === normalizedAlbum ? normalizedTitle : normalizedAlbum;
  if (shorter.length >= 4 && longer.includes(shorter)) return 60;

  const albumTokens = new Set(albumNameTokens(albumName));
  const shared = albumNameTokens(trackTitle).filter((token) => albumTokens.has(token));
  if (!shared.some((token) => token.length >= 4)) return 0;
  const hasAnimeName = animeNames
    .filter(Boolean)
    .some((name) => {
      const normalizedName = normalizeSongTitle(name);
      return Boolean(normalizedName) && normalizedAlbum.includes(normalizedName);
    });
  if (!hasAnimeName) return 0;

  const albumDigits = nameDigits(albumName);
  const digitHit = [...nameDigits(trackTitle)].some((digits) => albumDigits.has(digits)) ? 20 : 0;
  return 10 + shared.length * 5 + digitHit;
};

/**
 * 专辑名与条目名是否指向同一张专辑（`albumNameScore` 的布尔形态）。
 * 判定细节见 `albumNameScore`，保留这个包装是为了让调用点读起来仍是「是否匹配」。
 */
export const isAlbumNameMatch = (
  albumName: string,
  trackTitle: string,
  animeNames: readonly string[] = [],
): boolean => albumNameScore(albumName, trackTitle, animeNames) > 0;

/**
 * 歌手名作为检索词的长度上限。
 *
 * Bangumi 的 `artist` 常是整串声优列表（角色歌专辑条目动辄列七八个人名），
 * 拼进检索词后网易云什么都搜不到 —— 超过这个长度就只用番剧名去搜。
 * （补录 artist 之后才暴露：旧库全为 NULL，等于一直在走番剧名那条路。）
 */
const MAX_ARTIST_QUERY_LENGTH = 32;

/**
 * 专辑型条目的类型关键词：用于拼「番剧名 + 角色曲」这类检索词。
 */
const ALBUM_KIND_KEYWORDS: readonly string[] = [
  "キャラクターソング",
  "キャラソン",
  "オリジナルサウンドトラック",
  "サウンドトラック",
  "オープニングテーマ",
  "エンディングテーマ",
  "主題歌",
  "テーマソング",
  "ボーカルアルバム",
  "イメージアルバム",
  "ミュージックコレクション",
  "ソングコレクション",
  "ドラマ",
  "ベスト",
];

/** 去掉「TVアニメ『番剧名』」「アニメ「番剧名」」这类包裹，只留专辑自身的名字。 */
const stripAnimeWrapper = (title: string, animeNames: readonly string[]): string => {
  let result = title;
  for (const name of animeNames) {
    if (!name) continue;
    for (const wrapper of [
      `TVアニメ『${name}』`, `TVアニメ「${name}」`, `アニメ『${name}』`, `アニメ「${name}」`,
      `TVアニメ ${name}`, `TV动画《${name}》`, `动画《${name}》`, `『${name}』`, `「${name}」`,
    ]) {
      result = result.split(wrapper).join(" ");
    }
  }
  return result
    .replace(/^(?:TVアニメ|TV动画|アニメ|劇場版|映画)\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
};

/**
 * 专辑型条目的检索词序列（按优先级）。
 *
 * 只用条目名检索是不够的 —— Bangumi 条目名与网易云的命名差得很远，实测：
 * - 《TVアニメ『ひみつのアイプリ』キャラクターソングミニアルバム VERSE IN SONG 03》
 *   按条目名搜专辑返回 **0 张**，换成番剧名「ひみつのアイプリ」立刻搜到同系列专辑；
 * - 《「クラスターエッジ」キャラクターコレクション》连番剧的日文片假名都搜不到，
 *   而番剧的**原名** `CLUSTER EDGE` 能搜出该番的《ココロのつぼみ》《FLY HIGH》。
 *
 * 因此按「条目名 → 剥掉番剧名包裹后的余部 → 番剧名 + 类型关键词 → 番剧名」逐级放宽。
 */
export const buildAlbumQueries = (track: BangumiMusicTrack, anime: BangumiSubjectDetails): string[] => {
  const animeNames = [anime.name, anime.nameCn].filter((name): name is string => Boolean(name));
  const queries: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !queries.includes(trimmed)) queries.push(trimmed);
  };
  push(track.title);
  push(stripAnimeWrapper(track.title, animeNames));
  const kindKeyword = ALBUM_KIND_KEYWORDS.find((keyword) => track.title.includes(keyword));
  if (kindKeyword) {
    for (const name of animeNames) push(`${name} ${kindKeyword}`);
  }
  for (const name of animeNames) push(name);
  return queries;
};

/**
 * 上游偶发失败时重试一次。
 *
 * **只重试瞬态失败**：限流（`MUSIC_API_RATE_LIMITED`）与队列拥塞（`MUSIC_API_BUSY`）下
 * 立即重试只会再撞一次冷却，直接放弃让上层换下一首。
 * 实测小众番剧抽样里 25 条无候选中有 8 条是专辑检索抛错造成的，重试能把大部分救回来。
 */
const ALBUM_RETRY_DELAY_MS = 1_200;
const retryOnce = async <T>(task: () => Promise<T>): Promise<T> => {
  try {
    return await task();
  } catch (error) {
    const code = error instanceof AppError ? error.code : "";
    if (code === "MUSIC_API_RATE_LIMITED" || code === "MUSIC_API_BUSY") throw error;
    await new Promise((resolve) => setTimeout(resolve, ALBUM_RETRY_DELAY_MS));
    return task();
  }
};

/**
 * 专辑路径取回的曲目里要直接剔除的非歌形态：伴奏 / 纯音乐 / 现场 / 翻唱 / 台词。
 * 专辑（尤其 OST 与角色歌合辑）通常把 off vocal 版一并收录，它们不是可出的原曲。
 */
export const isUnplayableAlbumTrack = (title: string): boolean =>
  NON_ORIGINAL_VERSION_PATTERN.test(title)
  || COVER_MARKER_PATTERN.test(title)
  || INSTRUMENTAL_ARRANGEMENT_PATTERN.test(title)
  || DRAMA_TRACK_PATTERN.test(title);

/**
 * 该曲名是否属于**根本没有歌声**的音轨（台词轨 / 伴奏 / 纯音乐 / 卡拉 OK）。
 *
 * 与 `isUnplayableAlbumTrack` 的区别：后者只在专辑路径做「选哪首」的粗筛，
 * 且包含的现场 / 不插电 / demo / 器乐改编等标记只是**版本不同**，仍有人声、
 * 仍可出题（所以 `scoreAnimeSongCandidate` 只降权不剔除）。这里只认
 * 「放出来玩家无从猜起」的硬缺陷，必须在**所有路径**的验证阶段一律否决。
 */
export const isNonVocalTrack = (title: string): boolean =>
  DRAMA_TRACK_PATTERN.test(title) || NO_VOCAL_VERSION_PATTERN.test(title);

/**
 * 为网易云候选歌曲打「原版优先」分，分数越高越接近 Bangumi 记录的原唱版本。
 * resolveAnimeSong 会按此分数降序取首个可播放歌曲，从而在翻唱、器乐改编、伴奏等
 * 版本混排时优先选中原版，避免「原版存在却抽到翻唱」。
 */
/**
 * 候选是否具备「就是这首歌」的准入证据。
 *
 * 只回答一个问题：**这个候选有没有资格作为「Bangumi 记录的那首歌」进入验证队列？**
 * 判定刻意与分数解耦 —— 两者回答的不是同一件事：准入看身份（是不是这首歌），
 * 排序（`scoreAnimeSongCandidate`）看版本（是不是原版）。
 *
 * 规则：
 * 1. 曲名完全一致 → 有资格。此时**不看歌手**：翻唱常把曲名照抄（靠 `originCoverType`
 *    在验证阶段让位），Bangumi 与网易云的歌手写法差异也常导致交集为空，用歌手否掉
 *    会让真正的原版连被验证的机会都没有；
 * 2. 专辑名与原曲目名完全一致 → 有资格（即使曲名完全对不上）：Bangumi 会把**整张原声带**
 *    挂成一条关联曲目，此时条目名就是专辑名，官方曲目与条目名毫无文字交集。实测事故是
 *    帝玖管弦乐团的《交响组曲「君の名は。」》靠曲名命中顶掉了官方原声带；
 * 3. 曲名只部分命中 → 必须另有独立证据（歌手交集 / 番剧上下文命中）；
 * 4. 其余情况（曲名完全对不上、专辑名也对不上）→ 无资格；
 * 5. 非原唱标记的降权**不参与**准入：唯一候选是翻唱 / 改编时仍要能降级出题
 *    （既有语义「仅能召回翻唱版时仍可出题」），否则会退化成「该番剧没有可播放的关联歌曲」。
 *
 * 被第 3 条挡掉的正是实测的错配事故：《いつだってYELL》（忍者乱太郎 ED）被 2026 年
 * 无关的《Yell》顶掉、《ぼくらは小さな悪魔》被《ぼくら》顶掉，两者都只靠曲名部分命中
 * 就出了题。宁可这一首出不了题（上层会换下一首），也不能让玩家听到一首无关的歌。
 */
export const hasAnimeSongEvidence = (
  candidate: SongSearchResult,
  track: BangumiMusicTrack,
  options: { animeScoped?: boolean } = {},
): boolean => {
  const titleScore = songTitleSimilarity(candidate.title, track.title);
  if (titleScore >= 2) return true;
  // 专辑名与原曲目名完全一致（见规则 2）。
  if (isSongAlbumMatch(candidate.album, track.title)) return true;
  if (titleScore < 1) return false;
  return artistOverlap(candidate, track) === true || Boolean(options.animeScoped);
};

/**
 * 为网易云候选歌曲打「原版优先」分，分数越高越接近 Bangumi 记录的原唱版本。
 * resolveAnimeSong 会按此分数降序取首个可播放歌曲，从而在翻唱、器乐改编、伴奏等
 * 版本混排时优先选中原版，避免「原版存在却抽到翻唱」。
 */
export const scoreAnimeSongCandidate = (
  candidate: SongSearchResult,
  track: BangumiMusicTrack,
  options: { animeScoped?: boolean } = {},
): number => {
  let score = songTitleSimilarity(candidate.title, track.title);
  if (isSongAlbumMatch(candidate.album, track.title)) score += 2;
  const overlap = artistOverlap(candidate, track);
  if (overlap !== undefined) score += overlap ? 4 : -3;
  const descriptiveText = `${candidate.title} ${candidate.album ?? ""}`;
  const expectedText = `${track.title} ${track.artist ?? ""}`;
  for (const [pattern, weight] of NON_ORIGINAL_MARKERS) {
    if (pattern.test(descriptiveText) && !pattern.test(expectedText)) score -= weight;
  }
  // 番剧上下文命中：候选出现在「曲名 + 番剧名/中文名」的检索结果里，是该曲目确实
  // 属于这部番的强证据。**同名不同曲**（实测《拜托了老师》2002 的 OP 被 2023 年 XG
  // 的同名《SHOOTING STAR》顶掉）里，别人家的同名原创只会在裸曲名检索里出现，
  // 而原版总跟着番剧名一起被召回 —— 这一条正是把两者区分开的免费信号。
  if (options.animeScoped) score += ANIME_SCOPED_BONUS;
  return score;
};

const FALLBACK_CLIP_SECONDS_PER_LINE = 6;
const MAX_LYRIC_LINE_DURATION_MS = 12_000;
/**
 * 歌词片段相邻两句之间的最大间奏间隔。
 *
 * 如果相邻两句歌词之间的时间跨度超过此阈值，说明歌曲进入了较长的吉他/管弦等乐器间奏（如《一样的月光》中间 54 秒间奏），
 * 绝不能把分属两段演唱的歌词跨越长间奏拼接为一个出题窗口，否则会导致玩家在数十秒死寂中等待。
 */
export const MAX_LYRIC_INTERLUDE_GAP_MS = 6_000;
/**
 * 歌词窗口收缩下限。
 *
 * 单行歌词不足以出题（相邻两句的上下文才算一个可猜片段），因此设定行数
 * 高于 2 时，窗口不允许收缩到 2 行以下；设定 1 行时按用户意愿保留 1 行窗口。
 */
const MIN_LYRIC_WINDOW_LINES = 2;
const AUTO_POPULARITY_LOOKUP_LIMIT = 24;
/**
 * 自动出题时最多尝试的番剧候选数。
 * 每个候选都要完整跑一遍关联歌曲解析，不设上界时单次出题可能退化成几十次串行回源。
 */
export const AUTO_ANIME_CANDIDATE_LIMIT = 5;
/**
 * 自动出题时最多尝试的歌曲候选数，语义与 `AUTO_ANIME_CANDIDATE_LIMIT` 对齐。
 *
 * 歌曲分支此前是裸 `while (pool.length > 0)`：大歌单且多为会员曲时，
 * `continue` 会让循环一路串行回源到池子见底（每次回源约 5~6 个上游请求），
 * 期间 `automaticRoundLoading` 长占，客户端对该命令发的是 `timeout: 0`，
 * 房主 UI 会长时间卡在「出题中」且没有任何超时提示。
 */
export const AUTO_SONG_CANDIDATE_LIMIT = 5;
/**
 * 「最近不出」窗口相对候选池的目标占比。
 *
 * 固定的 10 首窗口在池子远大于 10 时几乎不消耗池子容量：1000 首的歌单
 * 仍然从第 12 轮起就允许重现已出过的歌。窗口按池子线性放长后，
 * 「不重复」才真正用满池子容量 —— 池 990 时前 495 轮都不会出现旧歌。
 */
const RECENT_SONG_WINDOW_RATIO = 0.5;
/**
 * 「最近不出」窗口下限。
 *
 * 小池子本来就装不满窗口（池 15 时 10 首已占三分之二），继续缩短只会让
 * 旧歌更早回来；而池子耗尽后总重复次数只由轮数决定、与窗口长度无关，
 * 因此小池子保留原有的 10 首行为不变。
 */
const MIN_RECENT_SONG_WINDOW = 10;
/**
 * 「最近不出」窗口上限。房间是纯内存态，需要给窗口一个与池子无关的上界，
 * 避免超大歌单把每个房间的最近列表撑成任意长度。
 */
const MAX_RECENT_SONG_WINDOW = 500;

/**
 * 按候选池规模计算「最近不出」窗口长度。
 *
 * 池子不超过 20 首时恒为 `MIN_RECENT_SONG_WINDOW`（等价于改动前的固定 10 首）；
 * 更大池子按 `RECENT_SONG_WINDOW_RATIO` 放长，并在 `MAX_RECENT_SONG_WINDOW` 处截断。
 */
export const resolveRecentSongWindow = (poolSize: number): number => {
  if (!Number.isFinite(poolSize) || poolSize <= 0) return MIN_RECENT_SONG_WINDOW;
  const adaptive = Math.floor(poolSize * RECENT_SONG_WINDOW_RATIO);
  return Math.max(MIN_RECENT_SONG_WINDOW, Math.min(MAX_RECENT_SONG_WINDOW, adaptive));
};
/**
 * 候选级取歌失败：这一首当前拿不到可用播放地址（下架、无版权、解灰全部失败），
 * 换一个候选即可，不代表整轮无法出题。
 *
 * 只吞「单曲不可用」这两种码。限流（`MUSIC_API_RATE_LIMITED`）与接口整体不可用
 * （`MUSIC_API_UNAVAILABLE`）必须原样抛出：前者在冷却期里继续抽候选只会空转，
 * 后者说明整条链路坏了，重试没有任何意义。
 */
const isUnusableSongCandidate = (error: unknown): boolean =>
  error instanceof AppError
  && (error.code === "SONG_UNAVAILABLE" || error.code === "SONG_NOT_FOUND");
/**
 * 单条连接在一分钟内允许的「客户端可触发」音乐类命令次数。
 *
 * 只卡命令入口，不卡出题解析器内部的上游调用：后者只由房主的
 * `song.game.start` / `nextRound` 间接触发，不是滥用面。
 */
const MUSIC_RATE_LIMIT_PER_CONNECTION = 20;
const MUSIC_RATE_LIMIT_WINDOW_MS = 60_000;

/** 聊天：每秒 2 条、突发 5 条。 */
const CHAT_RATE_LIMIT_PER_CONNECTION = 5;
const CHAT_RATE_LIMIT_WINDOW_MS = 2_500;

/** 房间因空闲被关闭前的预警提前量。 */
const ROOM_EXPIRING_WARNING_MS = 60_000;

/** 音频就绪宽限期：超时仅强制置为可答题并启动倒计时，绝不扣减猜测配额。 */
const AUDIO_READY_GRACE_MS = 15_000;
/** 回合硬截止相对单次答题时长的裕量，用于兜住卡死的上游请求。 */
const ROUND_HARD_TIMEOUT_MARGIN_S = 20;
/**
 * 单次番剧歌曲解析允许发起的上游搜索次数（一次搜索只对应一个上游请求，成本最低）。
 */
export const ANIME_SONG_SEARCH_BUDGET = 24;
/**
 * 单次番剧歌曲解析允许回源验证的候选歌曲数量。
 *
 * 每次验证都要拉取完整歌曲详情（详情 + 百科 + 热度 + 歌词 + 音频，约 5~6 个上游请求），
 * 成本是一次搜索的六倍以上，必须与搜索预算分开设上限。只用单一预算计数时
 * `getSong` 被按「一次调用」记账，单次出题会退化到数百个上游请求（实测最坏 60s+，
 * 前端按钮动画都等超时了，后端其实还在选曲）。
 */
export const ANIME_SONG_DETAIL_BUDGET = 6;
/** 同一曲目内最多验证的候选版本数（按原版优先排序后从前到后）。 */
export const ANIME_TRACK_DETAIL_ATTEMPTS = 3;
/** 单次番剧歌曲解析最多处理的关联曲目数（超出部分在随机洗牌后等概率落选）。 */
const ANIME_TRACK_LOOKUP_LIMIT = 24;
/** 关联曲目检索每次取回的结果数：过小会漏掉原版，过大只是白解析。 */
const ANIME_SONG_SEARCH_LIMIT = 24;
/**
 * 候选歌曲发行年与番剧首播年的最大允许偏差（年）。
 *
 * 番剧的 OP/ED 通常与番剧同年、或前后一两年发行；而**同名不同曲**的错配往往差
 * 十几二十年。实测 TV 动画《拜托了老师》(2002) 的 OP `Shooting Star` 被 2023 年
 * XG 的同名《SHOOTING STAR》顶掉 —— 两者曲名与专辑名完全相同、打分并列（各 4 分），
 * 热门新歌靠检索顺序胜出，玩家听到的是一首完全无关的歌。
 *
 * 取 10 是刻意宽松的上界：既挡住跨代错配，又保留「若干年后的纪念盘/精选集」这类
 * 同一首歌的合法再版（实测 KOTOKO 的 2012 特典盘与 2002 原版是同一录音，偏差正好
 * 10 年，用 `>` 判定因此不会被误杀）。
 */
export const MAX_RELEASE_YEAR_DRIFT = 10;

/**
 * 候选歌曲是否与番剧年份错配 —— 同名不同曲的判据。
 *
 * 发行年只在歌曲详情里返回，所以这条判定只能发生在候选验证阶段，进不了检索阶段的
 * 排序（详见 `resolveAnimeSong` 的验证循环）。任一端年份缺失时一律放行，不拿未知当否定。
 */
export const isReleaseYearOffTarget = (
  releaseYear: number | undefined,
  animeYear: number | undefined,
): boolean => {
  if (releaseYear === undefined || animeYear === undefined) return false;
  return Math.abs(releaseYear - animeYear) > MAX_RELEASE_YEAR_DRIFT;
};

const direction = (guess?: number, answer?: number): SongGuessDirection => {
  if (guess === undefined || answer === undefined) return "unknown";
  if (guess === answer) return "equal";
  return guess < answer ? "higher" : "lower";
};

export const createSongLyricClip = (
  lyrics: SongDetails["lyrics"],
  lineCount: number,
  random: RandomSource,
  durationMs?: number,
): SongLyricClip => {
  const safeCount = clampInt(lineCount, 1, 10);
  const isCompactLine = (line: SongDetails["lyrics"][number]) =>
    line.endTime > line.time && line.endTime - line.time <= MAX_LYRIC_LINE_DURATION_MS;

  const isContinuousWindow = (lines: SongDetails["lyrics"]) => {
    if (!lines.every(isCompactLine)) return false;
    for (let i = 1; i < lines.length; i++) {
      const gap = lines[i].time - lines[i - 1].endTime;
      if (gap > MAX_LYRIC_INTERLUDE_GAP_MS) return false;
    }
    return true;
  };

  // 1. 区分主歌词与和声/背景歌词（isBG）。
  // 选词滑动窗口仅以主歌词为候选基准，禁止和声歌词作为出题开头或充抵出题行数，
  // 避免和声小字过早切断主歌词音频。
  const mainLyrics = lyrics.filter((line) => !line.isBG);
  const candidatePool = mainLyrics.length >= Math.min(MIN_LYRIC_WINDOW_LINES, safeCount)
    ? mainLyrics
    : lyrics;

  for (let count = safeCount; count >= Math.min(MIN_LYRIC_WINDOW_LINES, safeCount); count -= 1) {
    if (candidatePool.length < count) continue;
    const windows = Array.from({ length: candidatePool.length - count + 1 }, (_, startIndex) =>
      candidatePool.slice(startIndex, startIndex + count))
      .filter(isContinuousWindow);
    if (windows.length === 0) continue;

    const padded = windows.length >= 5 ? windows.slice(2, -2) : windows;
    const candidates = padded.length > 0 ? padded : windows;
    const selectedMainLines = candidates[random.nextInt(candidates.length)];

    const windowStartTime = selectedMainLines[0].time;
    const windowEndTime = selectedMainLines.at(-1)!.endTime;

    // 从完整歌词中提取出落在该出题区间内的所有歌词（包含和声歌词），仅用于播放时演出
    const clipLines = lyrics.filter(
      (line) => line.time >= windowStartTime && line.time < windowEndTime,
    );
    const mergedLines = clipLines.length > 0 ? clipLines : selectedMainLines;
    mergedLines.sort((a, b) => a.time - b.time);

    const maxLineEnd = Math.max(windowEndTime, ...mergedLines.map((l) => l.endTime));
    // 选区前后各预留 1 秒缓冲空间供音频平滑渐入渐出演出
    const clipStartTime = Math.max(0, windowStartTime - 1_000);
    const maxAllowedEnd = durationMs !== undefined ? durationMs : (maxLineEnd + 1_000);
    const clipEndTime = Math.min(maxAllowedEnd, maxLineEnd + 1_000);

    return {
      startTime: clipStartTime,
      endTime: clipEndTime,
      lines: mergedLines,
    };
  }

  const clipDuration = safeCount * FALLBACK_CLIP_SECONDS_PER_LINE * 1_000;
  const songDuration = Math.max(1, durationMs ?? clipDuration);
  const actualClipDuration = Math.min(clipDuration, songDuration);
  const latestStart = Math.max(0, songDuration - actualClipDuration);
  const startTime = random.nextInt(latestStart + 1);

  return {
    startTime,
    endTime: startTime + actualClipDuration,
    lines: [],
  };
};

export class SonGuessrService {
  private readonly rooms = new Map<string, SonGuessrRoomRecord>();
  private readonly connections = new ConnectionRegistry();
  private readonly now: () => number;
  private readonly random: RandomSource;
  private idCounter = 0;
  /**
   * 按连接统计的音乐上游调用配额。
   *
   * `NeteaseMusicProvider` 是全进程单例（并发 3 / 队列 64 / 触发限流后冷却 60s→600s），
   * 没有按连接的配额时，一个人打满队列会让上游返回 405 并进入全局冷却，
   * 结果是全服所有房间在这段时间里搜歌、出题一起报错。
   */
  private readonly musicLimiter = new SlidingWindowRateLimiter({
    windowMs: MUSIC_RATE_LIMIT_WINDOW_MS,
    maxRequests: MUSIC_RATE_LIMIT_PER_CONNECTION,
  });
  /**
   * 加入私密房间的密码尝试配额（按「连接 + 房间」计数）。
   * 房间号只有 9000 个且私密房带锁出现在大厅，不设限流就能一直试。
   */
  private readonly joinPasswordLimiter = new SlidingWindowRateLimiter({
    windowMs: JOIN_PASSWORD_WINDOW_MS,
    maxRequests: JOIN_PASSWORD_MAX_ATTEMPTS,
  });
  /** 聊天频率配额：每条聊天都会触发全房广播，不限流等于放大 DoS。 */
  private readonly chatLimiter = new SlidingWindowRateLimiter({
    windowMs: CHAT_RATE_LIMIT_WINDOW_MS,
    maxRequests: CHAT_RATE_LIMIT_PER_CONNECTION,
  });

  constructor(private readonly options: SonGuessrServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? {
      nextInt: (maxExclusive) => Math.floor(Math.random() * Math.max(1, maxExclusive)),
    };
  }

  registerConnection(connection: ConnectionRecord): void {
    this.connections.registerConnection(connection);
  }

  getHealthSnapshot() {
    return {
      roomCount: this.rooms.size,
      connectionCount: this.connections.stats.totalConnections,
      onlinePlayerCount: [...this.rooms.values()].reduce(
        (sum, room) => sum + this.onlineCount(room),
        0,
      ),
    };
  }

  notifyShutdown(): void {
    this.connections.broadcastToAll(
      createEvent("server.shutdown", {
        message: SERVER_SHUTDOWN_MESSAGE,
      }),
    );
  }


  async unregisterConnection(connectionId: string): Promise<void> {
    const connection = this.connections.unregisterConnection(connectionId);
    if (!connection?.roomId || !connection.playerId) return;
    const room = this.rooms.get(connection.roomId);
    const player = room?.players[connection.playerId];
    if (!room || !player) return;

    player.online = false;
    player.connectionId = undefined;
    player.lastSeenAt = this.now();
    this.connections.detach(connection);

    if (this.onlineCount(room) === 0 && !this.isTestRoom(room)) {
      room.emptySinceAt ??= this.now();
    }

    // 0分数的旁观者掉线立即移除
    if (
      player.membership === "spectator" &&
      player.score === 0 &&
      !player.isBot &&
      room.hostPlayerId !== player.id
    ) {
      delete room.players[player.id];
    }

    // 断线不是显式离开：保留房主身份和房间音乐会话，给移动端后台重连留出时间。
    if (room.hostPlayerId === player.id && !this.isTestRoom(room)) {
      room.hostReconnectDeadlineAt = this.now() + HOST_RECONNECT_TIMEOUT_MS;
    }
    if (room.phase === "submittingSong" && room.pendingSubmitterPlayerId === player.id) {
      room.pendingSubmitterPlayerId = undefined;
      room.phase = "choosingSubmitter";
    }

    // 普通断线可能只是刷新或切到后台，不能因此把仍在进行的回合提前结算。
    // 显式离开和踢出会移除正式席位，并在各自路径重新检查回合完成状态。
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    this.log("song.player.disconnected", room.id, player.id);
  }

  async execute(connectionId: string, message: SonGuessrClientMessage): Promise<unknown> {
    const connection = this.connections.getConnection(connectionId);
    // 玩家级伪装 IP 归属：同一连接的匿名请求复用同一个 CN IP，不同玩家各持一个，
    // 避免全服匿名请求共享同一份网易云限流配额（见 NeteaseMusicProvider 的 musicIpScope）。
    return musicIpScope.run(`player:${connectionId}`, async () =>
      this.dispatchCommand(connection, message),
    );
  }

  /**
   * 命令分发表。
   *
   * 独立成方法是为了让整条命令处理链都跑在 `musicIpScope` 请求作用域里：
   * 作用域只能在最外层建立，下游 provider 才可能在任意调用深度读到玩家身份。
   */
  private async dispatchCommand(
    connection: ConnectionRecord,
    message: SonGuessrClientMessage,
  ): Promise<unknown> {
    switch (message.type) {
      case "song.lobby.subscribeRooms":
        connection.lobbySubscribed = true;
        this.publishLobby();
        return { subscribed: true };
      case "song.room.create":
        return this.createRoom(connection, message.payload);
      case "song.room.join":
        return this.joinRoom(connection, message.roomId, message.payload);
      case "song.room.reconnect":
        return this.reconnectRoom(connection, message.payload.roomId, message.payload.sessionToken);
      case "song.room.leave":
        return this.leaveRoom(connection);
      case "song.room.requestSync":
        return this.requestSync(connection);
      case "song.player.setReady":
        return this.setReady(connection, message.payload.ready);
      case "song.player.setSpectator":
        return this.setSpectator(connection, message.payload.spectator);
      case "song.room.updateSettings":
        return this.updateSettings(connection, message.payload);
      case "song.room.kick":
        return this.kick(connection, message.payload.playerId);
      case "song.room.transferHost":
        return this.transferHost(connection, message.payload.playerId);
      case "song.chat.send":
        return this.sendChat(connection, message.payload.text);
      case "song.auth.qr.create":
        return this.createMusicQrLogin(connection);
      case "song.auth.qr.check":
        return this.checkMusicQrLogin(connection, message.payload.key);
      case "song.auth.useCookie":
        return this.useMusicCookie(connection, message.payload.cookie);
      case "song.auth.clear":
        return this.clearMusicAccount(connection);
      case "song.music.search":
        return this.searchMusic(connection, message.payload.keyword);
      case "song.music.playlist.resolve":
        return this.resolvePlaylist(connection, message.payload.value);
      case "song.music.artist.search":
        return this.searchArtists(connection, message.payload.keyword);
      case "song.bangumi.search":
        return this.searchBangumi(connection, message.payload.keyword);
      case "song.bangumi.songs":
        return this.getAnimeSongs(connection, message.payload.subjectId);
      case "song.game.start":
        return this.startGame(connection);
      case "song.game.chooseSubmitter":
        return this.chooseSubmitter(connection, message.payload.playerId);
      case "song.game.submitSong":
        return this.submitSong(connection, message.payload.songId);
      case "song.game.submitAnime":
        return this.submitAnime(connection, message.payload.subjectId, message.payload.songId);
      case "song.game.audioReady":
        return this.audioReady(connection, message.payload.roundNumber);
      case "song.game.audioFailed":
        return this.audioFailed(connection, message.payload.roundNumber);
      case "song.game.guess":
        return this.guess(connection, message.payload.songId);
      case "song.game.guessAnime":
        return this.guessAnime(connection, message.payload.subjectId);
      case "song.game.giveUp":
        return this.giveUp(connection);
      case "song.game.skipRound":
        return this.skipRound(connection);
      case "song.game.nextRound":
        return this.nextRound(connection);
      case "song.game.finish":
        return this.finishGame(connection);
      case "song.test.addBot":
        return this.addBots(connection, message.payload.count);
      case "song.test.removeBot":
        return this.removeBots(connection, message.payload.count);
      default: {
        // 穷尽性断言：协议新增命令类型但这里漏 case 时，下面这行会直接编译失败。
        // 没有它的话漏 case 的后果是「协议校验通过 → ACK 成功 → payload 为空 → 客户端以为命令执行成功」。
        const exhaustiveCheck: never = message;
        void exhaustiveCheck;
        return unsupportedCommand();
      }
    }
  }

  async runHousekeeping(): Promise<void> {
    const currentTime = this.now();
    for (const room of [...this.rooms.values()]) {
      const isEmpty = this.onlineCount(room) === 0;
      const isIdleTimeout = currentTime - room.lastActivityAt >= ROOM_IDLE_TIMEOUT_MS;
      // 测试房间豁免「无人立即回收」——它常态就是一间等人加入的空房；
      // 但仍受空闲超时约束：否则那唯一的房间记录会永久驻留，
      // 加出来的机器人也永远不会被回收，只能靠重启释放。
      if (this.isTestRoom(room) && isEmpty && !isIdleTimeout) continue;
      // 空闲关闭前提前一分钟预警一次：客户端的 `song.room.expiring` 分支
      // 此前是死代码（服务端从来没下发过），玩家只会突然收到「房间已关闭」。
      const idleRemaining = ROOM_IDLE_TIMEOUT_MS - (currentTime - room.lastActivityAt);
      if (!isEmpty && idleRemaining <= ROOM_EXPIRING_WARNING_MS && !room.expiringNotified) {
        room.expiringNotified = true;
        this.broadcastRoomEvent(room, "song.room.expiring", { roomId: room.id, idle: true });
      }

      if (isEmpty || isIdleTimeout) {
        if (isEmpty) {
          room.emptySinceAt ??= currentTime;
          if (currentTime - room.emptySinceAt < ROOM_EMPTY_GRACE_PERIOD_MS) {
            this.publishRoomCalibration(room);
            continue;
          }
        }
        this.closeRoom(room, isEmpty ? "empty" : "idle_timeout");
        continue;
      }
      room.emptySinceAt = undefined;

      // 清理掉线超过3分钟的玩家
      for (const player of Object.values(room.players)) {
        if (
          !player.online &&
          !player.isBot &&
          currentTime - player.lastSeenAt >= PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS
        ) {
          delete room.players[player.id];
          if (room.hostPlayerId === player.id) {
            this.reassignHost(room);
          }
          this.touch(room);
          if (this.onlineCount(room) === 0 && !this.isTestRoom(room)) {
            this.closeRoom(room, "empty");
          } else {
            this.publishRoom(room);
            this.publishLobby();
          }
        }
      }

      if (
        room.hostReconnectDeadlineAt !== undefined &&
        currentTime >= room.hostReconnectDeadlineAt
      ) {
        this.transferHostAfterDisconnect(room);
      }

      if (room.phase === "playing" && room.currentRound) {
        let changed = false;
        const round = room.currentRound;
        const audioReadyDeadlineAt = round.audioReadyDeadlineAt ?? round.audioPreparationDeadlineAt;
        const isRoundHardExpired =
          round.hardDeadlineAt !== undefined && currentTime >= round.hardDeadlineAt;

        for (const [playerId, state] of Object.entries(round.players)) {
          if (
            playerId === round.submitterPlayerId &&
            !this.canTestSubmitterGuess(room, playerId)
          ) {
            continue;
          }
          if (
            state.correct ||
            state.gaveUp ||
            state.guessesUsed >= round.settings.maxGuessesPerRound
          ) {
            continue;
          }
          // 上游正在校验这次猜测（占位已扣、结果未回）：超时由 in-flight 流程自己判定。
          // 巡检在这里抢先记一次 timeout，会让一次真实猜测扣掉两次配额，
          // 并在 attempts 里留下「timeout + wrong/correct」两条互相矛盾的记录。
          // 例外保留：硬超时必须仍然强制结算，否则一次卡死的 in-flight 会拖住整个回合。
          if (state.inFlight && !isRoundHardExpired) {
            continue;
          }

          const isAudioReadyTimeout =
            !state.audioReady &&
            currentTime >= audioReadyDeadlineAt;
          const isGuessTimeout =
            state.deadlineAt !== undefined && state.deadlineAt <= currentTime;

          // 音频就绪宽限期结束仅强制置为就绪并启动答题计时，绝不能当作「答题超时」扣除猜测配额
          if (isAudioReadyTimeout && !state.audioReady) {
            this.armRoundDeadlines(room);
            state.audioReady = true;
            // 宽限期本身就晚于锚点 15 秒，这里的倒计时必须重新起算，
            // 不能再用 audioReadyDeadlineAt —— 那样会立刻得到一个已过期的截止时刻，
            // 下一轮巡检就把补偿出来的答题时间又当成超时收走。
            this.restartGuessDeadline(room, state);
            changed = true;
          }

          if (isGuessTimeout || isRoundHardExpired) {
            this.recordTimeout(room, playerId);
            changed = true;
          }
        }

        if (changed || isRoundHardExpired) {
          if (this.isRoundComplete(room) || isRoundHardExpired) this.finishRound(room);
          this.publishRoom(room);
        }
      }

      this.publishRoomCalibration(room);
    }
  }

  getRoomSummaries(): SonGuessrRoomSummary[] {
    return [...this.rooms.values()]
      .filter((room) => !this.isTestRoom(room) && !room.solo)
      .map((room) => this.buildRoomSummary(room))
      .sort((left, right) => left.roomId.localeCompare(right.roomId));
  }

  private createRoom(
    connection: ConnectionRecord,
    payload: Extract<SonGuessrClientMessage, { type: "song.room.create" }>["payload"],
  ) {
    this.ensureConnectionFree(connection);
    const roomId = ensureRoomId(payload.roomId);
    if (this.rooms.has(roomId)) throw new AppError("ROOM_EXISTS", "房间号已被使用");

    const player = this.createPlayer(payload.userName, true);
    const now = this.now();
    const solo = payload.solo === true;
    const room: SonGuessrRoomRecord = {
      id: roomId,
      name: normalizeWord(payload.name),
      solo,
      visibility: payload.visibility,
      password: payload.visibility === "private" ? this.requirePassword(payload.password) : undefined,
      allowSpectators: solo ? false : payload.allowSpectators,
      hostPlayerId: player.id,
      settings: cloneSettings({
        ...DEFAULT_SETTINGS,
        questionMode: solo ? "automatic" : DEFAULT_SETTINGS.questionMode,
      }),
      phase: "waiting",
      roundNumber: 0,
      players: { [player.id]: player },
      chat: [],
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      recentSongIds: [],
      recentSubjectIds: [],
    };

    this.rooms.set(roomId, room);
    this.attachConnection(room, player, connection);
    this.appendSystemMessage(room, `${player.name} 创建了房间`);
    this.publishRoom(room);
    this.publishLobby();
    this.log("song.room.created", room.id, player.id);
    return {
      roomId,
      playerId: player.id,
      sessionToken: player.sessionToken,
      snapshot: this.buildRoomSnapshot(room),
      privateState: this.buildPrivateState(room, player),
    };
  }

  private joinRoom(
    connection: ConnectionRecord,
    roomIdValue: string | undefined,
    payload: Extract<SonGuessrClientMessage, { type: "song.room.join" }>["payload"],
  ) {
    this.ensureConnectionFree(connection);
    const room = this.getRoom(ensureRoomId(roomIdValue ?? ""));
    if (room.solo) throw new AppError("SOLO_ROOM_FORBIDDEN", "单人房间不接受其他玩家加入");
    this.ensurePassword(room, payload.password, connection);
    const name = this.requireName(payload.userName);
    if (Object.values(room.players).some((player) => player.name === name && player.membership !== "kicked")) {
      throw new AppError("NAME_CONFLICT", "该用户名已在房间中");
    }

    const membership = room.phase === "waiting" ? "active" : "spectator";
    if (membership === "spectator" && !room.allowSpectators) {
      throw new AppError("SPECTATORS_DISABLED", "当前房间不允许旁观");
    }

    const player = this.createPlayer(name, false);
    player.membership = membership;
    room.players[player.id] = player;
    const currentHost = room.players[room.hostPlayerId];
    const hostGraceExpired = room.hostReconnectDeadlineAt === undefined ||
      this.now() >= room.hostReconnectDeadlineAt;
    if (
      !currentHost ||
      currentHost.isBot ||
      currentHost.membership === "kicked" ||
      (!currentHost.online && (this.isTestRoom(room) || hostGraceExpired))
    ) {
      room.hostPlayerId = player.id;
      room.hostReconnectDeadlineAt = undefined;
      if (room.musicSession) room.musicSession.ownerPlayerId = player.id;
      player.isReady = true;
    }
    this.attachConnection(room, player, connection);
    if (room.hostPlayerId === player.id) room.hostReconnectDeadlineAt = undefined;
    this.touch(room);
    this.appendSystemMessage(room, `${player.name} 加入了房间`);
    this.publishRoom(room);
    this.publishLobby();
    this.log("song.room.joined", room.id, player.id);
    return {
      roomId: room.id,
      playerId: player.id,
      sessionToken: player.sessionToken,
      snapshot: this.buildRoomSnapshot(room),
      privateState: this.buildPrivateState(room, player),
    };
  }

  private async reconnectRoom(connection: ConnectionRecord, roomIdValue: string, token: string) {
    const targetRoomId = ensureRoomId(roomIdValue);
    // 同一条连接重连它本来就在的那个房间时，不能走 detachFromRoom：
    // 那会先把自己的 player 记录删掉，随后的按 token 查找必然落空，重连反而失败。
    if (!(connection.roomId === targetRoomId && connection.playerId)) {
      this.ensureConnectionFree(connection);
    }
    const room = this.getRoom(targetRoomId);
    const player = Object.values(room.players).find(
      (candidate) =>
        safeEqualToken(candidate.sessionToken, token) && candidate.membership !== "kicked",
    );
    if (!player) throw new AppError("SESSION_INVALID", "会话令牌无效");

    this.attachConnection(room, player, connection);
    room.emptySinceAt = undefined;
    if (room.hostPlayerId === player.id) room.hostReconnectDeadlineAt = undefined;
    this.ensureRoundPlayerState(room, player);

    // 网易云播放地址可能带有效期。刷新页面后重新取一次当前回合地址，
    // 只替换 URL，不改动已经固定的答案、歌词片段和回合状态。
    const activeRound = room.phase === "playing" ? room.currentRound : undefined;
    if (activeRound) {
      try {
        const refreshedSong = await this.options.musicProvider.getSong(
          activeRound.song.id,
          room.musicSession?.cookie,
        );
        if (room.phase === "playing" && room.currentRound === activeRound) {
          activeRound.song.audioUrl = refreshedSong.audioUrl;
        }
      } catch (error) {
        // 地址刷新失败不应阻止玩家恢复席位，记录 warning 告警并允许客户端尝试现有地址。
        this.options.eventLogger?.warn("重连刷新歌曲播放地址失败", {
          roomId: room.id,
          songId: activeRound.song.id,
          ...describeError(error),
        });
      }
    }
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return {
      roomId: room.id,
      playerId: player.id,
      sessionToken: player.sessionToken,
      snapshot: this.buildRoomSnapshot(room),
      privateState: this.buildPrivateState(room, player),
    };
  }

  private leaveRoom(connection: ConnectionRecord) {
    // 显式离开代表账号主动退出，只有此时销毁其房间级音乐会话；网络断线由宽限期处理。
    return this.detachFromRoom(connection, { keepMusicSession: false });
  }

  /**
   * 让连接与其当前席位彻底脱钩，并与房间内的 player 记录同步，避免出现
   * 「在线但没有任何连接」的幽灵玩家（onlineCount 永不归零 → 房间永不关闭 →
   * 4 位房间号被耗尽，且只能靠重启进程恢复）。
   *
   * @param keepMusicSession 切房间 / 被接管时传 true：人是被动离开的，
   *   保留其网易云会话可以让旧房间继续出题（凭据只在内存，房间关闭即随之释放）；
   *   显式退出传 false，按原语义一并清除。
   */
  private detachFromRoom(
    connection: ConnectionRecord,
    { keepMusicSession }: { keepMusicSession: boolean },
  ) {
    const { room, player } = this.requireRoomPlayer(connection);
    if (!keepMusicSession) this.clearMusicSession(room, player.id);
    delete room.players[player.id];
    this.connections.detach(connection);

    if (Object.keys(room.players).length === 0 && !this.isTestRoom(room)) {
      this.closeRoom(room, "empty");
      return { left: true, roomClosed: true };
    }

    if (room.hostPlayerId === player.id) {
      room.hostPlayerId = "";
      room.hostReconnectDeadlineAt = undefined;
      this.reassignHost(room);
    }
    if (room.phase === "submittingSong" && room.pendingSubmitterPlayerId === player.id) {
      room.pendingSubmitterPlayerId = undefined;
      room.phase = "choosingSubmitter";
    }
    if (room.phase === "playing" && this.isRoundComplete(room)) this.finishRound(room);

    this.touch(room);
    this.appendSystemMessage(room, `${player.name} 离开了房间`);
    this.publishRoom(room);
    this.publishLobby();
    return { left: true, roomClosed: false };
  }

  private requestSync(connection: ConnectionRecord) {
    const { room } = this.requireRoomPlayer(connection);
    connection.resetStateSync?.();
    this.publishRoom(room, connection);
    return { synced: true };
  }

  private setReady(connection: ConnectionRecord, ready: boolean) {
    const { room, player } = this.requireRoomPlayer(connection);
    if (room.phase !== "waiting") throw new AppError("INVALID_PHASE", "只能在等待阶段准备");
    if (player.membership !== "active") throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能准备");
    player.isReady = player.id === room.hostPlayerId ? true : ready;
    this.touch(room);
    this.publishRoom(room);
    return { ready: player.isReady };
  }

  private setSpectator(connection: ConnectionRecord, spectator: boolean) {
    const { room, player } = this.requireRoomPlayer(connection);
    if (room.phase !== "waiting") {
      const targetMembership = spectator ? "spectator" : "active";
      if (targetMembership === "spectator" && !room.allowSpectators) {
        throw new AppError("SPECTATORS_DISABLED", "当前房间不允许旁观");
      }
      // 再次点击同个预约选项时撤销预约
      if (player.nextRoundMembership === targetMembership) {
        player.nextRoundMembership = undefined;
        this.touch(room);
        this.publishRoom(room);
        return { spectator: player.membership === "spectator", queued: false };
      }
      player.nextRoundMembership = targetMembership;
      this.touch(room);
      this.publishRoom(room);
      return { spectator, queued: true };
    }
    const nextMembership = spectator ? "spectator" : "active";
    player.nextRoundMembership = undefined;
    if (player.membership === nextMembership) return { spectator, queued: false };
    if (spectator) {
      if (!room.allowSpectators) throw new AppError("SPECTATORS_DISABLED", "当前房间不允许旁观");
      player.membership = "spectator";
      player.isReady = false;
    } else {
      player.membership = "active";
      player.isReady = player.id === room.hostPlayerId;
    }
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return { spectator, queued: false };
  }

  private updateSettings(
    connection: ConnectionRecord,
    payload: Extract<SonGuessrClientMessage, { type: "song.room.updateSettings" }>["payload"],
  ) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (room.phase !== "waiting") {
      throw new AppError("INVALID_PHASE", "只能在等待阶段修改房间设置");
    }
    const next = { ...room, settings: cloneSettings(room.settings) };
    if (payload.name !== undefined) next.name = normalizeWord(payload.name) || next.name;
    if (payload.visibility !== undefined) next.visibility = payload.visibility;
    if (payload.allowSpectators !== undefined) next.allowSpectators = payload.allowSpectators;
    if (payload.visibility === "public") next.password = undefined;
    if (next.visibility === "private" && payload.password !== undefined) {
      next.password = payload.password.trim() ? payload.password.trim() : next.password;
    }
    if (next.visibility === "private" && !next.password) {
      throw new AppError("PASSWORD_REQUIRED", "私密房间需要密码");
    }

    if (payload.questionType !== undefined) next.settings.questionType = payload.questionType;
    // 单人房间固定由系统出题，不提供手动出题与轮流出题。
    if (!room.solo && payload.questionMode !== undefined) {
      next.settings.questionMode = payload.questionMode;
    }
    if (!room.solo && payload.autoRotateSubmitter !== undefined) {
      next.settings.autoRotateSubmitter = payload.autoRotateSubmitter;
    }
    if (payload.autoFilters !== undefined) {
      next.settings.autoFilters = this.normalizeAutoFilters(payload.autoFilters);
    }
    if (payload.animeAutoFilters !== undefined) {
      next.settings.animeAutoFilters = this.normalizeAnimeAutoFilters(payload.animeAutoFilters);
    }

    if (payload.lyricsLineCount !== undefined) {
      next.settings.lyricsLineCount = clampInt(payload.lyricsLineCount, 1, 10);
    }
    if (payload.showLyrics !== undefined) {
      next.settings.showLyrics = payload.showLyrics;
    }
    if (payload.maxGuessesPerRound !== undefined) {
      next.settings.maxGuessesPerRound = clampInt(payload.maxGuessesPerRound, 1, 10);
    }
    if (payload.guessDurationSeconds !== undefined) {
      next.settings.guessDurationSeconds = clampInt(payload.guessDurationSeconds, 10, 180);
    }
    if (payload.showGuessTimer !== undefined) {
      next.settings.showGuessTimer = payload.showGuessTimer;
    }
    if (payload.bloodMode !== undefined) {
      next.settings.bloodMode = payload.bloodMode;
    }

    room.name = next.name;
    room.visibility = next.visibility;
    room.password = next.password;
    room.allowSpectators = next.allowSpectators;
    room.settings = next.settings;
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return { settings: room.settings };
  }

  private async searchMusic(connection: ConnectionRecord, keyword: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.requireMusicQuota(connection, player);
    return {
      results: await this.options.musicProvider.search(
        keyword,
        undefined,
        room.musicSession?.cookie,
      ),
    };
  }

  private async resolvePlaylist(connection: ConnectionRecord, value: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.requireMusicQuota(connection, player);
    const playlistId = this.parsePlaylistId(value);
    const resolve = this.options.musicProvider.getPlaylistSongs;
    if (!resolve) throw new AppError("MUSIC_API_UNAVAILABLE", "当前音乐 API 不支持读取歌单");
    const result = await resolve.call(this.options.musicProvider, playlistId, room.musicSession?.cookie);
    return { playlist: result.info };
  }

  private async searchArtists(connection: ConnectionRecord, keyword: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.requireMusicQuota(connection, player);
    const search = this.options.musicProvider.searchArtists;
    if (!search) throw new AppError("MUSIC_API_UNAVAILABLE", "当前音乐 API 不支持搜索歌手");
    return {
      results: await search.call(this.options.musicProvider, keyword, 20, room.musicSession?.cookie),
    };
  }

  private async searchBangumi(connection: ConnectionRecord, keyword: string) {
    this.requireRoomPlayer(connection);
    const provider = this.options.bangumiProvider;
    if (!provider) throw new AppError("BANGUMI_API_UNAVAILABLE", "当前未配置 Bangumi 接口");
    return { results: await provider.searchSubjects(keyword, 20) };
  }

  private async getAnimeSongs(connection: ConnectionRecord, subjectId: string) {
    this.requireRoomPlayer(connection);
    const provider = this.options.bangumiProvider;
    if (!provider) throw new AppError("BANGUMI_API_UNAVAILABLE", "当前未配置 Bangumi 接口");
    const anime = await provider.getSubject(subjectId);
    const results = await this.resolveAnimeMatchedSongs(anime, connection);
    return { results };
  }

  /**
   * 客户端可直接触发的音乐类命令的统一前置闸门：正式成员才可调用 + 按连接配额。
   *
   * 这两条此前都缺：命令只要求「人在房间里」，旁观者同样能发起搜索；
   * 且完全没有调用配额，见 `musicLimiter` 的注释。
   */
  private requireMusicQuota(connection: ConnectionRecord, player: SonGuessrPlayerRecord) {
    if (player.membership !== "active") {
      throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能进行音乐操作");
    }
    if (!this.musicLimiter.allow(connection.id, this.now())) {
      throw new AppError("RATE_LIMITED", "音乐请求过于频繁，请稍后再试");
    }
  }

  private parsePlaylistId(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new AppError("INVALID_PLAYLIST", "请输入网易云歌单链接或数字 ID");
    if (/^\d+$/.test(trimmed)) return trimmed;

    try {
      const url = new URL(trimmed);
      // 1. 常规 Query 参数: ?id=123
      const queryId = url.searchParams.get("id");
      if (queryId && /^\d+$/.test(queryId)) return queryId;

      // 2. SPA Hash 路由参数: #/playlist?id=123
      if (url.hash.includes("?")) {
        const hashQuery = url.hash.slice(url.hash.indexOf("?") + 1);
        const hashParams = new URLSearchParams(hashQuery);
        const hashId = hashParams.get("id");
        if (hashId && /^\d+$/.test(hashId)) return hashId;
      }

      // 3. 路径格式: /playlist/123
      const pathMatch = url.pathname.match(/\/playlist\/(\d+)/i);
      if (pathMatch?.[1]) return pathMatch[1];
    } catch {
      // 针对缺少协议的前缀 (如 music.163.com/playlist?id=123) 补全后解析
      if (trimmed.includes("/")) {
        try {
          const fallbackUrl = new URL(`https://${trimmed.replace(/^\/+/, "")}`);
          const queryId = fallbackUrl.searchParams.get("id");
          if (queryId && /^\d+$/.test(queryId)) return queryId;
          const pathMatch = fallbackUrl.pathname.match(/\/playlist\/(\d+)/i);
          if (pathMatch?.[1]) return pathMatch[1];
        } catch {
          // 忽略
        }
      }
    }

    throw new AppError("INVALID_PLAYLIST", "请输入网易云歌单链接或数字 ID");
  }

  private normalizeAutoFilters(filters: SongAutoFiltersInput): SongAutoFilters {
    const playlist = filters.playlist
      ? {
          id: this.parsePlaylistId(filters.playlist.id),
          name: filters.playlist.name?.trim().slice(0, 120),
          songCount: filters.playlist.songCount,
        }
      : undefined;
    const artists = (filters.artists ?? [])
      .slice(0, 20)
      .map((artist) => ({ id: artist.id.trim().slice(0, 64), name: normalizeWord(artist.name).slice(0, 80) }))
      .filter((artist) => artist.id && artist.name);
    const minPopularity = filters.minPopularity ?? 0;
    return { playlist, artists, minPopularity };
  }

  private normalizeAnimeAutoFilters(filters: AnimeAutoFilters): AnimeAutoFilters {
    const startYear = filters.startYear && clampInt(filters.startYear, 1900, 2200);
    const endYear = filters.endYear && clampInt(filters.endYear, 1900, 2200);
    const trackKinds = (filters.trackKinds ?? ALL_BANGUMI_TRACK_KINDS)
      .filter((kind, index, all) => ALL_BANGUMI_TRACK_KINDS.includes(kind) && all.indexOf(kind) === index);
    const songMinPopularity = [0, 1_000, 10_000, 100_000].includes(filters.songMinPopularity ?? 0)
      ? (filters.songMinPopularity ?? 0)
      : 0;
    return {
      startYear,
      endYear: endYear && startYear ? Math.max(startYear, endYear) : endYear,
      ranking: filters.ranking === "year" ? "year" : "all",
      subjectLimit: clampInt(filters.subjectLimit ?? 50, 1, 1000),
      songMinPopularity,
      trackKinds: trackKinds.length > 0 ? trackKinds as AnimeAutoFilters["trackKinds"] : [...ALL_BANGUMI_TRACK_KINDS],
    };
  }

  private kick(connection: ConnectionRecord, targetPlayerId: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (targetPlayerId === player.id) throw new AppError("INVALID_TARGET", "房主不能踢出自己");
    const target = room.players[targetPlayerId];
    if (!target || target.membership === "kicked") throw new AppError("PLAYER_NOT_FOUND", "玩家不存在");

    this.clearMusicSession(room, target.id);
    target.membership = "kicked";
    target.online = false;
    const targetConnection = this.connections.findConnectionByPlayer(room.id, target.id);
    if (targetConnection) {
      (targetConnection.sendPacket ?? targetConnection.send)(
        createEvent("song.room.kicked", { roomId: room.id }),
      );
      this.connections.detach(targetConnection);
      targetConnection.close(4003, "kicked");
    }

    if (room.pendingSubmitterPlayerId === target.id) {
      room.pendingSubmitterPlayerId = undefined;
      room.phase = "choosingSubmitter";
    }
    if (room.phase === "playing" && this.isRoundComplete(room)) this.finishRound(room);
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return { kicked: true };
  }

  private transferHost(connection: ConnectionRecord, targetPlayerId: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    const target = room.players[targetPlayerId];
    if (!target || !target.online || target.membership !== "active") {
      throw new AppError("INVALID_TARGET", "只能转让给在线正式玩家");
    }
    room.musicAuthOperation = undefined;
    room.automaticRoundOperation = undefined;
    room.automaticRoundLoading = false;
    room.hostPlayerId = target.id;
    room.hostReconnectDeadlineAt = undefined;
    if (room.musicSession) room.musicSession.ownerPlayerId = target.id;
    target.isReady = true;
    this.touch(room);
    this.publishRoom(room);
    return { hostPlayerId: target.id };
  }

  private sendChat(connection: ConnectionRecord, rawText: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    if (!this.chatLimiter.allow(connection.id, this.now())) {
      throw new AppError("RATE_LIMITED", "发言过于频繁，请稍后再试");
    }
    const text = normalizeWord(rawText).slice(0, 200);
    if (!text) throw new AppError("INVALID_MESSAGE", "消息不能为空");
    const message: ChatMessage = {
      id: this.createId("song_chat"),
      playerId: player.id,
      playerName: player.name,
      text,
      createdAt: this.now(),
      system: false,
    };
    room.chat = [...room.chat, message].slice(-CHAT_LIMIT);
    this.touch(room);
    // 只走增量事件，不再为一条聊天广播整套房间快照：
    // N 人房间刷 M 条消息会从 O(N×M) 次全量序列化降到 O(N) 次小事件。
    this.broadcastRoomEvent(room, "song.chat.message", { message });
    return { sent: true };
  }

  /** 向房间内所有连接下发一条非状态事件（差量同步通道之外的独立事件）。 */
  private broadcastRoomEvent(room: SonGuessrRoomRecord, name: string, payload: unknown) {
    for (const connection of this.connections.getRoomConnections(room.id)) {
      connection.send(createEvent(name, payload));
    }
  }

  private async createMusicQrLogin(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    const createQrLogin = this.options.musicProvider.createQrLogin;
    if (!createQrLogin) throw new AppError("MUSIC_AUTH_UNAVAILABLE", "音乐登录功能不可用");
    return createQrLogin.call(this.options.musicProvider);
  }

  private async checkMusicQrLogin(connection: ConnectionRecord, keyValue: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    const key = keyValue.trim();
    if (!key || key.length > 256) throw new AppError("INVALID_LOGIN", "二维码登录密钥无效");
    const checkQrLogin = this.options.musicProvider.checkQrLogin;
    if (!checkQrLogin) throw new AppError("MUSIC_AUTH_UNAVAILABLE", "音乐登录功能不可用");
    const verify = this.beginMusicAuthentication(room, player, connection);
    const result = await checkQrLogin.call(this.options.musicProvider, key);
    verify();
    if (result.status !== "authorized" || !result.session) {
      return { status: result.status, message: result.message };
    }
    const session = this.installMusicSession(room, player.id, result.session);
    this.touch(room);
    this.publishRoom(room);
    return {
      status: result.status,
      message: result.message,
      cookie: session.cookie,
      account: session.account,
    };
  }

  private async useMusicCookie(connection: ConnectionRecord, cookieValue: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    const cookie = this.requireMusicCookie(cookieValue);
    const getLoginStatus = this.options.musicProvider.getLoginStatus;
    if (!getLoginStatus) throw new AppError("MUSIC_AUTH_UNAVAILABLE", "音乐登录功能不可用");
    const verify = this.beginMusicAuthentication(room, player, connection);
    const result = await getLoginStatus.call(this.options.musicProvider, cookie);
    verify();
    const session = this.installMusicSession(room, player.id, result);
    this.touch(room);
    this.publishRoom(room);
    return { account: session.account };
  }

  private clearMusicAccount(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    this.clearMusicSession(room);
    this.touch(room);
    this.publishRoom(room);
    return { cleared: true };
  }

  private beginMusicAuthentication(
    room: SonGuessrRoomRecord,
    player: SonGuessrPlayerRecord,
    connection: ConnectionRecord,
  ) {
    const operation = Symbol("musicAuthentication");
    room.musicAuthOperation = operation;
    return () => {
      if (this.rooms.get(room.id) !== room || room.musicAuthOperation !== operation
        || room.hostPlayerId !== player.id || room.players[player.id] !== player
        || !player.online || connection.roomId !== room.id || connection.playerId !== player.id) {
        throw new AppError("MUSIC_SESSION_INVALID", "音乐登录操作已失效，请重新登录");
      }
    };
  }

  private installMusicSession(
    room: SonGuessrRoomRecord,
    ownerPlayerId: string,
    session: MusicLoginSession,
  ): MusicLoginSession {
    this.ensureHost(room, ownerPlayerId);
    const cookie = this.requireMusicCookie(session.cookie);
    const account = {
      userId: session.account.userId?.slice(0, 64),
      nickname: session.account.nickname.slice(0, 80) || "网易云用户",
      avatarUrl: session.account.avatarUrl?.slice(0, 2_048),
      vipStatus: session.account.vipStatus,
      vipType: session.account.vipType,
      vipExpireTime: session.account.vipExpireTime,
    };
    // 房间内只暂存调用音乐接口所需的 Cookie 和会员判定所需的最小账号状态，不做持久化保存。
    room.musicSession = { ownerPlayerId, cookie, account };
    return { cookie, account };
  }

  private requireMusicCookie(value: string): string {
    const cookie = value.trim();
    if (!cookie || cookie.length > MAX_SONGUESSR_COOKIE_LENGTH) {
      throw new AppError("MUSIC_SESSION_INVALID", "网易云登录状态无效");
    }
    return cookie;
  }

  private clearMusicSession(room: SonGuessrRoomRecord, ownerPlayerId?: string): boolean {
    if (ownerPlayerId && room.musicSession?.ownerPlayerId !== ownerPlayerId && room.hostPlayerId !== ownerPlayerId) return false;
    room.musicAuthOperation = undefined;
    if (!room.musicSession) return false;
    room.musicSession = undefined;
    return true;
  }

  private addBots(connection: ConnectionRecord, countValue?: number) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (!this.isTestRoom(room)) throw new AppError("TEST_ROOM_ONLY", "该指令仅用于测试房间");
    const currentCount = Object.values(room.players).length;
    if (currentCount >= TEST_MODE_MAX_PLAYERS) {
      throw new AppError("ROOM_FULL", `测试房间最多 ${TEST_MODE_MAX_PLAYERS} 名玩家`);
    }
    // 单条指令的批量上限只约束「一次能加多少」，必须再卡一次总人数：
    // 否则反复调用就能把房间撑到任意规模，内存与全房广播量都无上界。
    const count = clampInt(
      countValue ?? 1,
      1,
      Math.min(TEST_BOT_BATCH_LIMIT, TEST_MODE_MAX_PLAYERS - currentCount),
    );
    const added: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const botIndex = Object.values(room.players).filter((candidate) => candidate.isBot).length;
      const suffix = BOT_NAME_SUFFIXES[botIndex] ?? String(botIndex + 1);
      const bot = this.createPlayer(`测试人机 ${suffix}`, false, true);
      bot.isReady = true;
      room.players[bot.id] = bot;
      added.push(bot.id);
    }
    this.touch(room);
    this.publishRoom(room);
    return { addedPlayerIds: added };
  }

  private removeBots(connection: ConnectionRecord, countValue?: number) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (!this.isTestRoom(room)) throw new AppError("TEST_ROOM_ONLY", "该指令仅用于测试房间");
    const count = clampInt(countValue ?? 1, 1, TEST_BOT_BATCH_LIMIT);
    const bots = Object.values(room.players)
      .filter((candidate) => candidate.isBot)
      .sort((left, right) => right.joinedAt - left.joinedAt)
      .slice(0, count);
    for (const bot of bots) delete room.players[bot.id];
    if (room.phase === "playing" && this.isRoundComplete(room)) this.finishRound(room);
    this.touch(room);
    this.publishRoom(room);
    return { removedPlayerIds: bots.map((bot) => bot.id) };
  }

  private async startGame(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    const automatic = room.solo || room.settings.questionMode === "automatic";
    if (
      room.phase !== "waiting" ||
      (automatic && room.automaticRoundLoading) ||
      (!automatic && room.manualRoundStarting)
    ) {
      throw new AppError("INVALID_PHASE", "当前不能开始新游戏");
    }

    // 自动与手动开局均先占锁，避免重复点击并发创建两轮。
    const operation = Symbol("automaticRound");
    if (automatic) {
      room.automaticRoundOperation = operation;
      room.automaticRoundLoading = true;
    } else room.manualRoundStarting = true;
    try {
      if (!room.musicSession) {
        throw new AppError("MUSIC_LOGIN_REQUIRED", "开始游戏前请先扫码登录网易云账号");
      }
      const getLoginStatus = this.options.musicProvider.getLoginStatus;
      if (!getLoginStatus) {
        throw new AppError("MUSIC_AUTH_UNAVAILABLE", "网易云登录状态校验不可用");
      }
      const musicSession = room.musicSession;
      const authOperation = room.musicAuthOperation;
      const verifySession = () => {
        if (this.rooms.get(room.id) !== room || room.musicSession !== musicSession
          || room.musicAuthOperation !== authOperation || room.hostPlayerId !== player.id
          || connection.roomId !== room.id || connection.playerId !== player.id || !player.online) {
          throw new AppError("MUSIC_SESSION_INVALID", "音乐会话已变更，请重新开始");
        }
      };
      try {
        const session = await getLoginStatus.call(this.options.musicProvider, musicSession.cookie);
        verifySession();
        musicSession.account = session.account;
      } catch (error) {
        if (error instanceof AppError) {
          if (error.code === "MUSIC_SESSION_INVALID" && room.musicSession === musicSession
            && room.musicAuthOperation === authOperation) {
            this.clearMusicSession(room);
            this.publishRoom(room);
          }
          throw error;
        }
        throw new AppError("MUSIC_API_FAILED", "网易云登录状态校验失败，请稍后重试");
      }

      // 单人房间由系统直接出题，没有出题人与准备环节。
      if (!room.solo) {
        const activePlayers = this.activePlayers(room);
        if (activePlayers.length < 2) throw new AppError("NOT_ENOUGH_PLAYERS", "至少需要两名正式玩家");
        if (activePlayers.some((candidate) => !candidate.isReady)) {
          throw new AppError("PLAYERS_NOT_READY", "仍有玩家未准备");
        }
      }

      room.pendingSubmitterPlayerId = undefined;
      room.currentRound = undefined;
      room.roundSummary = undefined;
      if (automatic) {
        await this.startAutomaticRound(room, () => {
          verifySession();
          if (room.phase !== "waiting" || room.automaticRoundOperation !== operation) {
            throw new AppError("ROUND_EXPIRED", "出题操作已失效");
          }
        });
      } else {
        room.phase = "choosingSubmitter";
      }
      room.finalScores = undefined;
      this.touch(room);
      this.publishRoom(room);
      this.publishLobby();
      this.log("song.game.started", room.id, player.id);
      return { started: true };
    } finally {
      if (automatic) {
        if (room.automaticRoundOperation === operation) {
          room.automaticRoundOperation = undefined;
          room.automaticRoundLoading = false;
        }
      } else room.manualRoundStarting = false;
    }
  }

  private chooseSubmitter(connection: ConnectionRecord, targetPlayerId: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (room.phase !== "choosingSubmitter") throw new AppError("INVALID_PHASE", "当前不能选择出题人");
    const target = room.players[targetPlayerId];
    if (!target || !target.online || target.membership === "kicked" || target.isBot) {
      throw new AppError("INVALID_TARGET", "出题人必须是在线真人玩家");
    }

    room.pendingSubmitterPlayerId = target.id;
    room.phase = "submittingSong";
    room.roundSummary = undefined;
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return { submitterPlayerId: target.id };
  }

  private async submitSong(connection: ConnectionRecord, songId: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    if (room.phase !== "submittingSong" || room.pendingSubmitterPlayerId !== player.id) {
      throw new AppError("NOT_SUBMITTER", "只有当前出题人可以提交歌曲");
    }

    const submitterId = player.id;
    const song = await this.options.musicProvider.getSong(songId, room.musicSession?.cookie);
    // 音乐接口是异步的，返回时出题人可能已经退出或被踢；不能再安装一个失去归属的回合。
    if (
      room.phase !== "submittingSong" ||
      room.pendingSubmitterPlayerId !== submitterId ||
      room.players[submitterId] !== player ||
      player.membership === "kicked" ||
      !player.online
    ) {
      return { ignored: true };
    }
    // 不再按会员状态拦截会员专享曲：`getSong` 已经负责把受限歌曲交给解灰链路取回完整音频，
    // 拿不到地址时会直接抛 `SONG_UNAVAILABLE`，出题资格以「实际有没有音频」为准。
    const roundNumber = this.installRound(room, song, player.id);
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();

    if (this.isRoundComplete(room)) {
      this.finishRound(room);
      this.publishRoom(room);
    }
    return { roundNumber };
  }

  private async submitAnime(connection: ConnectionRecord, subjectId: string, songId?: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    if (room.settings.questionType !== "anime") {
      throw new AppError("INVALID_QUESTION_TYPE", "当前房间不是听歌猜番模式");
    }
    if (room.phase !== "submittingSong" || room.pendingSubmitterPlayerId !== player.id) {
      throw new AppError("NOT_SUBMITTER", "只有当前出题人可以提交番剧");
    }
    const provider = this.options.bangumiProvider;
    if (!provider) throw new AppError("BANGUMI_API_UNAVAILABLE", "当前未配置 Bangumi 接口");
    const submitterId = player.id;
    const anime = await provider.getSubject(subjectId);
    const resolved = songId
      ? await this.resolveSpecifiedAnimeSong(room, anime, songId)
      : await this.resolveAnimeSong(room, anime);
    if (
      room.phase !== "submittingSong" ||
      room.pendingSubmitterPlayerId !== submitterId ||
      room.players[submitterId] !== player ||
      player.membership === "kicked" ||
      !player.online
    ) return { ignored: true };
    const roundNumber = this.installRound(room, resolved.song, player.id, anime, resolved.track);
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    if (this.isRoundComplete(room)) {
      this.finishRound(room);
      this.publishRoom(room);
    }
    return { roundNumber };
  }

  private async resolveSpecifiedAnimeSong(
    room: SonGuessrRoomRecord,
    anime: BangumiSubjectDetails,
    songId: string,
  ): Promise<{ song: SongDetails; track: BangumiMusicTrack }> {
    const provider = this.options.musicProvider;
    const cookie = room.musicSession?.cookie;
    let song: SongDetails;
    try {
      song = await provider.getSong(songId, cookie);
    } catch (error) {
      if (!isUnusableSongCandidate(error)) throw error;
      throw new AppError("BANGUMI_NO_MUSIC", "所选歌曲无法播放或获取音频失败");
    }
    const matchedTrack = anime.musicTracks.find((t) => isSongTitleMatch(song.title, t.title))
      ?? (song.album ? anime.musicTracks.find((t) => isAlbumNameMatch(song.album!, t.title)) : undefined)
      ?? anime.musicTracks.find((t) => t.artist && song.artist.includes(t.artist))
      ?? anime.musicTracks[0]
      ?? { title: song.title, artist: song.artist, kind: "theme" as BangumiMusicTrackKind };
    const trackKind = this.refineTrackKind(matchedTrack.kind, song);
    return {
      song,
      track: { ...matchedTrack, kind: trackKind },
    };
  }

  private async resolveAnimeSong(room: SonGuessrRoomRecord, anime: BangumiSubjectDetails): Promise<{ song: SongDetails; track: BangumiMusicTrack }> {
    const provider = this.options.musicProvider;
    if (anime.musicTracks.length === 0) {
      throw new AppError("BANGUMI_NO_MUSIC", "该番剧没有可识别的主题曲信息");
    }
    const filters = room.settings.questionMode === "automatic"
      ? room.settings.animeAutoFilters ?? DEFAULT_SETTINGS.animeAutoFilters!
      : {};
    const allowedKinds = new Set(filters.trackKinds ?? ALL_BANGUMI_TRACK_KINDS);
    // 出题必须在**所有通过筛选的曲目之间等概率**：本地数据集按 relation_order、
    // 联网 API 按 KIND_PRIORITY，都把片头曲排在最前面，直接顺序取首个可播放曲目会让
    // OP 长期霸占绝大多数回合（实测线上近乎每轮都是 OP）。先洗牌再截断，
    // 被预算截掉的曲目同样等概率，而不是永远只有排在前面的几首有机会。
    const candidates = shuffle(
      anime.musicTracks.filter((track) => allowedKinds.has(track.kind)),
      this.random,
    ).slice(0, ANIME_TRACK_LOOKUP_LIMIT);
    const minPopularity = filters.songMinPopularity ?? 0;
    const cookie = room.musicSession?.cookie;
    const recentSongIds = new Set(room.recentSongIds ?? []);
    let fallbackRecent: { song: SongDetails; track: BangumiMusicTrack } | undefined;
    // 年份错配（同名不同曲）的兜底，优先级低于「近期重复过的正确歌曲」：
    // 宁可重听一首真正属于这部番的歌，也不放一首完全无关的同名新歌。
    let fallbackYear: { song: SongDetails; track: BangumiMusicTrack } | undefined;
    // 翻唱兜底，优先级最低：翻唱是**别人的演唱录音**，连「同名不同曲」都不如
    // （后者至少是同一首歌）。只有在整池候选全是翻唱时才认它，避免无歌可出。
    let fallbackCover: { song: SongDetails; track: BangumiMusicTrack } | undefined;
    // 已经由翻唱回指过的原曲 ID，防止两个翻唱互相指向、反复插队。
    const originRetryIds = new Set<string>();
    // 冷缓存下每个候选曲目都可能触发多次回源，必须设总预算，
    // 否则一次出题会退化成上百次串行上游请求（实测最坏 60s+）。
    const budget = { search: ANIME_SONG_SEARCH_BUDGET, detail: ANIME_SONG_DETAIL_BUDGET };

    for (const track of candidates) {
      if (budget.search <= 0 || budget.detail <= 0) break;
      const queries: string[] = [];
      // 歌手名只在**足够短**时才拼进检索词：Bangumi 的 artist 常是整串声优列表
      // （「A、B、C、D、E、F」这种），拼进去等于把检索词毁掉，网易云什么都搜不到。
      // 这时退回番剧名（原名往往是英文，与中文 / 日文名都不一样）。
      const artistQuery = track.artist && track.artist.trim().length <= MAX_ARTIST_QUERY_LENGTH
        ? track.artist.trim()
        : "";
      if (artistQuery) queries.push(`${track.title} ${artistQuery}`);
      if (anime.name) queries.push(`${track.title} ${anime.name}`);
      if (anime.nameCn && anime.nameCn !== anime.name) queries.push(`${track.title} ${anime.nameCn}`);
      queries.push(track.title);
      // 仅凭歌手名检索时，Bangumi 与网易云的歌手写法差异会让原版漏召回，
      // 只剩翻唱版可匹配。追加番剧名与曲名宽检索，保证原版进入候选池，
      // 再由 scoreAnimeSongCandidate 的原版优先排序决定最终结果。
      const broadQueries = [
        anime.name ? `${track.title} ${anime.name}` : "",
        anime.nameCn && anime.nameCn !== anime.name ? `${track.title} ${anime.nameCn}` : "",
        track.title,
      ].filter((query) => query && !queries.includes(query));
      queries.push(...broadQueries);

      // 同一曲目的多个检索词之间没有依赖，并行回源把最坏等待压到一次上游往返。
      // 带番剧名的检索词单独标出来：命中它们的候选是「确实属于本番」的强证据。
      const scopeQueries = [
        anime.name ? `${track.title} ${anime.name}` : "",
        anime.nameCn && anime.nameCn !== anime.name ? `${track.title} ${anime.nameCn}` : "",
      ].filter(Boolean);
      const matched = await this.searchAnimeTrackCandidates(provider, queries, track, cookie, budget, scopeQueries);

      // 网易云会把翻唱、器乐改编、伴奏等版本混排在原版之前；先按「原版优先」评分
      // 降序排列，再依次验证可播放性，确保原版存在时不会被翻唱版抢占。
      const ranked = matched.candidates
        .map((candidate, index) => {
          const options = { animeScoped: matched.animeScopedIds.has(candidate.id) };
          return {
            candidate,
            index,
            score: scoreAnimeSongCandidate(candidate, track, options),
            // 弱候选的准入门槛用「证据分」而非排序分：非原唱标记的降权只在排序里生效，
            // 唯一候选是翻唱 / 改编时仍要能降级出题（见 hasAnimeSongEvidence）。
            evidenced: hasAnimeSongEvidence(candidate, track, options),
          };
        })
        .filter((entry) => entry.evidenced)
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map((entry) => entry.candidate);
      // 常规检索一无所获（或整池都是弱候选）时换一条路：这条关联条目可能压根不是
      // 一首歌，而是**整张专辑**（见 `ALBUM_LIKE_TRACK_KINDS`）。此时按条目名去搜
      // 单曲必然空手而归，改走「搜专辑 → 取专辑曲目」才能拿到真正可出的歌。
      let pool: SongSearchResult[] = ranked;
      if (pool.length === 0 && isAlbumLikeTrackKind(track.kind)) {
        pool = await this.resolveAlbumTrackCandidates(provider, track, anime, cookie, budget);
      }
      // 最后一道兜底：条目级解析全部失败时，用番剧名检索该番的歌（见 resolveAnimeLevelCandidates）。
      if (pool.length === 0) {
        pool = await this.resolveAnimeLevelCandidates(provider, anime, cookie, budget);
      }
      // 三条路都没拿到可出的歌时换下一首关联曲目，绝不硬塞弱候选。
      if (pool.length === 0) continue;
      // 只有「常规检索」路径才允许翻唱兜底：专辑 / 番剧级兜底已经把「哪首歌」放宽了，
      // 不该再把「是不是原版」一起放宽（实测番剧兜底会召回该番的**日语翻唱版**并出题）。
      const allowCoverFallback = pool === ranked;

      let attempts = 0;
      // 用索引循环而非 for...of：翻唱自带原曲 ID，需要把原版插到队首交给下一次迭代验证。
      for (let index = 0; index < pool.length; index += 1) {
        const candidate = pool[index];
        if (budget.detail <= 0 || attempts >= ANIME_TRACK_DETAIL_ATTEMPTS) break;
        attempts += 1;
        // 热度不达标就无法出题，先用一次廉价的红心数查询判掉，
        // 避免为一个必然被否决的候选拉取歌词、音频与百科（约 5~6 个上游请求）。
        if (minPopularity > 0 && provider.getSongPopularity) {
          budget.detail -= 1;
          const popularity = await provider
            .getSongPopularity.call(provider, candidate.id, cookie)
            .catch((error: unknown) => {
              if (!isUnusableSongCandidate(error)) throw error;
              return undefined;
            });
          if (popularity !== undefined && popularity < minPopularity) continue;
        }
        budget.detail -= 1;
        let song: SongDetails;
        try {
          song = await provider.getSong(candidate.id, cookie);
        } catch (error) {
          if (!isUnusableSongCandidate(error)) throw error;
          // 仅单首歌曲不可播放时继续尝试其它版本，全局依赖失败原样透传。
          continue;
        }
        if (minPopularity > 0 && (song.popularity === undefined || song.popularity < minPopularity)) continue;
        // 台词轨 / 伴奏 / 纯音乐一律否决，且**不占验证名额**：特典 CD 里它们常成批
        // 排在前面，若让它们吃掉 ANIME_TRACK_DETAIL_ATTEMPTS，真正的歌连被验证的机会都没有。
        // 宁可这部番出不了题，也不能放一段对白让玩家猜。
        if (isNonVocalTrack(song.title)) {
          attempts -= 1;
          continue;
        }
        const resolved = {
          song,
          track: { ...track, kind: this.refineTrackKind(track.kind, song) },
        } satisfies { song: SongDetails; track: BangumiMusicTrack };
        // 翻唱让位：网易云自标 `originCoverType === 2` 的版本是**别人的演唱录音**。
        // 文本维度在它面前全失效（翻唱常把曲名与专辑名照抄原曲，实测《裸の勇者》原版
        // 与翻唱曲名、专辑名一字不差），只有这个字段能把它认出来。
        // 与年份错配同理：让位且**不占** `ANIME_TRACK_DETAIL_ATTEMPTS`，否则成批
        // 排在前面的翻唱会把验证名额吃光，真正的原版连被验证的机会都没有。
        if (song.originCoverType === 2) {
          // 翻唱自带原曲 ID —— 原版常常压根没进候选池（实测：Bangumi 存中文译名
          // 《你所不知道的故事》时，按译名检索只召回中文重填词的翻唱，日文原版
          // 《君の知らない物語》永远进不了池子）。直接把它插到队首，下一次迭代即验证原版。
          const originalId = song.originSongId;
          if (
            originalId
            && originalId !== candidate.id
            && !originRetryIds.has(originalId)
            && !pool.some((entry) => entry.id === originalId)
          ) {
            originRetryIds.add(originalId);
            pool.splice(index + 1, 0, {
              id: originalId,
              title: track.title,
              artist: track.artist ?? "",
            });
          }
          if (allowCoverFallback && !fallbackCover) fallbackCover = resolved;
          attempts -= 1;
          continue;
        }
        // 同名不同曲：曲名（与专辑名）完全一致，发行年份却与番剧差了一二十年。
        // 发行年只有歌曲详情里有，所以这条只能在验证阶段剔除，把机会让给年份合理的候选。
        // **错配候选不占用 `ANIME_TRACK_DETAIL_ATTEMPTS`**：同名新歌往往成批排在前面
        // （实测 XG / chuLa / Anna Yvette 等同名版本都是「曲名 + 专辑名」双命中得 4 分，
        // 而原版挂在「动画名 - 曲名」的专辑下只有 2 分），若让它们吃掉 3 个验证名额，
        // 排在后面的原版连被验证的机会都没有。整体仍受 detail 预算约束，不会无界回源。
        if (isReleaseYearOffTarget(song.releaseYear, anime.year)) {
          if (!fallbackYear) fallbackYear = resolved;
          attempts -= 1;
          continue;
        }
        if (recentSongIds.has(resolved.song.id)) {
          if (!fallbackRecent) fallbackRecent = resolved;
          continue;
        }
        return resolved;
      }
    }

    if (fallbackRecent) {
      return fallbackRecent;
    }

    // 所有候选都年份错配时才认它：有歌可出优先于出不了题，
    // 但排在「近期重复过的正确歌曲」之后（那至少是同一部番的歌）。
    if (fallbackYear) {
      return fallbackYear;
    }

    // 最后才认翻唱：曲名对得上、可播放，但演唱者不是原唱。保留这条兜底是为了
    // 「有歌可出优先」——整池候选全是翻唱时（原版是会员专享且解灰失败），
    // 出题总比让整部番剧出不了题好。
    if (fallbackCover) {
      return fallbackCover;
    }

    throw new AppError("BANGUMI_NO_MUSIC", "该番剧没有可播放的关联歌曲");
  }

  /**
   * 用同一曲目的多个检索词并行回源，合并去重后只保留与曲目相关的候选。
   * 命中的判定同时接受「曲名命中」与「专辑名与原曲目名完全一致」——后者用于
   * 召回挂在整张原声带专辑下的官方原版（见 `isSongAlbumMatch`）。
   */
  private async searchAnimeTrackCandidates(
    provider: MusicProvider,
    queries: string[],
    track: BangumiMusicTrack,
    cookie: string | undefined,
    budget: { search: number },
    /** 带番剧名/中文名的检索词：命中它们的候选标记为「番剧上下文命中」。 */
    scopeQueries: readonly string[] = [],
  ): Promise<{ candidates: SongSearchResult[]; animeScopedIds: Set<string> }> {
    const searches = await Promise.all(queries.map(async (query) => {
      if (budget.search <= 0) return { query, results: [] as SongSearchResult[] };
      budget.search -= 1;
      try {
        return { query, results: await provider.search(query, ANIME_SONG_SEARCH_LIMIT, cookie) };
      } catch (error) {
        if (!isUnusableSongCandidate(error)) throw error;
        return { query, results: [] as SongSearchResult[] };
      }
    }));

    const merged = new Map<string, SongSearchResult>();
    const animeScopedIds = new Set<string>();
    for (const { query, results } of searches) {
      // 标记必须做在「已合并」判断**之前**：候选可能先在裸曲名检索里进池、
      // 之后才在带番剧名的检索里出现，那一次出现才是「属于本番」的证据。
      const scoped = scopeQueries.includes(query);
      for (const candidate of results) {
        if (scoped) animeScopedIds.add(candidate.id);
        if (merged.has(candidate.id)) continue;
        if (!isSongCandidateMatch(candidate, track.title)) continue;
        merged.set(candidate.id, candidate);
      }
    }
    return { candidates: [...merged.values()], animeScopedIds };
  }


/**
 * 「专辑型条目」的兜底解析：多检索词搜专辑，取最匹配那张的曲目。
 *
 * Bangumi 把大量资源挂成整张专辑条目（角色歌合辑 / 印象曲集 / OST / 精选集），
 * 条目名就是专辑名。这类条目按曲名检索必然无候选，按专辑名却能直接搜到；
 * 命中的专辑里的歌全部属于这部番，可以出题 —— 猜番模式下玩家猜的是番剧名，
 * 曲目名只用于结算展示，因此不必强求曲名与条目名一致。
 *
 * 仍然剔除专辑里的伴奏 / 纯音乐 / 现场 / 翻唱分轨（见 `isUnplayableAlbumTrack`），
 * 它们不是可出的原曲；剩下的顺序随机，避免每次都从专辑第一轨出题。
 */
  private async resolveAlbumTrackCandidates(
    provider: MusicProvider,
    track: BangumiMusicTrack,
    anime: BangumiSubjectDetails,
    cookie: string | undefined,
    budget: { search: number },
  ): Promise<SongSearchResult[]> {
    // 供应商不支持专辑能力时静默跳过（接口方法都是可选的）。
    if (!provider.searchAlbums || !provider.getAlbumSongs) return [];
    const animeNames = [anime.name, anime.nameCn].filter((name): name is string => Boolean(name));

    // 同一条目的多个检索词之间没有依赖，**必须并行回源**（与 searchAnimeTrackCandidates 一致）：
    // 串行发会把专辑路径变成 3~6 次顺序等待，自动出题的等待时间直接翻倍。
    const searches = await Promise.all(buildAlbumQueries(track, anime).map(async (query) => {
      if (budget.search <= 0) return [] as SongAlbumSearchResult[];
      budget.search -= 1;
      try {
        return await retryOnce(() => provider.searchAlbums!(query, ALBUM_SEARCH_LIMIT, cookie));
      } catch (error) {
        if (!isUnusableSongCandidate(error)) throw error;
        return [] as SongAlbumSearchResult[];
      }
    }));
    const collected: SongAlbumSearchResult[] = searches.flat();
    if (collected.length === 0) return [];

    const unique = new Map<string, SongAlbumSearchResult>();
    for (const album of collected) if (!unique.has(album.id)) unique.set(album.id, album);
    const trackArtists = track.artist ? normalizedArtists(track.artist) : new Set<string>();
    const artistHit = (album: SongAlbumSearchResult): boolean => {
      if (trackArtists.size === 0 || !album.artist) return false;
      const albumArtists = normalizedArtists(album.artist);
      return [...trackArtists].some((name) => albumArtists.has(name));
    };
    const album = [...unique.values()]
      .map((entry) => ({ entry, score: albumNameScore(entry.name, track.title, animeNames) }))
      .filter((item) => item.score > 0)
      // 同名专辑常有别人的版本，艺术家与 Bangumi 记录对得上的优先（数据集补录 artist
      // 之后这条才真正可用）；其余按名称相似度，序号命中因此能压过隔壁那张。
      .sort((left, right) =>
        Number(artistHit(right.entry)) - Number(artistHit(left.entry)) || right.score - left.score)
      .at(0)?.entry;
    if (!album || budget.search <= 0) return [];

    budget.search -= 1;
    let songs: SongSearchResult[];
    try {
      songs = await retryOnce(() => provider.getAlbumSongs!(album.id, cookie));
    } catch (error) {
      if (!isUnusableSongCandidate(error)) throw error;
      return [];
    }
    return shuffle(
      songs.filter((song) => !isUnplayableAlbumTrack(song.title)),
      this.random,
    );
  }

  /**
   * 番剧级兜底：条目级解析全部失败时，用番剧名检索单曲，只要歌确实属于这部番就出题。
   *
   * 为什么需要：Bangumi 的条目名可能既不是歌名、也与网易云的命名对不上
   * （《「クラスターエッジ」キャラクターコレクション》搜专辑一张都搜不到，但用番剧
   * **原名** `CLUSTER EDGE` 能搜出该番的《ココロのつぼみ》《FLY HIGH》）。
   *
   * 只保留两种能证明「属于本番」的候选：
   * - 专辑名含番剧名（任一形态）；
   * - 歌名与该番任一 Bangumi 曲目标题一致（跨条目互证）。
   *
   * 因此可能出到该番的**其它**曲目而非条目指名的那张专辑，这是有意的取舍：猜番模式下
   * 玩家猜的是番剧名，出一首确实属于该番的歌远好于整条出不了题。
   */
  private async resolveAnimeLevelCandidates(
    provider: MusicProvider,
    anime: BangumiSubjectDetails,
    cookie: string | undefined,
    budget: { search: number },
  ): Promise<SongSearchResult[]> {
    const animeNames = [anime.name, anime.nameCn].filter((name): name is string => Boolean(name));
    if (animeNames.length === 0) return [];
    // 同样并行回源（见 resolveAlbumTrackCandidates 的说明）：番剧名与中文名之间无依赖。
    const searches = await Promise.all(animeNames.map(async (name) => {
      if (budget.search <= 0) return [] as SongSearchResult[];
      budget.search -= 1;
      try {
        return await retryOnce(() => provider.search(name, ANIME_SONG_SEARCH_LIMIT, cookie));
      } catch (error) {
        if (!isUnusableSongCandidate(error)) throw error;
        return [] as SongSearchResult[];
      }
    }));
    const collected = new Map<string, SongSearchResult>();
    for (const found of searches) {
      for (const candidate of found) if (!collected.has(candidate.id)) collected.set(candidate.id, candidate);
    }
    const otherTrackTitles = anime.musicTracks.map((entry) => entry.title);
    const belongsToAnime = (candidate: SongSearchResult): boolean => {
      const album = candidate.album ?? "";
      if (animeNames.some((name) => album.includes(name))) return true;
      return otherTrackTitles.some((title) => isSongTitleMatch(candidate.title, title));
    };
    return shuffle([...collected.values()].filter(belongsToAnime), this.random);
  }

  private async resolveAnimeMatchedSongs(
    anime: BangumiSubjectDetails,
    connection: ConnectionRecord,
  ): Promise<BangumiSongCandidate[]> {
    const provider = this.options.musicProvider;
    const { room } = this.requireRoomPlayer(connection);
    const cookie = room.musicSession?.cookie;
    if (anime.musicTracks.length === 0) return [];

    const budget = { search: ANIME_SONG_SEARCH_BUDGET, detail: ANIME_SONG_DETAIL_BUDGET };
    const results: BangumiSongCandidate[] = [];
    const seenSongIds = new Set<string>();

    for (const track of anime.musicTracks) {
      if (budget.search <= 0) break;
      const queries: string[] = [];
      // 歌手名只在**足够短**时才拼进检索词：Bangumi 的 artist 常是整串声优列表
      // （「A、B、C、D、E、F」这种），拼进去等于把检索词毁掉，网易云什么都搜不到。
      // 这时退回番剧名（原名往往是英文，与中文 / 日文名都不一样）。
      const artistQuery = track.artist && track.artist.trim().length <= MAX_ARTIST_QUERY_LENGTH
        ? track.artist.trim()
        : "";
      if (artistQuery) queries.push(`${track.title} ${artistQuery}`);
      if (anime.name) queries.push(`${track.title} ${anime.name}`);
      if (anime.nameCn && anime.nameCn !== anime.name) queries.push(`${track.title} ${anime.nameCn}`);
      queries.push(track.title);
      const broadQueries = [
        anime.name ? `${track.title} ${anime.name}` : "",
        anime.nameCn && anime.nameCn !== anime.name ? `${track.title} ${anime.nameCn}` : "",
        track.title,
      ].filter((query) => query && !queries.includes(query));
      queries.push(...broadQueries);

      const scopeQueries = [
        anime.name ? `${track.title} ${anime.name}` : "",
        anime.nameCn && anime.nameCn !== anime.name ? `${track.title} ${anime.nameCn}` : "",
      ].filter(Boolean);

      let matchedCandidates: SongSearchResult[] = [];
      try {
        const matched = await this.searchAnimeTrackCandidates(provider, queries, track, cookie, budget, scopeQueries);
        matchedCandidates = matched.candidates
          .map((candidate, index) => {
            const options = { animeScoped: matched.animeScopedIds.has(candidate.id) };
            return {
              candidate,
              index,
              score: scoreAnimeSongCandidate(candidate, track, options),
              evidenced: hasAnimeSongEvidence(candidate, track, options),
            };
          })
          .filter((entry) => entry.evidenced)
          .sort((left, right) => right.score - left.score || left.index - right.index)
          .map((entry) => entry.candidate);
      } catch (error) {
        if (!isUnusableSongCandidate(error)) throw error;
      }

      if (matchedCandidates.length === 0 && isAlbumLikeTrackKind(track.kind)) {
        try {
          matchedCandidates = await this.resolveAlbumTrackCandidates(provider, track, anime, cookie, budget);
        } catch (error) {
          if (!isUnusableSongCandidate(error)) throw error;
        }
      }

      for (const song of matchedCandidates) {
        if (!seenSongIds.has(song.id)) {
          seenSongIds.add(song.id);
          const explicitKind = detectExplicitTrackKind(`${song.title} ${song.album ?? ""}`);
          results.push({
            track: explicitKind ? { ...track, kind: explicitKind } : track,
            song,
          });
          if (!isAlbumLikeTrackKind(track.kind)) break;
        }
      }
    }

    if (results.length === 0 && budget.search > 0) {
      try {
        const animeLevelSongs = await this.resolveAnimeLevelCandidates(provider, anime, cookie, budget);
        for (const song of animeLevelSongs) {
          if (!seenSongIds.has(song.id)) {
            seenSongIds.add(song.id);
            results.push({
              track: { title: song.title, artist: song.artist, kind: "theme" },
              song,
            });
          }
        }
      } catch (error) {
        if (!isUnusableSongCandidate(error)) throw error;
      }
    }

    return results;
  }

  private refineTrackKind(kind: BangumiMusicTrackKind, song: SongDetails): BangumiMusicTrackKind {
    const text = `${song.title} ${song.album ?? ""} ${song.encyclopedia.tags.join(" ")}`;
    // 歌曲元数据里指向具体主题曲类型的信号（片头 / 片尾 / 插入歌），优先级高于
    // Bangumi 关联条目的粗分类。Bangumi 常把官方 MV、单曲碟等归到「其他 → 主题曲」，
    // 也常把片尾曲的专辑条目挂在「插入歌」下；此时以歌曲自身标注为准，
    // 否则会出现「片尾曲的歌配着插曲徽章」这类错配。
    const explicitKind = detectExplicitTrackKind(text);
    if (explicitKind) return explicitKind;
    if (kind !== "theme") return kind;
    if (/原声|soundtrack|\bost\b/i.test(text)) return "ost";
    if (/角色[歌曲]|character(?:\s*song)?/i.test(text)) return "character";
    if (/\bremix\b|重混/i.test(text)) return "remix";
    if (/同人/i.test(text)) return "doujin";
    if (/印象[曲歌]|image(?:\s*song)?/i.test(text)) return "image";
    if (/vocaloid/i.test(text)) return "vocaloid";
    if (/\bdrama\b|广播剧|廣播劇/i.test(text)) return "drama";
    if (/\bvocal\b/i.test(text)) return "vocal";
    if (/\bradio\b|广播|廣播/i.test(text)) return "radio";
    if (/\barrange\b|改编|改編|编曲|編曲/i.test(text)) return "arrange";
    if (/单曲|單曲|\bsingle\b/i.test(text)) return "single";
    if (/精选|精選|\bbest\b|collection/i.test(text)) return "collection";
    if (/朗读|朗讀/i.test(text)) return "reading";
    if (/艺人|藝人|album/i.test(text)) return "artistAlbum";
    return kind;
  }

  private installRound(
    room: SonGuessrRoomRecord,
    song: SongDetails,
    submitterPlayerId: string,
    anime?: BangumiSubjectDetails,
    animeTrack?: BangumiMusicTrack,
    /**
     * 本回合「最近不出」集合的长度。只有自动选曲知道候选池规模并按池子自适应，
     * 手动出题与猜番没有候选池概念，沿用 `MIN_RECENT_SONG_WINDOW`。
     * 必须在 `installRound` 之前用同一数值过滤候选，否则写入与排除的口径会不一致。
     */
    recentSongWindow = MIN_RECENT_SONG_WINDOW,
  ): number {
    this.applyQueuedMemberships(room);
    if (!room.solo && this.activePlayers(room).filter((candidate) => candidate.online).length < 2) {
      throw new AppError("NOT_ENOUGH_PLAYERS", "下一轮至少需要两名在线正式玩家");
    }
    const lyricClip = createSongLyricClip(
      song.lyrics,
      room.settings.lyricsLineCount,
      this.random,
      song.durationMs,
    );
    const roundNumber = room.roundNumber + 1;
    const roundSettings = cloneSettings(room.settings);
    const participantStates = Object.fromEntries(
      this.activePlayers(room).map((candidate) => [
        candidate.id,
        {
          audioReady: candidate.isBot,
          guessesUsed: candidate.isBot ? roundSettings.maxGuessesPerRound : 0,
          correct: false,
          gaveUp: candidate.isBot,
        } satisfies SonGuessrRoundPlayerState,
      ]),
    );
    room.roundNumber = roundNumber;
    room.currentRound = {
      number: roundNumber,
      submitterPlayerId,
      song,
      anime,
      animeTrack,
      lyricClip,
      attempts: [],
      correctPlayerIds: [],
      startScores: Object.fromEntries(Object.values(room.players).map((candidate) => [candidate.id, candidate.score])),
      players: participantStates,
      settings: roundSettings,
      audioPreparationDeadlineAt: this.now() + AUDIO_READY_GRACE_MS,
      audioReadyDeadlineAt: undefined,
      hardDeadlineAt: undefined,
    };
    room.pendingSubmitterPlayerId = undefined;
    room.roundSummary = undefined;
    room.phase = "playing";

    const recentSongIds = room.recentSongIds ?? [];
    room.recentSongIds = [song.id, ...recentSongIds.filter((id) => id !== song.id)]
      .slice(0, recentSongWindow);
    if (anime) {
      const recentSubjectIds = room.recentSubjectIds ?? [];
      room.recentSubjectIds = [anime.id, ...recentSubjectIds.filter((id) => id !== anime.id)].slice(0, 10);
    }

    this.appendSystemMessage(room, `第 ${roundNumber} 轮开始`);
    return roundNumber;
  }

  private async startAutomaticRound(room: SonGuessrRoomRecord, verify: () => void): Promise<void> {
    if (room.settings.questionType === "anime") {
      const provider = this.options.bangumiProvider;
      if (!provider) throw new AppError("BANGUMI_API_UNAVAILABLE", "当前未配置 Bangumi 接口");
      const filters = room.settings.animeAutoFilters ?? {};
      const poolSize = Math.min(filters.subjectLimit ?? 50, 50);
      const year = filters.ranking === "year" && filters.startYear && filters.endYear
        ? filters.startYear + this.random.nextInt(filters.endYear - filters.startYear + 1)
        : undefined;
      const candidates = await provider.searchSubjects("", poolSize, year ? {
        ...filters,
        startYear: year,
        endYear: year,
      } : filters);
      const recentSubjectIds = new Set(room.recentSubjectIds ?? []);
      const freshCandidates = candidates.filter((c) => !recentSubjectIds.has(c.id));
      const pool = freshCandidates.length > 0 ? [...freshCandidates] : [...candidates];
      let attempts = 0;
      while (pool.length > 0 && attempts < AUTO_ANIME_CANDIDATE_LIMIT) {
        attempts += 1;
        const selected = pool.splice(this.random.nextInt(pool.length), 1)[0];
        try {
          const anime = await provider.getSubject(selected.id);
          const resolved = await this.resolveAnimeSong(room, anime);
          verify();
          this.installRound(room, resolved.song, "", anime, resolved.track);
          return;
        } catch (error) {
          if (!isUnusableSongCandidate(error)
            && !(error instanceof AppError && ["BANGUMI_NO_MUSIC", "BANGUMI_NOT_FOUND"].includes(error.code))) throw error;
        }
      }
      throw new AppError("BANGUMI_NO_MUSIC", "筛选结果中没有可播放关联歌曲的番剧");
    }
    const candidates = await this.resolveAutomaticCandidates(room);
    if (candidates.length === 0) {
      throw new AppError("AUTO_NO_MATCH", "没有符合当前筛选条件的歌曲");
    }
    // 候选池不再按会员状态预剔除：会员专享曲会由 `getSong` 的解灰链路取回完整音频，
    // 能否出题以「实际拿到的音频」为准，不再看账号是不是会员。
    // 窗口长度取自整池而不是「扣掉近期后的剩余」，否则窗口会依赖自己的结果：
    // 池子被扣小时窗口跟着缩，等价于每回合都在放宽去重。必须先用整池定长度，再排除。
    const recentSongWindow = resolveRecentSongWindow(candidates.length);
    const recentSongIds = new Set((room.recentSongIds ?? []).slice(0, recentSongWindow));
    const freshCandidates = candidates.filter((song) => !recentSongIds.has(song.id));
    const pool = [...(freshCandidates.length > 0 ? freshCandidates : candidates)];
    let attempts = 0;
    while (pool.length > 0 && attempts < AUTO_SONG_CANDIDATE_LIMIT) {
      attempts += 1;
      const selected = pool.splice(this.random.nextInt(pool.length), 1)[0];
      let song: SongDetails;
      try {
        song = await this.options.musicProvider.getSong(selected.id, room.musicSession?.cookie);
      } catch (error) {
        if (!isUnusableSongCandidate(error)) throw error;
        continue;
      }
      verify();
      this.installRound(room, song, "", undefined, undefined, recentSongWindow);
      return;
    }
    throw new AppError("SONG_UNAVAILABLE", "筛选结果中没有可播放的歌曲，请更换题库或稍后重试");
  }

  private async resolveAutomaticCandidates(room: SonGuessrRoomRecord): Promise<SongSearchResult[]> {
    const filters = room.settings.autoFilters;
    const cookie = room.musicSession?.cookie;
    const sets: SongSearchResult[][] = [];
    if (filters.playlist && this.options.musicProvider.getPlaylistSongs) {
      sets.push((await this.options.musicProvider.getPlaylistSongs(filters.playlist.id, cookie)).songs);
    }
    if (filters.artists.length > 0 && this.options.musicProvider.getArtistSongs) {
      const artistSongs = await Promise.all(filters.artists.map((artist) =>
        this.options.musicProvider.getArtistSongs!(artist.id, cookie)));
      sets.push(artistSongs.flat());
    }
    if (sets.length === 0) {
      if (!this.options.musicProvider.getPlaylistSongs) {
        throw new AppError("MUSIC_API_UNAVAILABLE", "当前音乐 API 不支持自动题库");
      }
      sets.push((await this.options.musicProvider.getPlaylistSongs(
        DEFAULT_AUTO_PLAYLIST_ID,
        cookie,
      )).songs);
    }
    const first = new Map(sets[0].map((song) => [song.id, song]));
    for (const set of sets.slice(1)) {
      const ids = new Set(set.map((song) => song.id));
      for (const id of first.keys()) if (!ids.has(id)) first.delete(id);
    }
    const candidates = [...first.values()];
    if (filters.minPopularity === 0) return candidates;
    const knownMatches = candidates.filter(
      (song) => song.popularity !== undefined && song.popularity >= filters.minPopularity,
    );
    if (knownMatches.length > 0) return knownMatches;

    const getPopularity = this.options.musicProvider.getSongPopularity;
    if (!getPopularity) {
      return [];
    }

    // 大歌单不能逐首回源查询热度。随机抽取有限候选，缓存命中仍可复用，
    // 冷缓存下单轮最多发起固定数量的上游请求，避免限流恢复后继续堆积。
    const lookupPool = [...candidates];
    const sampled: SongSearchResult[] = [];
    while (lookupPool.length > 0 && sampled.length < AUTO_POPULARITY_LOOKUP_LIMIT) {
      sampled.push(lookupPool.splice(this.random.nextInt(lookupPool.length), 1)[0]);
    }

    const enriched: SongSearchResult[] = [];
    for (let index = 0; index < sampled.length; index += 4) {
      const batch = sampled.slice(index, index + 4);
      const values = await Promise.all(batch.map(async (song) => ({
        ...song,
        popularity: await getPopularity.call(this.options.musicProvider, song.id, cookie) ?? song.popularity,
      })));
      enriched.push(...values);
    }
    return enriched.filter((song) => (song.popularity ?? 0) >= filters.minPopularity);
  }

  /**
   * 首名玩家真正具备答题条件时，才锚定本回合的「音频就绪宽限期」与「硬截止」。
   * 幂等：同一回合只锚定一次，后续玩家就绪不会顺延其他玩家的倒计时。
   */
  private armRoundDeadlines(room: SonGuessrRoomRecord) {
    const round = room.currentRound;
    if (!round || round.hardDeadlineAt !== undefined) return;
    const now = this.now();
    round.audioReadyDeadlineAt = now + AUDIO_READY_GRACE_MS;
    round.hardDeadlineAt = now + (round.settings.guessDurationSeconds + ROUND_HARD_TIMEOUT_MARGIN_S) * 1_000;
  }

  private audioReady(connection: ConnectionRecord, roundNumber: number) {
    const { room, player } = this.requireRoomPlayer(connection);
    // 页面切后台/重连时可能补发旧回合的 ready；状态过渡期间应幂等忽略，
    // 不把一个正常的陈旧通知显示成「当前没有进行中的回合」。
    if (room.phase !== "playing" || !room.currentRound || room.automaticRoundLoading) {
      return { ignored: true };
    }
    const round = room.currentRound;
    if (round.number !== roundNumber) return { ignored: true };
    const state = this.ensureRoundPlayerState(room, player) ?? round.players[player.id];
    if (
      !state ||
      (player.id === round.submitterPlayerId && !this.canTestSubmitterGuess(room, player.id)) ||
      player.membership !== "active"
    ) {
      return { ignored: true };
    }
    if (
      !state.audioReady &&
      !state.correct &&
      !state.gaveUp &&
      state.guessesUsed < round.settings.maxGuessesPerRound
    ) {
      // 首个就绪的玩家定义本回合的倒计时起点；此时才锚定硬截止。
      this.armRoundDeadlines(room);
      state.audioReady = true;
      // 必须用「当前时刻」起算，不能复用本回合统一的 audioReadyDeadlineAt：
      // 自动选曲会占用数秒到数十秒，用旧锚点会得到一个可能已过期的截止时刻，
      // 巡检随即把它当成答题超时，玩家还没数到 0 就被判超时。
      this.restartGuessDeadline(room, state);
    }
    this.touch(room);
    this.publishPrivateState(room, player);
    return { deadlineAt: state.deadlineAt };
  }

  private async audioFailed(connection: ConnectionRecord, roundNumber: number) {
    const { room, player } = this.requireRoomPlayer(connection);
    const round = room.currentRound;
    if (room.phase !== "playing" || !round || round.number !== roundNumber) return { ignored: true };
    if (player.membership !== "active" || (player.id === round.submitterPlayerId && !this.canTestSubmitterGuess(room, player.id))) {
      return { ignored: true };
    }
    // 刷新播放地址同样命中那个共享的上游实例，必须一起计入配额。
    if (!this.musicLimiter.allow(connection.id, this.now())) {
      throw new AppError("RATE_LIMITED", "音乐请求过于频繁，请稍后再试");
    }
    const refresh = this.options.musicProvider.refreshSongAudio;
    if (!refresh) throw new AppError("MUSIC_API_UNAVAILABLE", "当前音乐 API 不支持刷新播放地址");
    const audioUrl = await refresh.call(this.options.musicProvider, round.song.id, room.musicSession?.cookie);
    if (room.phase !== "playing" || room.currentRound !== round) return { ignored: true };
    round.song.audioUrl = audioUrl;
    this.touch(room);
    this.publishRoom(room);
    return { refreshed: true };
  }

  private async guess(connection: ConnectionRecord, songId: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireActiveRound(room);
    if (player.membership !== "active") throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能猜歌");
    const state = this.ensureRoundPlayerState(room, player) ?? round.players[player.id];
    if (player.id === round.submitterPlayerId && !this.canTestSubmitterGuess(room, player.id)) {
      throw new AppError("SUBMITTER_CANNOT_GUESS", "出题人不能参与猜歌");
    }
    if (!state.audioReady) throw new AppError("AUDIO_NOT_READY", "音频尚未准备完成");
    if (state.correct) throw new AppError("ALREADY_CORRECT", "你已经猜对了");
    if (state.gaveUp) throw new AppError("ALREADY_GAVE_UP", "你已经放弃本回合");
    if (state.inFlight) throw new AppError("GUESS_IN_PROGRESS", "正在校验上一次猜测，请稍候");
    if (state.guessesUsed >= round.settings.maxGuessesPerRound) throw new AppError("NO_MORE_GUESSES", "本回合猜测次数已用完");

    if (state.deadlineAt !== undefined && state.deadlineAt <= this.now()) {
      this.recordTimeout(room, player.id);
      if (this.isRoundComplete(room)) this.finishRound(room);
      this.publishRoom(room);
      throw new AppError("GUESS_TIMEOUT", "本次猜测已经超时");
    }

    // 关键修复：在让出事件循环前先占位自增并加锁，防止并发穿透配额上限
    state.inFlight = true;
    state.guessesUsed += 1;
    player.totalGuesses += 1;

    let guessedSong: SongDetails;
    try {
      guessedSong = await this.options.musicProvider.getSongMetadata(
        songId,
        room.musicSession?.cookie,
      );
    } catch (error) {
      if (room.phase === "playing" && room.currentRound === round) {
        state.guessesUsed = Math.max(0, state.guessesUsed - 1);
        player.totalGuesses = Math.max(0, player.totalGuesses - 1);
      }
      state.inFlight = false;
      throw error;
    }

    // 异步返回后复验房间与回合状态
    if (room.phase !== "playing" || room.currentRound !== round || player.membership !== "active") {
      state.inFlight = false;
      throw new AppError("ROUND_EXPIRED", "该回合已结束");
    }
    state.inFlight = false;
    const correct = this.isCorrectSong(guessedSong, round.song);
    const attempt: SongGuessAttempt = {
      id: this.createId("song_guess"),
      playerId: player.id,
      playerName: player.name,
      guessNumber: state.guessesUsed,
      createdAt: this.now(),
      result: correct ? "correct" : "wrong",
      guessedSong: this.publicSong(guessedSong),
      feedback: this.buildFeedback(guessedSong, round.song),
    };
    round.attempts.push(attempt);

    if (correct) {
      state.correct = true;
      state.deadlineAt = undefined;
      player.correctGuesses += 1;
      const formalPlayerCount = this.activePlayers(room).length;
      player.score += round.settings.bloodMode
        ? formalPlayerCount - round.correctPlayerIds.length
        : SCORING.correct;
      round.correctPlayerIds.push(player.id);
    } else {
      this.restartGuessDeadline(room, state);
    }

    if (this.isRoundComplete(room)) {
      this.finishRound(room);
    }
    this.touch(room);
    this.publishRoom(room);
    return {
      attempt,
      remainingGuesses: Math.max(0, round.settings.maxGuessesPerRound - state.guessesUsed),
    };
  }

  private async guessAnime(connection: ConnectionRecord, subjectId: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireActiveRound(room);
    if (room.settings.questionType !== "anime" || !round.anime) {
      throw new AppError("INVALID_QUESTION_TYPE", "当前房间不是听歌猜番模式");
    }
    const state = this.ensureRoundPlayerState(room, player) ?? round.players[player.id];
    if (!state || player.membership !== "active") throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能猜番");
    if (player.id === round.submitterPlayerId && !this.canTestSubmitterGuess(room, player.id)) {
      throw new AppError("SUBMITTER_CANNOT_GUESS", "出题人不能参与猜番");
    }
    if (!state.audioReady) throw new AppError("AUDIO_NOT_READY", "音频尚未准备完成");
    if (state.correct) throw new AppError("ALREADY_CORRECT", "你已经猜对了");
    if (state.gaveUp) throw new AppError("ALREADY_GAVE_UP", "你已经放弃本回合");
    if (state.inFlight) throw new AppError("GUESS_IN_PROGRESS", "正在校验上一次猜测，请稍候");
    if (state.guessesUsed >= round.settings.maxGuessesPerRound) throw new AppError("NO_MORE_GUESSES", "本回合猜测次数已用完");
    if (state.deadlineAt !== undefined && state.deadlineAt <= this.now()) {
      this.recordTimeout(room, player.id);
      if (this.isRoundComplete(room)) this.finishRound(room);
      this.publishRoom(room);
      throw new AppError("GUESS_TIMEOUT", "本次猜测已经超时");
    }

    const provider = this.options.bangumiProvider;
    if (!provider) throw new AppError("BANGUMI_API_UNAVAILABLE", "当前未配置 Bangumi 接口");
    state.inFlight = true;
    state.guessesUsed += 1;
    player.totalGuesses += 1;
    let guessedAnime: BangumiSubjectDetails;
    try {
      guessedAnime = await provider.getSubject(subjectId);
    } catch (error) {
      if (room.phase === "playing" && room.currentRound === round) {
        state.guessesUsed = Math.max(0, state.guessesUsed - 1);
        player.totalGuesses = Math.max(0, player.totalGuesses - 1);
      }
      state.inFlight = false;
      throw error;
    }
    if (room.phase !== "playing" || room.currentRound !== round || player.membership !== "active") {
      state.inFlight = false;
      throw new AppError("ROUND_EXPIRED", "该回合已结束");
    }
    state.inFlight = false;
    const correct = guessedAnime.id === round.anime.id;
    const attempt: SongGuessAttempt = {
      id: this.createId("song_guess"),
      playerId: player.id,
      playerName: player.name,
      guessNumber: state.guessesUsed,
      createdAt: this.now(),
      result: correct ? "correct" : "wrong",
      guessedAnime: this.publicAnime(guessedAnime),
    };
    round.attempts.push(attempt);
    if (correct) {
      state.correct = true;
      state.deadlineAt = undefined;
      player.correctGuesses += 1;
      const formalPlayerCount = this.activePlayers(room).length;
      player.score += round.settings.bloodMode
        ? formalPlayerCount - round.correctPlayerIds.length
        : SCORING.correct;
      round.correctPlayerIds.push(player.id);
    } else {
      this.restartGuessDeadline(room, state);
    }
    if (this.isRoundComplete(room)) this.finishRound(room);
    this.touch(room);
    this.publishRoom(room);
    return {
      attempt,
      remainingGuesses: Math.max(0, round.settings.maxGuessesPerRound - state.guessesUsed),
    };
  }

  private giveUp(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireActiveRound(room);
    const state = this.ensureRoundPlayerState(room, player) ?? round.players[player.id];
    if (!state || player.membership !== "active") {
      throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能执行猜歌操作");
    }
    if (player.id === round.submitterPlayerId && !this.canTestSubmitterGuess(room, player.id)) {
      throw new AppError("SUBMITTER_CANNOT_GIVE_UP", "出题人无需放弃");
    }
    if (state.inFlight) throw new AppError("GUESS_IN_PROGRESS", "正在校验上一次猜测，请稍候");
    if (state.correct) throw new AppError("ALREADY_CORRECT", "你已经猜对了");
    if (state.gaveUp || state.guessesUsed >= round.settings.maxGuessesPerRound) {
      throw new AppError("ROUND_ACTION_FINISHED", "你已完成本回合操作");
    }

    state.gaveUp = true;
    state.deadlineAt = undefined;
    round.attempts.push({
      id: this.createId("song_guess"),
      playerId: player.id,
      playerName: player.name,
      guessNumber: state.guessesUsed + 1,
      createdAt: this.now(),
      result: "gaveUp",
    });
    if (this.isRoundComplete(room)) this.finishRound(room);
    this.touch(room);
    this.publishRoom(room);
    return { gaveUp: true };
  }

  private skipRound(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    this.requireActiveRound(room);
    // 跳过不参与结算：出题人拿不到任何奖励，避免「选出题人 → 立刻跳过」的零成本刷分。
    this.finishRound(room, true);
    this.publishRoom(room);
    this.publishLobby();
    return { skipped: true };
  }

  private async nextRound(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (room.phase !== "roundResult") throw new AppError("INVALID_PHASE", "当前不在回合结算阶段");
    const previousRound = room.currentRound;
    const previousSummary = room.roundSummary;
    if (room.solo || room.settings.questionMode === "automatic") {
      if (room.automaticRoundLoading) throw new AppError("ROUND_BUSY", "正在准备下一回合");
      const operation = Symbol("automaticRound");
      room.automaticRoundOperation = operation;
      room.automaticRoundLoading = true;
      const isCurrent = () => this.rooms.get(room.id) === room
        && room.automaticRoundOperation === operation
        && room.phase === "roundResult" && room.currentRound === previousRound
        && room.hostPlayerId === player.id && player.online
        && connection.roomId === room.id && connection.playerId === player.id;
      const verify = () => {
        if (!isCurrent()) throw new AppError("ROUND_EXPIRED", "出题操作已失效");
      };
      try {
        this.applyQueuedMemberships(room);
        if (!room.solo && this.activePlayers(room).filter((candidate) => candidate.online).length < 2) {
          room.currentRound = undefined;
          room.roundSummary = undefined;
          room.pendingSubmitterPlayerId = undefined;
          room.phase = "waiting";
          this.resetReadyState(room);
          this.touch(room);
          this.publishRoom(room);
          this.publishLobby();
          return { nextRound: room.roundNumber + 1, waiting: true };
        }
        await this.startAutomaticRound(room, verify);
      } catch (error) {
        // 自动题库临时失败时保留答案页，房主可以重试或回到等待阶段，
        // 不能留下既没有 currentRound 也没有 roundSummary 的悬空状态。
        if (isCurrent()) {
          room.currentRound = previousRound;
          room.roundSummary = previousSummary;
          room.phase = "roundResult";
        }
        throw error;
      } finally {
        if (room.automaticRoundOperation === operation) {
          room.automaticRoundOperation = undefined;
          room.automaticRoundLoading = false;
        }
      }
    } else {
      if (room.manualRoundStarting) throw new AppError("ROUND_BUSY", "正在准备下一回合");
      room.manualRoundStarting = true;
      try {
        const previousSubmitterId = previousRound?.submitterPlayerId;
        room.currentRound = undefined;
        room.roundSummary = undefined;
        this.applyQueuedMemberships(room);
        if (!room.solo && this.activePlayers(room).filter((candidate) => candidate.online).length < 2) {
          room.pendingSubmitterPlayerId = undefined;
          room.phase = "waiting";
          this.resetReadyState(room);
          this.touch(room);
          this.publishRoom(room);
          this.publishLobby();
          return { nextRound: room.roundNumber + 1, waiting: true };
        }
        if (room.settings.autoRotateSubmitter) {
          const nextSubmitter = this.nextRotatingSubmitter(room, previousSubmitterId);
          if (nextSubmitter) {
            room.pendingSubmitterPlayerId = nextSubmitter.id;
            room.phase = "submittingSong";
          } else {
            room.phase = "choosingSubmitter";
          }
        } else {
          room.phase = "choosingSubmitter";
        }
      } finally {
        room.manualRoundStarting = false;
      }
    }
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return { nextRound: room.roundNumber + 1 };
  }

  private finishGame(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (room.phase !== "roundResult") throw new AppError("INVALID_PHASE", "只能在回合结算后返回等待阶段");
    room.automaticRoundOperation = undefined;
    room.automaticRoundLoading = false;
    room.phase = "waiting";
    room.pendingSubmitterPlayerId = undefined;
    room.currentRound = undefined;
    room.roundSummary = undefined;
    room.finalScores = undefined;
    this.applyQueuedMemberships(room);
    this.resetReadyState(room);
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return { waiting: true, roundNumber: room.roundNumber };
  }

  /**
   * 保证处于进行中回合的正式非出题玩家持有合法的回合状态（自愈机制）。
   * 覆盖场景：切轮瞬间短暂断线、重连或状态异步，杜绝玩家缺失回合状态被误判为操作完成。
   */
  private ensureRoundPlayerState(
    room: SonGuessrRoomRecord,
    player: SonGuessrPlayerRecord,
  ): SonGuessrRoundPlayerState | undefined {
    if (room.phase !== "playing" || !room.currentRound) return undefined;
    const round = room.currentRound;
    if (player.membership !== "active") return undefined;
    if (player.id === round.submitterPlayerId && !this.canTestSubmitterGuess(room, player.id)) {
      return undefined;
    }
    let state = round.players[player.id];
    if (!state) {
      state = {
        audioReady: false,
        guessesUsed: 0,
        correct: false,
        gaveUp: false,
        deadlineAt: undefined,
      };
      round.players[player.id] = state;
    }
    return state;
  }

  private recordTimeout(room: SonGuessrRoomRecord, playerId: string) {
    const round = room.currentRound;
    const state = round?.players[playerId];
    const player = room.players[playerId];
    if (!round || !state || !player || state.correct || state.gaveUp) return;
    if (state.guessesUsed >= round.settings.maxGuessesPerRound) return;

    state.guessesUsed += 1;
    player.totalGuesses += 1;
    round.attempts.push({
      id: this.createId("song_guess"),
      playerId,
      playerName: player.name,
      guessNumber: state.guessesUsed,
      createdAt: this.now(),
      result: "timeout",
    });
    this.restartGuessDeadline(room, state);
  }

  /**
   * 重开一次猜测倒计时。倒计时的锚点必须永远取「当前时刻」，且不得超过回合硬截止：
   * 用旧锚点（如本回合统一的 audioReadyDeadlineAt）续期，会得到一个可能已经过期的时刻，
   * 巡检随即把它当成一次「答题超时」——玩家的倒计时还没归零就被判超时，
   * 或者归零后要等下一轮 10 秒巡检才真正结算。
   */
  private restartGuessDeadline(room: SonGuessrRoomRecord, state: SonGuessrRoundPlayerState) {
    const round = room.currentRound;
    if (
      !round ||
      !round.settings.showGuessTimer ||
      state.correct ||
      state.gaveUp ||
      state.guessesUsed >= round.settings.maxGuessesPerRound
    ) {
      state.deadlineAt = undefined;
      return;
    }
    const deadlineAt = this.now() + round.settings.guessDurationSeconds * 1_000;
    // 单次猜测的倒计时绝不能越过回合硬截止，否则玩家的可见倒计时会长于真实剩余时间：
    // 界面显示还剩数十秒，房间却已经强制结算。
    state.deadlineAt =
      round.hardDeadlineAt === undefined ? deadlineAt : Math.min(deadlineAt, round.hardDeadlineAt);
  }

  /**
   * @param skipped 房主直接跳过本回合。跳过不是「无人猜中」，
   *   而是「这一轮没有真正发生过」，因此不计出题人奖励 ——
   *   否则房主反复「选出题人 → 立刻跳过」就能零成本刷分。
   */
  private finishRound(room: SonGuessrRoomRecord, skipped = false) {
    const round = room.currentRound;
    if (!round || room.phase !== "playing") return;
    const submitter = room.players[round.submitterPlayerId];
    if (submitter && !skipped) {
      submitter.score += round.correctPlayerIds.length > 0
        ? round.correctPlayerIds.length * SCORING.submitterPerCorrect
        : SCORING.submitterNobodyCorrect;
    }

    for (const state of Object.values(round.players)) state.deadlineAt = undefined;
    room.roundSummary = {
      roundNumber: round.number,
      song: {
        ...this.publicSong(round.song),
        audioUrl: round.song.audioUrl,
        chorus: round.song.chorus,
        releaseYear: round.song.releaseYear,
        popularity: round.song.popularity,
        language: round.song.language,
        encyclopedia: round.song.encyclopedia,
      },
      ...(round.anime ? { anime: this.publicAnime(round.anime) } : {}),
      ...(round.animeTrack ? { animeTrack: round.animeTrack } : {}),
      submitterPlayerId: round.submitterPlayerId,
      correctPlayerIds: [...round.correctPlayerIds],
      attempts: [...round.attempts],
      scores: this.buildScores(room, round.startScores),
    };
    room.phase = "roundResult";
    this.touch(room);
    this.log("song.game.round_finished", room.id, round.submitterPlayerId, {
      roundNumber: round.number,
      correctCount: round.correctPlayerIds.length,
    });
  }

  private buildFeedback(guess: SongDetails, answer: SongDetails): SongGuessFeedback {
    const answerTags = new Set(answer.encyclopedia.tags.map((tag) => tag.toLowerCase()));
    return {
      releaseYear: guess.releaseYear,
      releaseYearDirection: direction(guess.releaseYear, answer.releaseYear),
      popularity: guess.popularity,
      popularityDirection: direction(guess.popularity, answer.popularity),
      languageMatch:
        guess.language && answer.language
          ? normalizeSongText(guess.language) === normalizeSongText(answer.language)
          : undefined,
      sharedTags: guess.encyclopedia.tags.filter((tag) => answerTags.has(tag.toLowerCase())),
    };
  }

  private isCorrectSong(guess: SongDetails, answer: SongDetails) {
    if (guess.id === answer.id) return true;
    if (normalizeSongTitle(guess.title) !== normalizeSongTitle(answer.title)) return false;
    const answerArtists = normalizedArtists(answer.artist);
    return [...normalizedArtists(guess.artist)].some((artist) => answerArtists.has(artist));
  }

  private applyQueuedMemberships(room: SonGuessrRoomRecord) {
    for (const player of Object.values(room.players)) {
      const membership = player.nextRoundMembership;
      if (!membership || player.membership === "kicked") continue;
      if (membership === "spectator" && !room.allowSpectators) continue;
      if (membership === "active" && !player.online) continue;
      player.nextRoundMembership = undefined;
      player.membership = membership;
      player.isReady = membership === "active" && (player.id === room.hostPlayerId || player.isBot);
    }
  }

  private resetReadyState(room: SonGuessrRoomRecord) {
    for (const candidate of Object.values(room.players)) {
      candidate.isReady = candidate.membership === "active" &&
        (candidate.id === room.hostPlayerId || candidate.isBot);
    }
  }

  private nextRotatingSubmitter(room: SonGuessrRoomRecord, previousSubmitterId?: string) {
    const candidates = Object.values(room.players)
      .filter((player) => player.online && player.membership === "active" && !player.isBot)
      .sort((left, right) => left.joinedAt - right.joinedAt);
    if (candidates.length === 0) return undefined;
    const previousIndex = candidates.findIndex((player) => player.id === previousSubmitterId);
    return candidates[(previousIndex + 1 + candidates.length) % candidates.length];
  }

  private canTestSubmitterGuess(room: SonGuessrRoomRecord, playerId: string) {
    return Boolean(
      this.isTestRoom(room) &&
      room.currentRound?.submitterPlayerId === playerId &&
      room.players[playerId]?.membership === "active",
    );
  }

  private isRoundComplete(room: SonGuessrRoomRecord) {
    const round = room.currentRound;
    if (!round) return false;
    const guessers = this.activePlayers(room).filter(
      (player) =>
        player.id !== round.submitterPlayerId || this.canTestSubmitterGuess(room, player.id),
    );
    return guessers.every((player) => {
      const state = round.players[player.id];
      return !state || state.correct || state.gaveUp || state.guessesUsed >= round.settings.maxGuessesPerRound;
    });
  }

  private buildRoomSummary(room: SonGuessrRoomRecord): SonGuessrRoomSummary {
    const activeCount = Object.values(room.players).filter(
      (player) => player.membership === "active" && player.online,
    ).length;
    const spectatorCount = Object.values(room.players).filter(
      (player) => player.membership === "spectator" && player.online,
    ).length;
    return {
      roomId: room.id,
      name: room.name,
      visibility: room.visibility,
      allowSpectators: room.allowSpectators,
      hasPassword: Boolean(room.password),
      playerCount: activeCount,
      spectatorCount,
      onlineCount: activeCount + spectatorCount,
      phase: room.phase,
      questionType: room.settings.questionType,
    };
  }

  private buildRoomSnapshot(room: SonGuessrRoomRecord): SonGuessrRoomSnapshot {
    const round = room.currentRound;
    return {
      roomId: room.id,
      name: room.name,
      solo: room.solo,
      visibility: room.visibility,
      allowSpectators: room.allowSpectators,
      hasPassword: Boolean(room.password),
      hostPlayerId: room.hostPlayerId,
      testMode: this.isTestRoom(room),
      musicAccountReady: Boolean(room.musicSession),
      settings: room.settings,
      phase: room.phase,
      roundNumber: room.roundNumber,
      pendingSubmitterPlayerId: room.pendingSubmitterPlayerId,
      currentRound:
        room.phase === "playing" && round
          ? {
              roundNumber: round.number,
              submitterPlayerId: round.submitterPlayerId,
              audioUrl: round.song.audioUrl,
              lyricClip: room.settings.showLyrics
                ? round.lyricClip
                : { ...round.lyricClip, lines: [] },
            }
          : undefined,
      players: Object.values(room.players)
        .filter((player) => player.membership !== "kicked")
        .sort((left, right) => left.joinedAt - right.joinedAt)
        .map((player) => this.buildPlayerView(room, player)),
      chat: room.chat,
      ...(room.roundSummary ? { roundSummary: room.roundSummary } : {}),
      ...(room.finalScores ? { finalScores: room.finalScores } : {}),
    };
  }

  private buildPlayerView(
    room: SonGuessrRoomRecord,
    player: SonGuessrPlayerRecord,
  ): SonGuessrPlayerView {
    this.ensureRoundPlayerState(room, player);
    const round = room.currentRound;
    const state = round?.players[player.id];
    let roundStatus: SonGuessrPlayerView["roundStatus"] = "waiting";
    if (round?.submitterPlayerId === player.id) roundStatus = "submitter";
    else if (player.membership === "spectator") roundStatus = "spectator";
    else if (state?.correct) roundStatus = "correct";
    else if (
      state &&
      (state.gaveUp || state.guessesUsed >= (round?.settings.maxGuessesPerRound ?? room.settings.maxGuessesPerRound))
    ) roundStatus = "finished";
    else if (room.phase === "playing" && state) roundStatus = "guessing";

    return {
      id: player.id,
      name: player.name,
      score: player.score,
      membership: player.membership,
      nextRoundMembership: player.nextRoundMembership,
      online: player.online,
      isReady: player.isReady,
      isBot: player.isBot,
      isHost: room.hostPlayerId === player.id,
      correctGuesses: player.correctGuesses,
      totalGuesses: player.totalGuesses,
      roundStatus,
      guessesUsed: state?.guessesUsed ?? 0,
    };
  }

  private buildPrivateState(
    room: SonGuessrRoomRecord,
    player: SonGuessrPlayerRecord,
  ): SonGuessrPrivateState {
    this.ensureRoundPlayerState(room, player);
    const round = room.currentRound;
    const state = round?.players[player.id];
    const isSubmitter = round?.submitterPlayerId === player.id || room.pendingSubmitterPlayerId === player.id;
    const canParticipateAsGuesser = !isSubmitter || this.canTestSubmitterGuess(room, player.id);
    const canObserveAllAttempts = isSubmitter || player.membership === "spectator";
    return {
      playerId: player.id,
      sessionToken: player.sessionToken,
      isSubmitter,
      canSubmitSong: room.phase === "submittingSong" && room.pendingSubmitterPlayerId === player.id,
      canGuess:
        room.phase === "playing" &&
        player.membership === "active" &&
        canParticipateAsGuesser &&
        Boolean(state?.audioReady) &&
        !state?.correct &&
        !state?.gaveUp &&
        (state?.guessesUsed ?? 0) < (round?.settings.maxGuessesPerRound ?? room.settings.maxGuessesPerRound),
      canGiveUp:
        room.phase === "playing" &&
        player.membership === "active" &&
        canParticipateAsGuesser &&
        Boolean(state) &&
        !state?.inFlight &&
        !state?.correct &&
        !state?.gaveUp &&
        (state?.guessesUsed ?? 0) < (round?.settings.maxGuessesPerRound ?? room.settings.maxGuessesPerRound),
      remainingGuesses: Math.max(
        0,
        (round?.settings.maxGuessesPerRound ?? room.settings.maxGuessesPerRound) - (state?.guessesUsed ?? 0),
      ),
      guessDeadlineAt: state?.deadlineAt,
      // 出题人与旁观者在游戏中均可看到本题答案
      submittedSong:
        (isSubmitter || player.membership === "spectator") && round
          ? this.publicSong(round.song)
          : undefined,
      submittedAnime:
        (isSubmitter || player.membership === "spectator") && round?.anime
          ? this.publicAnime(round.anime)
          : undefined,
      visibleAttempts: round
        ? round.attempts.filter(
            (attempt) => canObserveAllAttempts || attempt.playerId === player.id,
          )
        : [],
    };
  }

  private buildScores(
    room: SonGuessrRoomRecord,
    startScores: Record<string, number>,
  ): SonGuessrScore[] {
    return this.activePlayers(room)
      .map((player) => ({
        playerId: player.id,
        playerName: player.name,
        score: player.score,
        delta: player.score - (startScores[player.id] ?? player.score),
        correctGuesses: player.correctGuesses,
        totalGuesses: player.totalGuesses,
      }))
      .sort((left, right) => right.score - left.score || left.playerName.localeCompare(right.playerName));
  }

  private publishRoom(room: SonGuessrRoomRecord, targetConnection?: ConnectionRecord) {
    const snapshot = this.buildRoomSnapshot(room);
    const connections = targetConnection
      ? [targetConnection]
      : this.connections.getRoomConnections(room.id);
    for (const connection of connections) {
      connection.send(createEvent("song.room.snapshot", snapshot));
      if (connection.playerId) {
        const player = room.players[connection.playerId];
        if (player) connection.send(createEvent("song.game.privateState", this.buildPrivateState(room, player)));
      }
    }
  }

  private publishPrivateState(room: SonGuessrRoomRecord, player: SonGuessrPlayerRecord) {
    const connection = this.connections.findConnectionByPlayer(room.id, player.id);
    connection?.send(createEvent("song.game.privateState", this.buildPrivateState(room, player)));
  }

  private publishRoomCalibration(room: SonGuessrRoomRecord) {
    const snapshot = this.buildRoomSnapshot(room);
    for (const connection of this.connections.getRoomConnections(room.id)) {
      connection.sendStateSyncCalibration?.(createEvent("song.room.snapshot", snapshot));
      if (!connection.playerId) continue;
      const player = room.players[connection.playerId];
      if (player) {
        connection.sendStateSyncCalibration?.(
          createEvent("song.game.privateState", this.buildPrivateState(room, player)),
        );
      }
    }
  }

  private publishLobby() {
    this.connections.broadcastToLobby(createEvent("song.lobby.rooms", this.getRoomSummaries()));
  }

  private closeRoom(room: SonGuessrRoomRecord, reason: string) {
    this.connections.broadcastToRoom(room.id, createEvent("song.room.closed", { roomId: room.id, reason }));
    for (const connection of this.connections.getRoomConnections(room.id)) {
      this.connections.detach(connection);
    }
    room.musicSession = undefined;
    this.rooms.delete(room.id);
    this.publishLobby();
  }

  private attachConnection(
    room: SonGuessrRoomRecord,
    player: SonGuessrPlayerRecord,
    connection: ConnectionRecord,
  ) {
    const previous = this.connections.findConnectionByPlayer(room.id, player.id);
    if (previous && previous.id !== connection.id) {
      // 统一带上 song. 前缀；客户端保留对裸名的兼容分支，避免旧客户端收不到。
      (previous.sendPacket ?? previous.send)(createEvent("song.session.replaced", { roomId: room.id }));
      this.connections.detach(previous);
      previous.close(4001, "session_replaced");
    }
    player.online = true;
    player.connectionId = connection.id;
    player.lastSeenAt = this.now();
    connection.resetStateSync?.();
    this.connections.attach(connection, room.id, player.id);
  }

  private appendSystemMessage(room: SonGuessrRoomRecord, text: string) {
    room.chat = [
      ...room.chat,
      {
        id: this.createId("song_chat"),
        playerId: "system",
        playerName: "系统",
        text,
        createdAt: this.now(),
        system: true,
      },
    ].slice(-CHAT_LIMIT);
  }

  private createPlayer(nameValue: string, host: boolean, isBot = false): SonGuessrPlayerRecord {
    const name = this.requireName(nameValue);
    const now = this.now();
    return {
      id: this.createId("song_player"),
      sessionToken: `${this.createId("song_session")}_${crypto.randomUUID()}`,
      name,
      membership: "active",
      online: true,
      isReady: host,
      score: 0,
      correctGuesses: 0,
      totalGuesses: 0,
      isBot,
      joinedAt: now,
      lastSeenAt: now,
    };
  }

  private activePlayers(room: SonGuessrRoomRecord) {
    return Object.values(room.players).filter((player) => player.membership === "active");
  }

  private onlineCount(room: SonGuessrRoomRecord) {
    return Object.values(room.players).filter(
      (player) => player.online && player.membership !== "kicked",
    ).length;
  }

  private publicSong(song: SongDetails): SongSearchResult {
    return {
      id: song.id,
      title: song.title,
      artist: song.artist,
      album: song.album,
      pictureUrl: song.pictureUrl,
      durationMs: song.durationMs,
      requiresVip: song.requiresVip,
    };
  }

  private publicAnime(anime: BangumiSubjectDetails): BangumiSubjectSearchResult {
    return {
      id: anime.id,
      name: anime.name,
      nameCn: anime.nameCn,
      imageUrl: anime.imageUrl,
      year: anime.year,
      rating: anime.rating,
      ratingCount: anime.ratingCount,
      tags: anime.tags.filter((tag) => !tag.includes("20")).slice(0, 5),
      metaTags: [],
    };
  }

  private requireRoomPlayer(connection: ConnectionRecord) {
    if (!connection.roomId || !connection.playerId) {
      throw new AppError("PLAYER_NOT_IN_ROOM", "当前连接尚未加入房间");
    }
    const room = this.getRoom(connection.roomId);
    const player = room.players[connection.playerId];
    if (!player || player.membership === "kicked") throw new AppError("PLAYER_NOT_FOUND", "玩家不存在");
    return { room, player };
  }

  private requireActiveRound(room: SonGuessrRoomRecord) {
    if (room.phase !== "playing" || !room.currentRound) {
      throw new AppError("NO_ACTIVE_ROUND", "当前没有进行中的回合");
    }
    return room.currentRound;
  }

  private getRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) throw new AppError("ROOM_NOT_FOUND", "房间不存在");
    return room;
  }

  private ensureConnectionFree(connection: ConnectionRecord) {
    if (!connection.roomId && !connection.playerId) return;
    if (connection.roomId && connection.playerId && this.rooms.has(connection.roomId)) {
      this.detachFromRoom(connection, { keepMusicSession: true });
      return;
    }
    // 房间已经不存在（或只有一半字段有值）时，requireRoomPlayer 会抛 ROOM_NOT_FOUND
    // 并把正常的 create / join / reconnect 一起打断；这种残余状态退回原来的置空即可。
    this.connections.detach(connection);
  }

  private ensureHost(room: SonGuessrRoomRecord, playerId: string) {
    if (room.hostPlayerId !== playerId) throw new AppError("FORBIDDEN", "只有房主可以执行该操作");
  }

  private ensurePassword(
    room: SonGuessrRoomRecord,
    password: string | undefined,
    connection: ConnectionRecord,
  ) {
    if (room.visibility !== "private") return;
    const normalized = password?.trim();
    // 缺少密码只是提示玩家输入，不消耗尝试次数。
    if (!normalized) throw new AppError("PASSWORD_INCORRECT", "房间密码错误");
    // 先计数再校验：只在猜错时计数的话，猜中那一次不经过限流，超限后的成功与失败仍可区分。
    if (!this.joinPasswordLimiter.allow(`${connection.id}:${room.id}`, this.now())) {
      throw new AppError("TOO_MANY_ATTEMPTS", "密码错误次数过多，请稍后再试");
    }
    if (room.password !== normalized) throw new AppError("PASSWORD_INCORRECT", "房间密码错误");
  }

  private requirePassword(password?: string) {
    const normalized = password?.trim();
    if (!normalized) throw new AppError("PASSWORD_REQUIRED", "私密房间需要密码");
    return normalized;
  }

  private requireName(value: string) {
    const normalized = normalizeName(value).slice(0, 20);
    if (!normalized) throw new AppError("INVALID_NAME", "用户名不能为空");
    return normalized;
  }

  private reassignHost(room: SonGuessrRoomRecord) {
    const next = Object.values(room.players)
      .filter((player) => player.online && player.membership === "active" && !player.isBot)
      .sort((left, right) => left.joinedAt - right.joinedAt)[0]
      ?? Object.values(room.players)
        .filter((player) => player.online && player.membership !== "kicked" && !player.isBot)
        .sort((left, right) => left.joinedAt - right.joinedAt)[0];
    if (next) {
      room.musicAuthOperation = undefined;
      room.automaticRoundOperation = undefined;
      room.automaticRoundLoading = false;
      room.hostPlayerId = next.id;
      next.isReady = true;
      if (room.musicSession) room.musicSession.ownerPlayerId = next.id;
    } else {
      room.hostPlayerId = "";
    }
  }

  private transferHostAfterDisconnect(room: SonGuessrRoomRecord) {
    const previousHost = room.players[room.hostPlayerId];
    if (!previousHost || previousHost.online || previousHost.membership === "kicked") {
      room.hostReconnectDeadlineAt = undefined;
      return;
    }
    room.hostReconnectDeadlineAt = undefined;
    this.reassignHost(room);
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
  }

  private isTestRoom(room: SonGuessrRoomRecord) {
    return room.id.toLowerCase() === ROOM_ID_TEST_MODE.toLowerCase();
  }

  private touch(room: SonGuessrRoomRecord) {
    room.updatedAt = this.now();
    room.lastActivityAt = this.now();
  }

  private createId(prefix: string) {
    this.idCounter += 1;
    return `${prefix}_${this.idCounter.toString(36)}`;
  }

  private log(type: string, roomId?: string, playerId?: string, payload?: unknown) {
    void this.options.eventLogger?.write({
      type,
      roomId,
      playerId,
      payload,
      createdAt: this.now(),
    });
  }
}
