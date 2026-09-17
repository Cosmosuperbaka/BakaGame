import {
  BOT_NAME_SUFFIXES,
  CHAT_LIMIT,
  HOST_RECONNECT_TIMEOUT_MS,
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
import type {
  MusicLoginSession,
  MusicProvider,
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
  SongSearchResult,
  SongLyricClip,
  BangumiSubjectDetails,
  BangumiSubjectSearchResult,
  BangumiMusicTrack,
  BangumiMusicTrackKind,
  AnimeAutoFilters,
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
  audioReadyDeadlineAt?: number;
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

export const isSongTitleMatch = (candidateTitle: string, expectedTitle: string): boolean => {
  // 版权署名 / 制作委员会条目不是歌曲。若放任其参与子串匹配，
  // `©BanG Dream! Project` 会因包含 `banGdream` 而与《Bang Dream!》误判为同一首，
  // 从而把完全无关的歌曲当成番剧主题曲（实测事故）。
  if (isBangumiCreditsEntry(candidateTitle) || isBangumiCreditsEntry(expectedTitle)) return false;
  const normCandidate = normalizeSongTitle(candidateTitle);
  const normExpected = normalizeSongTitle(expectedTitle);
  if (!normCandidate || !normExpected) return false;
  if (normCandidate === normExpected) return true;
  const minLen = Math.min(normCandidate.length, normExpected.length);
  if (minLen >= 2 && (normCandidate.includes(normExpected) || normExpected.includes(normCandidate))) {
    return true;
  }
  return false;
};

const normalizedArtists = (value: string) =>
  new Set(
    value
      .split(/\s*(?:,|，|、|&|＆|\/|／|;|；|\bx\b|\bfeat(?:uring)?\.?\b|\bwith\b)\s*/iu)
      .map(normalizeSongText)
      .filter(Boolean),
  );

/** 明确指向翻唱、改编或非原唱的标记（标题、专辑与标签通用）。 */
const COVER_MARKER_PATTERN =
  /翻唱|翻錄|翻录|カバー|커버|\bcover(?:ed|s|ing)?\b|重唱|再唱|自翻|试唱|試唱|模仿|リミックス|カヴァー/iu;
/** 非原唱演绎版本标记：伴奏、纯音乐、现场、不同歌手演唱等。 */
const NON_ORIGINAL_VERSION_PATTERN =
  /伴奏|純伴奏|纯伴奏|纯音乐|純音樂|off\s*vocal|インスト|karaoke|カラオケ|伴唱|和声伴奏|live|现场|現場|演唱会|演唱會|acoustic|不插电|不插電|demo|试听|試聽/iu;
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
 * 为网易云候选歌曲打「原版优先」分，分数越高越接近 Bangumi 记录的原唱版本。
 * resolveAnimeSong 会按此分数降序取首个可播放歌曲，从而在翻唱、器乐改编、伴奏等
 * 版本混排时优先选中原版，避免「原版存在却抽到翻唱」。
 */
export const scoreAnimeSongCandidate = (
  candidate: SongSearchResult,
  track: BangumiMusicTrack,
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
  return score;
};

const FALLBACK_CLIP_SECONDS_PER_LINE = 6;
const MAX_LYRIC_LINE_DURATION_MS = 12_000;
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
 * 单条连接在一分钟内允许的「客户端可触发」音乐类命令次数。
 *
 * 只卡命令入口，不卡出题解析器内部的上游调用：后者只由房主的
 * `song.game.start` / `nextRound` 间接触发，不是滥用面。
 */
const MUSIC_RATE_LIMIT_PER_CONNECTION = 20;
const MUSIC_RATE_LIMIT_WINDOW_MS = 60_000;

/** 同一连接对同一房间的密码尝试：一分钟内最多 5 次，超出直接拒绝。 */
const JOIN_FAILURE_MAX_ATTEMPTS = 5;
const JOIN_FAILURE_WINDOW_MS = 60_000;

/** 聊天：每秒 2 条、突发 5 条。 */
const CHAT_RATE_LIMIT_PER_CONNECTION = 5;
const CHAT_RATE_LIMIT_WINDOW_MS = 2_500;

/** 房间因空闲被关闭前的预警提前量。 */
const ROOM_EXPIRING_WARNING_MS = 60_000;
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

  // 从设定行数开始逐行收缩寻找窗口。
  //
  // 单窗口的时长上限会整片否决含间奏的窗口，而**只要窗口长度足够大到必然覆盖
  // 那个长行**，就再也拼不出窗口。`JANE DOE`（米津玄師 / 宇多田ヒカル）在
  // `[00:53.04]` 之后有 15 秒间奏，该行跨度 14.81s：设定行数 ≥ 7 时任何窗口
  // 都会包含它，旧实现直接退回 `lines: []`，让一首 12 句歌词的歌在界面上被
  // 显示成「当前歌曲为纯音乐或无歌词」。宁可少给几行，也不能丢掉整首歌的歌词。
  for (let count = safeCount; count >= Math.min(MIN_LYRIC_WINDOW_LINES, safeCount); count -= 1) {
    if (lyrics.length < count) continue;
    const windows = Array.from({ length: lyrics.length - count + 1 }, (_, startIndex) =>
      lyrics.slice(startIndex, startIndex + count))
      .filter((lines) => lines.every(isCompactLine));
    if (windows.length === 0) continue;

    const padded = windows.length >= 5 ? windows.slice(2, -2) : windows;
    const candidates = padded.length > 0 ? padded : windows;
    const lines = candidates[random.nextInt(candidates.length)];
    return {
      startTime: lines[0].time,
      endTime: Math.max(lines[0].time, lines.at(-1)!.endTime - 250),
      lines,
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
   * `NeteaseMusicProvider` 是全进程单例（并发 3 / 队列 64 / 触发限流后冷却 5s→60s），
   * 没有按连接的配额时，一个人打满队列会让上游返回 405 并进入全局冷却，
   * 结果是全服所有房间在这一分钟里搜歌、出题一起报错。
   */
  private readonly musicLimiter = new SlidingWindowRateLimiter({
    windowMs: MUSIC_RATE_LIMIT_WINDOW_MS,
    maxRequests: MUSIC_RATE_LIMIT_PER_CONNECTION,
  });
  /**
   * 加入私密房间的密码尝试配额（按「连接 + 房间」计数）。
   * 房间号只有 9000 个且私密房密码没有退避，不设限流就能一直试。
   */
  private readonly joinFailureLimiter = new SlidingWindowRateLimiter({
    windowMs: JOIN_FAILURE_WINDOW_MS,
    maxRequests: JOIN_FAILURE_MAX_ATTEMPTS,
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
    connection.roomId = undefined;
    connection.playerId = undefined;

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
      case "song.game.start":
        return this.startGame(connection);
      case "song.game.chooseSubmitter":
        return this.chooseSubmitter(connection, message.payload.playerId);
      case "song.game.submitSong":
        return this.submitSong(connection, message.payload.songId);
      case "song.game.submitAnime":
        return this.submitAnime(connection, message.payload.subjectId);
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
            round.audioReadyDeadlineAt !== undefined &&
            currentTime >= round.audioReadyDeadlineAt;
          const isGuessTimeout =
            state.deadlineAt !== undefined && state.deadlineAt <= currentTime;

          if (isAudioReadyTimeout && !state.audioReady) {
            state.audioReady = true;
          }

          if (isGuessTimeout || isAudioReadyTimeout || isRoundHardExpired) {
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
    this.ensurePassword(room, payload.password);
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
    connection.roomId = undefined;
    connection.playerId = undefined;

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
    if (payload.name !== undefined) room.name = normalizeWord(payload.name) || room.name;
    if (payload.visibility !== undefined) room.visibility = payload.visibility;
    if (payload.allowSpectators !== undefined) room.allowSpectators = payload.allowSpectators;
    if (payload.visibility === "public") room.password = undefined;
    if (room.visibility === "private" && payload.password !== undefined) {
      room.password = payload.password.trim() ? payload.password.trim() : room.password;
    }
    if (room.visibility === "private" && !room.password) {
      throw new AppError("PASSWORD_REQUIRED", "私密房间需要密码");
    }

    if (payload.questionType !== undefined) room.settings.questionType = payload.questionType;
    // 单人房间固定由系统出题，不提供手动出题与轮流出题。
    if (!room.solo && payload.questionMode !== undefined) {
      room.settings.questionMode = payload.questionMode;
    }
    if (!room.solo && payload.autoRotateSubmitter !== undefined) {
      room.settings.autoRotateSubmitter = payload.autoRotateSubmitter;
    }
    if (payload.autoFilters !== undefined) {
      room.settings.autoFilters = this.normalizeAutoFilters(payload.autoFilters);
    }
    if (payload.animeAutoFilters !== undefined) {
      room.settings.animeAutoFilters = this.normalizeAnimeAutoFilters(payload.animeAutoFilters);
    }

    if (payload.lyricsLineCount !== undefined) {
      room.settings.lyricsLineCount = clampInt(payload.lyricsLineCount, 1, 10);
    }
    if (payload.showLyrics !== undefined) {
      room.settings.showLyrics = payload.showLyrics;
    }
    if (payload.maxGuessesPerRound !== undefined) {
      room.settings.maxGuessesPerRound = clampInt(payload.maxGuessesPerRound, 1, 10);
    }
    if (payload.guessDurationSeconds !== undefined) {
      room.settings.guessDurationSeconds = clampInt(payload.guessDurationSeconds, 10, 180);
    }
    if (payload.showGuessTimer !== undefined) {
      room.settings.showGuessTimer = payload.showGuessTimer;
    }
    if (payload.bloodMode !== undefined) {
      room.settings.bloodMode = payload.bloodMode;
    }

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

  private normalizeAutoFilters(filters: SongAutoFilters): SongAutoFilters {
    const playlist = filters.playlist
      ? {
          id: this.parsePlaylistId(filters.playlist.id),
          name: filters.playlist.name?.trim().slice(0, 120),
          songCount: filters.playlist.songCount,
        }
      : undefined;
    const artists = filters.artists
      .slice(0, 20)
      .map((artist) => ({ id: artist.id.trim().slice(0, 64), name: normalizeWord(artist.name).slice(0, 80) }))
      .filter((artist) => artist.id && artist.name);
    const minPopularity = [0, 1_000, 10_000, 100_000].includes(filters.minPopularity)
      ? filters.minPopularity
      : 0;
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
      targetConnection.roomId = undefined;
      targetConnection.playerId = undefined;
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
    this.publishRoom(room);
    return { sent: true };
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
    const result = await checkQrLogin.call(this.options.musicProvider, key);
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
    const result = await getLoginStatus.call(this.options.musicProvider, cookie);
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
    if (!room.musicSession) return false;
    if (ownerPlayerId && room.musicSession.ownerPlayerId !== ownerPlayerId) return false;
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
    if (automatic) room.automaticRoundLoading = true;
    else room.manualRoundStarting = true;
    try {
      if (!room.musicSession) {
        throw new AppError("MUSIC_LOGIN_REQUIRED", "开始游戏前请先扫码登录网易云账号");
      }
      const getLoginStatus = this.options.musicProvider.getLoginStatus;
      if (!getLoginStatus) {
        throw new AppError("MUSIC_AUTH_UNAVAILABLE", "网易云登录状态校验不可用");
      }
      try {
        const session = await getLoginStatus.call(this.options.musicProvider, room.musicSession.cookie);
        room.musicSession.account = session.account;
      } catch (error) {
        if (error instanceof AppError) {
          if (error.code === "MUSIC_SESSION_INVALID") {
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
        await this.startAutomaticRound(room);
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
      if (automatic) room.automaticRoundLoading = false;
      else room.manualRoundStarting = false;
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
    if (room.musicSession?.account.vipStatus === "nonVip" && song.requiresVip) {
      throw new AppError("MUSIC_VIP_REQUIRED", "当前网易云账号不是会员，无法选择会员专享歌曲");
    }
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

  private async submitAnime(connection: ConnectionRecord, subjectId: string) {
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
    const resolved = await this.resolveAnimeSong(room, anime);
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
    const nonVip = room.musicSession?.account.vipStatus === "nonVip";
    const cookie = room.musicSession?.cookie;
    const recentSongIds = new Set(room.recentSongIds ?? []);
    let fallbackRecent: { song: SongDetails; track: BangumiMusicTrack } | undefined;
    // 冷缓存下每个候选曲目都可能触发多次回源，必须设总预算，
    // 否则一次出题会退化成上百次串行上游请求（实测最坏 60s+）。
    const budget = { search: ANIME_SONG_SEARCH_BUDGET, detail: ANIME_SONG_DETAIL_BUDGET };

    for (const track of candidates) {
      if (budget.search <= 0 || budget.detail <= 0) break;
      const queries: string[] = [];
      if (track.artist) {
        queries.push(`${track.title} ${track.artist}`);
      } else {
        if (anime.name) queries.push(`${track.title} ${anime.name}`);
        if (anime.nameCn && anime.nameCn !== anime.name) queries.push(`${track.title} ${anime.nameCn}`);
        queries.push(track.title);
      }
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
      const matched = await this.searchAnimeTrackCandidates(provider, queries, track, cookie, budget);
      if (matched.length === 0) continue;

      // 网易云会把翻唱、器乐改编、伴奏等版本混排在原版之前；先按「原版优先」评分
      // 降序排列，再依次验证可播放性，确保原版存在时不会被翻唱版抢占。
      const ranked = matched
        .map((candidate, index) => ({ candidate, index, score: scoreAnimeSongCandidate(candidate, track) }))
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map((entry) => entry.candidate);
      // 会员专享歌曲在非会员房间必然装不上回合，先用检索结果里免费带出的 fee 标记
      // 剔除，避免为注定失败的候选逐首回源拉取详情。
      const pool = nonVip ? ranked.filter((candidate) => candidate.requiresVip !== true) : ranked;

      let attempts = 0;
      for (const candidate of pool) {
        if (budget.detail <= 0 || attempts >= ANIME_TRACK_DETAIL_ATTEMPTS) break;
        attempts += 1;
        // 热度不达标就无法出题，先用一次廉价的红心数查询判掉，
        // 避免为一个必然被否决的候选拉取歌词、音频与百科（约 5~6 个上游请求）。
        if (minPopularity > 0 && provider.getSongPopularity) {
          budget.detail -= 1;
          const popularity = await provider
            .getSongPopularity.call(provider, candidate.id, cookie)
            .catch(() => undefined);
          if (popularity !== undefined && popularity < minPopularity) continue;
        }
        budget.detail -= 1;
        let song: SongDetails;
        try {
          song = await provider.getSong(candidate.id, cookie);
        } catch {
          // 单首歌曲不可播放时继续尝试同曲目的其他版本。
          continue;
        }
        // 详情里的会员标记比检索结果更权威（检索结果可能缺失该字段）。
        if (nonVip && song.requiresVip) continue;
        if (minPopularity > 0 && (song.popularity === undefined || song.popularity < minPopularity)) continue;
        const resolved = {
          song,
          track: { ...track, kind: this.refineTrackKind(track.kind, song) },
        } satisfies { song: SongDetails; track: BangumiMusicTrack };
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
  ): Promise<SongSearchResult[]> {
    const searches = await Promise.all(queries.map(async (query) => {
      if (budget.search <= 0) return [];
      budget.search -= 1;
      try {
        return await provider.search(query, ANIME_SONG_SEARCH_LIMIT, cookie);
      } catch {
        return [];
      }
    }));

    const merged = new Map<string, SongSearchResult>();
    for (const results of searches) {
      for (const candidate of results) {
        if (merged.has(candidate.id)) continue;
        if (!isSongCandidateMatch(candidate, track.title)) continue;
        merged.set(candidate.id, candidate);
      }
    }
    return [...merged.values()];
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
      this.activePlayers(room).filter((candidate) => candidate.online).map((candidate) => [
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
      audioReadyDeadlineAt: this.now() + 15_000,
      hardDeadlineAt: this.now() + (roundSettings.guessDurationSeconds + 20) * 1_000,
    };
    room.pendingSubmitterPlayerId = undefined;
    room.roundSummary = undefined;
    room.phase = "playing";

    const recentSongIds = room.recentSongIds ?? [];
    room.recentSongIds = [song.id, ...recentSongIds.filter((id) => id !== song.id)].slice(0, 10);
    if (anime) {
      const recentSubjectIds = room.recentSubjectIds ?? [];
      room.recentSubjectIds = [anime.id, ...recentSubjectIds.filter((id) => id !== anime.id)].slice(0, 10);
    }

    this.appendSystemMessage(room, `第 ${roundNumber} 轮开始`);
    return roundNumber;
  }

  private async startAutomaticRound(room: SonGuessrRoomRecord): Promise<void> {
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
          this.installRound(room, resolved.song, "", anime, resolved.track);
          return;
        } catch (error) {
          if (error instanceof AppError && error.code === "BANGUMI_RATE_LIMITED") throw error;
        }
      }
      throw new AppError("BANGUMI_NO_MUSIC", "筛选结果中没有可播放关联歌曲的番剧");
    }
    const candidates = await this.resolveAutomaticCandidates(room);
    if (candidates.length === 0) {
      throw new AppError("AUTO_NO_MATCH", "没有符合当前筛选条件的歌曲");
    }
    const recentSongIds = new Set(room.recentSongIds ?? []);
    const freshCandidates = candidates.filter((s) => !recentSongIds.has(s.id));
    // 会员限制在检索结果里已经带出，先过滤再回源，
    // 否则非会员账号会在大歌单上逐个串行试错。
    const playable = (freshCandidates.length > 0 ? freshCandidates : candidates)
      .filter((song) => room.musicSession?.account.vipStatus !== "nonVip" || !song.requiresVip);
    const pool = [...playable];
    let attempts = 0;
    while (pool.length > 0 && attempts < AUTO_SONG_CANDIDATE_LIMIT) {
      attempts += 1;
      const selected = pool.splice(this.random.nextInt(pool.length), 1)[0];
      const song = await this.options.musicProvider.getSong(selected.id, room.musicSession?.cookie);
      if (room.musicSession?.account.vipStatus === "nonVip" && song.requiresVip) continue;
      this.installRound(room, song, "");
      return;
    }
    throw new AppError("MUSIC_VIP_REQUIRED", "筛选结果全部为会员歌曲，当前账号无法开始");
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

  private audioReady(connection: ConnectionRecord, roundNumber: number) {
    const { room, player } = this.requireRoomPlayer(connection);
    // 页面切后台/重连时可能补发旧回合的 ready；状态过渡期间应幂等忽略，
    // 不把一个正常的陈旧通知显示成「当前没有进行中的回合」。
    if (room.phase !== "playing" || !room.currentRound || room.automaticRoundLoading) {
      return { ignored: true };
    }
    const round = room.currentRound;
    if (round.number !== roundNumber) return { ignored: true };
    const state = round.players[player.id];
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
      state.audioReady = true;
      state.deadlineAt = round.settings.showGuessTimer
        ? this.now() + round.settings.guessDurationSeconds * 1_000
        : undefined;
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
    // 正式成员恰好在 installRound 期间掉线、随后又重连回来时，回合里没有他的状态。
    // 这时他是合法参与者，只是错过了状态构建 —— 补一份即可，不能按旁观者拦掉。
    const state = round.players[player.id] ?? this.attachRoundState(room, round, player);
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
    } else if (state.guessesUsed < round.settings.maxGuessesPerRound) {
      state.deadlineAt = round.settings.showGuessTimer
        ? this.now() + round.settings.guessDurationSeconds * 1_000
        : undefined;
    } else {
      state.deadlineAt = undefined;
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
    const state = round.players[player.id];
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
    } else if (state.guessesUsed < round.settings.maxGuessesPerRound) {
      state.deadlineAt = round.settings.showGuessTimer
        ? this.now() + round.settings.guessDurationSeconds * 1_000
        : undefined;
    } else {
      state.deadlineAt = undefined;
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
    const state = round.players[player.id];
    if (!state || player.membership !== "active") {
      throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能执行猜歌操作");
    }
    if (player.id === round.submitterPlayerId && !this.canTestSubmitterGuess(room, player.id)) {
      throw new AppError("SUBMITTER_CANNOT_GIVE_UP", "出题人无需放弃");
    }
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
      room.automaticRoundLoading = true;
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
        await this.startAutomaticRound(room);
      } catch (error) {
        // 自动题库临时失败时保留答案页，房主可以重试或回到等待阶段，
        // 不能留下既没有 currentRound 也没有 roundSummary 的悬空状态。
        room.currentRound = previousRound;
        room.roundSummary = previousSummary;
        room.phase = "roundResult";
        throw error;
      } finally {
        room.automaticRoundLoading = false;
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
   * 为「回合已经开打但没有回合状态」的正式成员补一份状态。
   * 场景：installRound 只按当时在线的人建状态，玩家恰好在这期间掉线又重连回来。
   */
  private attachRoundState(
    room: SonGuessrRoomRecord,
    round: SonGuessrRound,
    player: SonGuessrPlayerRecord,
  ): SonGuessrRoundPlayerState {
    const state: SonGuessrRoundPlayerState = {
      audioReady: true,
      guessesUsed: 0,
      correct: false,
      gaveUp: false,
      deadlineAt: round.settings.showGuessTimer
        ? this.now() + round.settings.guessDurationSeconds * 1_000
        : undefined,
    };
    round.players[player.id] = state;
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
    state.deadlineAt = state.guessesUsed < round.settings.maxGuessesPerRound && round.settings.showGuessTimer
      ? this.now() + round.settings.guessDurationSeconds * 1_000
      : undefined;
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
      connection.roomId = undefined;
      connection.playerId = undefined;
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
      (previous.sendPacket ?? previous.send)(createEvent("session.replaced", { roomId: room.id }));
      previous.roomId = undefined;
      previous.playerId = undefined;
      previous.close(4001, "session_replaced");
    }
    player.online = true;
    player.connectionId = connection.id;
    player.lastSeenAt = this.now();
    connection.resetStateSync?.();
    connection.roomId = room.id;
    connection.playerId = player.id;
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
    connection.roomId = undefined;
    connection.playerId = undefined;
  }

  private ensureHost(room: SonGuessrRoomRecord, playerId: string) {
    if (room.hostPlayerId !== playerId) throw new AppError("FORBIDDEN", "只有房主可以执行该操作");
  }

  private ensurePassword(room: SonGuessrRoomRecord, password?: string) {
    if (room.visibility === "private" && room.password !== password?.trim()) {
      throw new AppError("PASSWORD_INCORRECT", "房间密码错误");
    }
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
