/** 猜歌房间/回合的记录类型、默认设置与出题、账号池、限流的调优常量。 */
import { AppError } from "../../domain/Errors";
import { MusicLoginSession } from "../../infrastructure/NeteaseMusicProvider";
import {
  ALL_BANGUMI_TRACK_KINDS,
  SongGuessDirection,
  type BangumiMusicTrack,
  type BangumiSubjectDetails,
  type ChatMessage,
  type PlayerAccount,
  type RoomVisibility,
  type SonGuessrClientMessage,
  type SonGuessrPhase,
  type SonGuessrRoundMark,
  type SonGuessrRoundSummary,
  type SonGuessrScore,
  type SonGuessrSettings,
  type SongDetails,
  type SongGuessAttempt,
  type SongLyricClip,
} from "../../shared/Index";

export const DEFAULT_SETTINGS: SonGuessrSettings = {
  questionType: "song",
  questionMode: "manual",
  autoRotateSubmitter: false,
  autoFilters: { artists: [], minPopularity: 0 },
  animeAutoFilters: {
    ranking: "all",
    subjectLimit: 50,
    songMinPopularity: 0,
    trackKinds: [...ALL_BANGUMI_TRACK_KINDS],
  },
  lyricsLineCount: 5,
  showLyrics: true,
  bloodMode: false,
  maxGuessesPerRound: 3,
  guessDurationSeconds: 60,
  showGuessTimer: true,
  allowAgents: false,
};

/**
 * 未配置歌单或歌手时使用网易云热歌榜作为默认题库。
 *
 * QQ 音乐的热歌榜是榜单接口（toplist）而不是歌单 ID，锁定的接口包没有榜单取曲方法，
 * 因此这里无法按平台等价切换；QQ-only 房间仍用这份默认题库（网易云匿名+解灰）。
 * 共有曲目的代表侧由 `musicSearchOptions` 的平台偏好决定，与默认题库是两件事。
 */
export const DEFAULT_AUTO_PLAYLIST_ID = "3778678";

export interface SonGuessrPlayerRecord {
  id: string;
  sessionToken: string;
  name: string;
  membership: "active" | "spectator" | "kicked";
  nextRoundMembership?: "active" | "spectator";
  online: boolean;
  isReady: boolean;
  score: number;
  /** 队伍号 1–8，`null` 为个人游玩；旁观者没有队伍。 */
  team: number | null;
  correctGuesses: number;
  totalGuesses: number;
  /** 本轮作答结果，`finishRound` 写入；换轮与回到等待时清零。 */
  roundMarks: SonGuessrRoundMark[];
  isBot: boolean;
  isAgent?: boolean;
  joinedAt: number;
  lastSeenAt: number;
  connectionId?: string;
  account?: PlayerAccount;
}

/**
 * 一个作答单元：个人一份，同队队员共用同一个对象（与 CEE 的队伍同口径）。
 * 次数、猜中、放弃、限时与在途锁都按单元记，一人猜中或放弃即全队结束；音频是否就绪仍按人记在回合上。
 */
export interface SonGuessrRoundPlayerState {
  memberIds: string[];
  guessesUsed: number;
  correct: boolean;
  gaveUp: boolean;
  deadlineAt?: number;
  inFlight?: boolean;
  /** 开局即放弃的人机单元；不进计分分母。在开局时定下，之后成员离房也不改变单元是否计入。 */
  bot?: true;
}

export interface SonGuessrRoundRecord {
  number: number;
  submitterPlayerId: string;
  song: SongDetails;
  /** 本回合歌曲的备用音源 URN（不含当前播放源）：刷新直链时按序兜底。 */
  alternateSongIds?: string[];
  anime?: BangumiSubjectDetails;
  animeTrack?: BangumiMusicTrack;
  lyricClip: SongLyricClip;
  attempts: SongGuessAttempt[];
  correctPlayerIds: string[];
  /** 新计分模型下每个猜中单元的系数拆解，随结算摘要下发；旧口径下为空。 */
  answererBreakdown: { playerId: string; speed: number; precision: number; score: number }[];
  startScores: Record<string, number>;
  /** 按玩家索引作答单元，同队队员指向同一个对象。 */
  players: Record<string, SonGuessrRoundPlayerState>;
  /** 各玩家的音频是否就绪：每个客户端各自加载，不随队伍共享。 */
  audioReady: Record<string, boolean>;
  /** 出题人的队友：本局观战，看得到答案与全房猜测，不作答。开局冻结。 */
  observerIds: string[];
  settings: SonGuessrSettings;
  audioPreparationDeadlineAt: number;
  audioReadyDeadlineAt?: number;
  /**
   * 回合硬截止。全程锚定「首名玩家真正具备答题条件的时刻」，
   * 因此绝不能在建回合时按「建回合时刻 + N 秒」预设：自动模式的选曲会跨多次上游请求，
   * 本字段若在玩家能答题之前就耗尽，房间会在倒计时还剩几十秒时直接结算。
   */
  hardDeadlineAt?: number;
  /**
   * 答题起算时刻：首名玩家真正具备答题条件的那一刻（与 `hardDeadlineAt` 同一锚点）。
   * 计分要按「解得快不快」给速度系数，起点必须是玩家能开始答题的时刻，
   * 而不是装题时刻——自动选曲会占掉数秒到数十秒。
   */
  answeringStartedAt?: number;
  /** 装题时刻，仅供对局记录。 */
  startedAt: number;
}

export interface SonGuessrRoomRecord {
  id: string;
  name: string;
  solo: boolean;
  visibility: RoomVisibility;
  /** 私密房口令的 argon2 摘要；与 CEE、谁是卧底同一口径，明文不进房间记录、快照与日志。 */
  passwordHash?: string;
  allowSpectators: boolean;
  hostPlayerId: string;
  settings: SonGuessrSettings;
  phase: SonGuessrPhase;
  roundNumber: number;
  pendingSubmitterPlayerId?: string;
  /** 手动出题的选题截止：每次提交尝试都会顺延，过期后回到选出题人并在房间公告里说明。 */
  pendingSubmitterDeadlineAt?: number;
  /** 退回选出题人的原因，随房间快照下发给界面；重新指定出题人即清除。 */
  submitterPrompt?: string;
  currentRound?: SonGuessrRoundRecord;
  roundSummary?: SonGuessrRoundSummary;
  finalScores?: SonGuessrScore[];
  musicAuthOperations?: Record<string, symbol>;
  /**
   * 音乐账号池：每个玩家自愿贡献的账号各一条，条目带第三方 `cookie`。
   *
   * 只在内存里；落盘前整段丢弃（见 `exportSnapshots`），下发快照时只给
   * `SonGuessrMusicPoolView` 那一层，不含凭据。
   */
  musicPool?: SonGuessrMusicPoolEntry[];
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

export type SongUpdateSettingsPayload = Extract<
  SonGuessrClientMessage,
  { type: "song.room.updateSettings" }
>["payload"];

export type MusicAuthPlatform = "netease" | "qq";

/**
 * 在途登录操作在房间记录里的键。
 *
 * 按「人 + 平台」区分，而不是按平台：账号池是多人各自贡献自己的号，
 * 同房两个玩家同时登录网易云是完全正常的并发，按平台一把锁会让先来的人
 * 被判成「操作已失效」。
 */
export const musicAuthOperationKey = (playerId: string, platform: MusicAuthPlatform) =>
  `${playerId}:${platform}`;

/**
 * 账号池条目：一个玩家贡献的一个平台账号。
 *
 * 只要人在房里、开关开着就参与取号；离房、关开关、掉线超宽限或被风控摘除即刻退出。
 */
export interface SonGuessrMusicPoolEntry {
  playerId: string;
  platform: MusicAuthPlatform;
  cookie: string;
  account: MusicLoginSession["account"];
  /** 贡献者的共享开关；等待阶段由本人改，开局锁死。 */
  enabled: boolean;
  addedAt: number;
  /** 在途上游请求数：取号按最小在途平衡，单号另受并发上限约束。 */
  inFlight: number;
  /** 近期取号结果，只保留最近一组，用于房主面板的成功率。 */
  recentOk: number;
  recentTotal: number;
  /** 风控摘除后的冷却截止；到点前不参与取号，号主重新登录即解除。 */
  cooldownUntil?: number;
  /** 最近一次失败原因。 */
  lastFailureReason?: string;
  /** 最近一次成功校验/续期后写入 Cookie 的时刻；后台续期据此排期。 */
  cookieRefreshedAt?: number;
}

/** 一次取号的租约：用完必须 `release`，否则该号的在途数会漏记、并发上限形同虚设。 */
export interface MusicAccountLease {
  roomId: string;
  cookie: string;
  platform: MusicAuthPlatform;
  playerId: string;
  release: (result: { ok: boolean; reason?: string; code?: string }) => void;
}

/**
 * 开局前复核池内账号所需的一切输入。
 *
 * 只复核**每端当前会被选中的那一号**：复核的意义是「开局前发现凭据已失效」，
 * 池里排在前面的号失效就会被选中，逐个复核只会把开局变慢 N 倍。
 */
export interface MusicSessionRevalidation {
  room: SonGuessrRoomRecord;
  platform: MusicAuthPlatform;
  entry: SonGuessrMusicPoolEntry;
  operation?: symbol;
  /** 只用于失败文案里的平台名。 */
  label: string;
  verifySession: (platform?: MusicAuthPlatform) => void;
  getLoginStatus: (
    cookie: string,
    platform?: MusicAuthPlatform,
    options?: { forceRefresh?: boolean }
  ) => Promise<MusicLoginSession>;
}

export const clampInt = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, Math.round(value)));

export const cloneSettings = (settings: SonGuessrSettings): SonGuessrSettings => ({
  ...settings,
  autoFilters: {
    ...settings.autoFilters,
    playlist: settings.autoFilters.playlist ? { ...settings.autoFilters.playlist } : undefined,
    artists: settings.autoFilters.artists.map((artist) => ({ ...artist })),
  },
  animeAutoFilters: settings.animeAutoFilters
    ? {
        ...settings.animeAutoFilters,
        trackKinds: [...(settings.animeAutoFilters.trackKinds ?? ALL_BANGUMI_TRACK_KINDS)],
      }
    : undefined,
});

export const AUTO_POPULARITY_LOOKUP_LIMIT = 24;
/**
 * 自动出题时最多尝试的番剧候选数：每个候选都要完整跑一遍关联歌曲解析，须设上界。
 */
export const AUTO_ANIME_CANDIDATE_LIMIT = 5;
/**
 * 自动出题时最多尝试的歌曲候选数，语义与 `AUTO_ANIME_CANDIDATE_LIMIT` 对齐。
 */
export const AUTO_SONG_CANDIDATE_LIMIT = 5;
/**
 * 「最近不出」窗口相对候选池的目标占比。
 *
 * 固定的 10 首窗口在池子远大于 10 时几乎不消耗池子容量：1000 首的歌单
 * 仍然从第 12 轮起就允许重现已出过的歌。窗口按池子线性放长后，
 * 「不重复」才真正用满池子容量 —— 池 990 时前 495 轮都不会出现旧歌。
 */
export const RECENT_SONG_WINDOW_RATIO = 0.5;
/**
 * 「最近不出」窗口下限。
 *
 * 小池子本来就装不满窗口（池 15 时 10 首已占三分之二），继续缩短只会让
 * 旧歌更早回来；而池子耗尽后总重复次数只由轮数决定、与窗口长度无关，
 * 因此小池子保留原有的 10 首行为不变。
 */
export const MIN_RECENT_SONG_WINDOW = 10;
/**
 * 「最近不出」窗口上限。房间是纯内存态，需要给窗口一个与池子无关的上界，
 * 避免超大歌单把每个房间的最近列表撑成任意长度。
 */
export const MAX_RECENT_SONG_WINDOW = 500;

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
export const isUnusableSongCandidate = (error: unknown): boolean =>
  error instanceof AppError &&
  (error.code === "SONG_UNAVAILABLE" || error.code === "SONG_NOT_FOUND");
/**
 * 单条连接在一分钟内允许的「客户端可触发」音乐类命令次数。
 *
 * 只卡命令入口，不卡出题解析器内部的上游调用：后者只由房主的
 * `song.game.start` / `nextRound` 间接触发，不是滥用面。
 */
export const MUSIC_RATE_LIMIT_PER_CONNECTION = 20;
export const MUSIC_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * 单号并发上限：同一个贡献账号同时最多几个在途上游请求。
 * 多号房间的总容量是 3 × 账号数；单号并发再高会让同一份 cookie 触发风控，
 * 因此不随池子大小改变单号口径。
 */
export const MUSIC_POOL_MAX_IN_FLIGHT = 3;
/**
 * 等号超时：所有可用号都打满时请求在这里排队，到点仍无空位就取在途最少的可用号
 * 直接跑，交给 provider 自己的队列——**不要因为繁忙降级**。
 */
export const MUSIC_POOL_QUEUE_TIMEOUT_MS = 8_000;
/** 该号不可用后的冷却时长：这段时间里不参与取号；风控与限流到点自动恢复，凭据判死要号主重新登录。 */
export const MUSIC_POOL_COOLDOWN_MS = 5 * 60_000;

/**
 * QQ 凭证主动续期节奏。QQ 的 musickey 寿命比网易云短得多，不能只等开局复核：
 * 每 6 小时检查一次、每 10 分钟扫一轮，保证长时间开着的房间在 key 过期前换新。
 */
export const MUSIC_SESSION_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
export const MUSIC_SESSION_REFRESH_SWEEP_MS = 10 * 60_000;
/** 同账号重传时，服务端 24 小时内续期过的 Cookie 优先于客户端本机旧副本。 */
export const MUSIC_COOKIE_FRESH_MS = 24 * 60 * 60_000;
/** 成功率只统计最近这么多次取号，避免历史战绩把当前状态淹没。 */
export const MUSIC_POOL_STATS_WINDOW = 20;

/** 房间因空闲被关闭前的预警提前量。 */
export const ROOM_EXPIRING_WARNING_MS = 60_000;

/** 音频就绪宽限期：超时仅强制置为可答题并启动倒计时，绝不扣减猜测配额。 */
export const AUDIO_READY_GRACE_MS = 15_000;
/**
 * 手动出题的选题时限。
 *
 * 出题人在这个阶段是全房唯一的推进者，房主也无法改选别人，因此闸门必须宽松到容得下
 * 一次慢的上游回源（猜番解析最坏可达数十秒），又不能无限期挂着整个房间。
 * 时限从「指定出题人」起算，每次提交尝试顺延，超时后自动回到选出题人。
 */
export const SUBMIT_SONG_TIMEOUT_MS = 180_000;
/** 每个猜测窗口的兜底裕量：覆盖该次猜测回源校验的往返与卡死的上游请求。 */
export const ROUND_HARD_TIMEOUT_MARGIN_S = 20;
/**
 * 单次番剧歌曲解析允许发起的上游搜索次数（一次搜索只对应一个上游请求，成本最低）。
 */
export const ANIME_SONG_SEARCH_BUDGET = 24;
/**
 * 单次番剧歌曲解析允许回源验证的候选歌曲数量。每次验证都要拉取完整歌曲详情
 * （详情 + 百科 + 热度 + 歌词 + 音频，约 5~6 个上游请求），成本远高于一次搜索，
 * 必须与搜索预算分开设上限。
 */
export const ANIME_SONG_DETAIL_BUDGET = 6;
/** 同一曲目内最多验证的候选版本数（按原版优先排序后从前到后）。 */
export const ANIME_TRACK_DETAIL_ATTEMPTS = 3;
/** 单次番剧歌曲解析最多处理的关联曲目数（超出部分在随机洗牌后等概率落选）。 */
export const ANIME_TRACK_LOOKUP_LIMIT = 24;
/** 关联曲目检索每次取回的结果数：过小会漏掉原版，过大只是白解析。 */
export const ANIME_SONG_SEARCH_LIMIT = 24;
/**
 * 候选歌曲发行年与番剧首播年的最大允许偏差（年）。番剧 OP/ED 通常与番剧同年或前后
 * 一两年，**同名不同曲**的错配往往差十几二十年。取 10 是刻意宽松的上界：既挡住跨代
 * 错配，又保留若干年后的纪念盘/精选集这类同一首歌的合法再版（用 `>` 判定，偏差
 * 正好 10 年不拦）。
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
  animeYear: number | undefined
): boolean => {
  if (releaseYear === undefined || animeYear === undefined) return false;
  return Math.abs(releaseYear - animeYear) > MAX_RELEASE_YEAR_DRIFT;
};

export const direction = (guess?: number, answer?: number): SongGuessDirection => {
  if (guess === undefined || answer === undefined) return "unknown";
  if (guess === answer) return "equal";
  return guess < answer ? "higher" : "lower";
};
