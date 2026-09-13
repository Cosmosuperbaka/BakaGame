import { AppError } from "../domain/Errors";
import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import PQueue from "p-queue";
import { describeError, type EventLogger } from "./EventLogger";
import type {
  SongDetails,
  SongArtistSearchResult,
  SongEncyclopedia,
  SonGuessrMusicAccount,
  SongLyricLine,
  SongPlaylistInfo,
  SongSearchResult,
  SongChorus,
} from "../shared/Index";

type ApiResponse = { body?: unknown } | unknown;
type ApiFunction = (params: Record<string, unknown>) => Promise<ApiResponse>;
type ApiModule = Record<string, unknown>;

export interface MusicProvider {
  search(keyword: string, limit?: number, cookie?: string): Promise<SongSearchResult[]>;
  getSong(songId: string, cookie?: string): Promise<SongDetails>;
  refreshSongAudio?(songId: string, cookie?: string): Promise<string>;
  getSongMetadata(songId: string, cookie?: string): Promise<SongDetails>;
  getSongPopularity?(songId: string, cookie?: string): Promise<number | undefined>;
  getSongChorus?(songId: string, cookie?: string): Promise<SongChorus | undefined>;
  createQrLogin?(): Promise<MusicQrLogin>;
  checkQrLogin?(key: string): Promise<MusicQrLoginCheck>;
  getLoginStatus?(cookie: string): Promise<MusicLoginSession>;
  uploadDeviceInfo?(cookie: string, deviceName?: string): Promise<boolean>;
  getPlaylistSongs?(playlistId: string, cookie?: string): Promise<{ info: SongPlaylistInfo; songs: SongSearchResult[] }>;
  searchArtists?(keyword: string, limit?: number, cookie?: string): Promise<SongArtistSearchResult[]>;
  getArtistSongs?(artistId: string, cookie?: string): Promise<SongSearchResult[]>;
}

export interface NeteaseMusicProviderOptions {
  loadApi?: () => Promise<ApiModule>;
  logger?: EventLogger;
  now?: () => number;
  random?: { nextFloat?: () => number };
  /** 网易云登录设备展示名称，默认 BakaGame。 */
  deviceName?: string;
  /** 通过 Enhanced API 的随机中国出口降低网易云安全风控误判。默认开启。 */
  randomCNIP?: boolean;
  /** 单个 provider 允许同时访问网易云的请求数。 */
  maxConcurrentRequests?: number;
  /** 两次上游请求启动之间的最小间隔。 */
  minRequestIntervalMs?: number;
  /** 首次遇到上游限流后的冷却时间；连续限流会指数增长。 */
  rateLimitCooldownMs?: number;
  maxRateLimitCooldownMs?: number;
  /** 等待队列的容量和最长停留时间，避免限流恢复后集中补发陈旧请求。 */
  maxQueuedRequests?: number;
  queueTimeoutMs?: number;
  cacheMaxEntries?: number;
  cacheMaxBytes?: number;
  /** 是否开启全局音乐解灰，默认开启。针对无版权、VIP试听或无可用地址的歌曲自动尝试匹配跨平台可用音源。 */
  enableGeneralUnblock?: boolean;
}

export interface MusicLoginSession {
  cookie: string;
  account: SonGuessrMusicAccount;
}

export interface MusicQrLogin {
  key: string;
  qrUrl: string;
  qrImage: string;
}

export interface MusicQrLoginCheck {
  status: "waiting" | "scanned" | "expired" | "authorized";
  message: string;
  session?: MusicLoginSession;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const readString = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};

const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const randomChineseIp = (random?: { nextFloat?: () => number }) => {
  const rand = random?.nextFloat ?? Math.random;
  return [
    116,
    25 + Math.floor(rand() * 70),
    Math.floor(rand() * 256),
    Math.floor(rand() * 256),
  ].join(".");
};


const SEARCH_CACHE_TTL_MS = 6 * 60 * 60_000;
const SONG_METADATA_CACHE_TTL_MS = 24 * 60 * 60_000;
const SONG_LYRICS_CACHE_TTL_MS = 24 * 60 * 60_000;
const SONG_WIKI_CACHE_TTL_MS = 3 * 24 * 60 * 60_000;
const COLLECTION_CACHE_TTL_MS = 6 * 60 * 60_000;
const ARTIST_SONGS_CACHE_TTL_MS = 24 * 60 * 60_000;
const POPULARITY_CACHE_TTL_MS = 6 * 60 * 60_000;
const SONG_CHORUS_CACHE_TTL_MS = 3 * 24 * 60 * 60_000;
const AUDIO_URL_CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_CACHE_MAX_ENTRIES = 512;
const DEFAULT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 3;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 100;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5_000;
const DEFAULT_MAX_RATE_LIMIT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_QUEUED_REQUESTS = 64;
const DEFAULT_QUEUE_TIMEOUT_MS = 8_000;

type CacheEntry = {
  value: unknown;
  softExpireAt: number;
  hardExpireAt: number;
  lastAccessAt: number;
  hits: number;
  priority: number;
  size: number;
};

const cloneCacheValue = <T>(value: T): T => value === undefined ? value : structuredClone(value);

const normalizeHttpsUrl = (value: unknown): string | undefined => {
  const raw = readString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    // 网易云接口仍可能返回 HTTP 图片或音频；HTTPS 页面会将其作为混合内容直接拦截或告警。
    if (url.protocol === "http:") url.protocol = "https:";
    return url.toString();
  } catch {
    return raw.startsWith("http://") ? `https://${raw.slice(7)}` : raw;
  }
};

const normalizeAudioUrl = normalizeHttpsUrl;

const responseBody = (response: ApiResponse): Record<string, unknown> => {
  const record = asRecord(response);
  return asRecord("body" in record ? record.body : response);
};

const responseCookie = (response: ApiResponse): string | undefined => {
  const record = asRecord(response);
  const body = responseBody(response);
  const bodyCookie = readString(body.cookie);
  if (bodyCookie) return bodyCookie;
  const cookies = asArray(record.cookie)
    .map(readString)
    .filter((entry): entry is string => Boolean(entry));
  return cookies.length > 0 ? cookies.join(";") : undefined;
};

const responseCode = (body: Record<string, unknown>): number | undefined => {
  const direct = readNumber(body.code);
  if (direct !== undefined) return direct;
  return readNumber(asRecord(body.data).code);
};

const responseMessage = (body: Record<string, unknown>, fallback: string) =>
  readString(body.message ?? body.msg) ??
  readString(asRecord(body.data).message ?? asRecord(body.data).msg) ??
  fallback;

const musicLoginError = (body: Record<string, unknown>, fallback: string) => {
  const code = responseCode(body);
  const risk = code === 8810 || code === 10004;
  return new AppError(
    risk ? "MUSIC_LOGIN_RISK" : "MUSIC_LOGIN_FAILED",
    risk
      ? "网易云已拦截当前网络环境的登录请求，请稍后重试"
      : responseMessage(body, fallback),
    { upstreamCode: code },
  );
};

const readLoginAccount = (body: Record<string, unknown>): SonGuessrMusicAccount => {
  const data = asRecord(dataRecord(body));
  const profile = asRecord(body.profile ?? data.profile);
  const nickname = readString(profile.nickname) ?? "网易云用户";
  return {
    userId: readString(profile.userId ?? profile.id),
    nickname,
    avatarUrl: normalizeHttpsUrl(profile.avatarUrl ?? profile.avatar),
  };
};

const dataRecord = (body: Record<string, unknown>) => asRecord(body.data);

const readVipAccount = (
  raw: unknown,
  account: SonGuessrMusicAccount,
  now = Date.now(),
): SonGuessrMusicAccount => {
  const body = asRecord(raw);
  const data = asRecord(body.data ?? raw);
  const memberships = [
    asRecord(data.associator),
    asRecord(data.musicPackage),
    asRecord(data.redplus),
    asRecord(data.albumVip),
  ];
  const active = memberships.filter((membership) => {
    const code = readNumber(membership.vipCode ?? membership.vipType ?? membership.code) ?? 0;
    const expireTime = readNumber(membership.expireTime ?? membership.expire ?? membership.endTime);
    return code > 0 && (expireTime === undefined || expireTime > now);
  });
  const vipType = active
    .map((membership) => readNumber(membership.vipCode ?? membership.vipType ?? membership.code))
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => right - left)[0];
  const vipExpireTime = active
    .map((membership) => readNumber(membership.expireTime ?? membership.expire ?? membership.endTime))
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => right - left)[0];
  return {
    ...account,
    vipStatus: active.length > 0 ? "vip" : "nonVip",
    vipType,
    vipExpireTime,
  };
};

const artistNames = (song: Record<string, unknown>): string => {
  const artists = asArray(song.ar ?? song.artists ?? song.artist);
  const names = artists
    .map((entry) => readString(asRecord(entry).name) ?? readString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return names.join(" / ") || "未知歌手";
};

const normalizeSong = (value: unknown): SongSearchResult | undefined => {
  const song = asRecord(value);
  const id = readString(song.id);
  const title = readString(song.name ?? song.title);
  if (!id || !title) return undefined;

  const album = asRecord(song.al ?? song.album);
  const privilege = asRecord(song.privilege);
  const fee = readNumber(song.fee ?? privilege.fee);
  return {
    id,
    title,
    artist: artistNames(song),
    album: readString(album.name),
    pictureUrl: normalizeHttpsUrl(album.picUrl ?? album.pic),
    durationMs: readNumber(song.dt ?? song.duration),
    requiresVip: fee === 1,
  };
};

const normalizeComparableText = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_—–/:：·.'"“”‘’()（）\[\]【】]/g, "");

/**
 * 署名行会暴露创作人员，属于必须剔除的无效歌词。
 *
 * 旧的实现是一张穷举词表并要求行首紧跟分隔符，实战中大量漏网：
 * `翻策 / 美工 / 题字 / 后期 / 翻唱` 这类同人圈标签不在表内，
 * `【翻唱】X`、全角空格缩进的 `　作词：X`、多标签的 `策划/统筹：X` 又因为
 * 前缀与分隔符形态不合规而整条失效。因此改为分层判定：
 *
 * 1. 先剥离行首装饰（书名号、括号、项目符号）与合并多标签，得到规范化的标签头部；
 * 2. 词表命中即判定为署名（快速路径，覆盖绝大多数已知标签）；
 * 3. 词表未命中的，走结构判定 `isCreditStructuredLine`，用「短标签 + 分隔符 + 空格分隔的人名串」
 *    这一稳定结构兜底，避免词表永远追不上新造的同人圈标签。
 */
const CREDIT_LABEL_SOURCE = [
  // 词曲编录混等通用音乐署名
  "作词(?:人)?", "填词", "词曲", "词", "作曲(?:人)?", "谱曲", "曲",
  "编曲(?:人|师)?", "制作人", "制作", "监制", "统筹", "发行", "出品", "策划", "企划",
  // 复合标签：网易云常见 `音乐制作：X`、`音乐监制：X`、`专辑封面设计：X` 这类带限定前缀的写法。
  // 单独登记而不放宽 `isCreditLabelOnly` 的「覆盖整个头部」约束，避免 `音乐响起：` 这类歌词被误杀。
  "音乐制作", "音乐监制", "音乐指导", "音乐统筹", "音乐总监",
  "专辑制作", "专辑封面(?:设计)?", "封面设计", "视觉设计",
  "合作音乐人", "特邀", "参演", "配音",
  "配唱(?:编写)?", "制作协力", "低音吉他", "第一小提琴", "第二小提琴", "中提琴", "大提琴",
  // `录音(?:师|棚|室)?` 必须保留可选后缀形态：它同时覆盖 `录音师`/`录音棚`/`录音室`，
  // 不要改写成逐个字面量，否则 `录音棚：C.L.K` 这类取值含点的行会掉出词表路径
  // （结构判定因取值含 `.` 而否决）。
  "混音(?:师)?", "录音(?:师|棚|室)?", "混音室", "母带(?:处理|工程师)?", "和声(?:编写)?",
  "吉他", "贝斯", "鼓", "弦乐(?:编写)?", "乐器",
  "版权管理方", "版权", "版权方", "录音作品", "录音制品", "版权代理", "授权",
  // 演唱与同人/翻唱圈署名
  "演唱", "主唱", "歌手", "翻唱", "翻策", "原唱", "原曲", "本家",
  "美工", "题字", "后期", "海报", "封面", "曲绘", "插画", "绘图",
  "视频", "压制", "字幕", "轴", "翻译", "校对", "文案", "调教", "调校", "pv",
  "后援", "协力", "协助", "鸣谢", "致谢", "特别感谢", "出品方", "制作方", "发行方",
  "男", "女", "合", "合唱", "对唱", "独唱", "童声", "念白",
  // 英文署名
  "op", "sp", "publisher", "cast", "staff",
  "lyric(?:s|ist)?", "composer", "arranger", "producer",
  "vocal(?:s|ist)?", "vocaloid", "illustration", "artwork", "movie",
  "mixing", "mastering", "programming", "recording", "engineer(?:ing)?",
  "keyboards?(?:\\s*&\\s*programming)?", "programmed", "drums?", "bass", "guitars?",
  "percussion", "strings?", "piano", "violin", "cello",
  "thanks?(?:\\s+to)?", "special\\s+thanks",
  "production\\s+coordination", "recorded\\s+at", "engineered\\s+by",
  "mixed\\s+by", "mastered\\s+by", "lyrics?\\s+by", "music\\s+by",
  "written\\s+by", "produced\\s+by", "composed\\s+by", "arranged\\s+by",
  "performed\\s+by", "vocals?\\s+recorded\\s+at",
].join("|");

/**
 * 正则的可选分支按「先长后短」排序，避免短标签抢先匹配。
 * 例：`sp` 会以忽略大小写的方式吃掉 `Special Thanks` 的开头，`曲` 会吃掉 `曲绘`。
 */
const sortLongestFirst = (source: string): string => {
  const splitAlternatives = (value: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (char === "\\") {
        current += char + (value[index + 1] ?? "");
        index += 1;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "|" && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
      current += char;
    }
    parts.push(current);
    return parts;
  };
  return splitAlternatives(source).sort((a, b) => b.length - a.length).join("|");
};

const CREDIT_LABEL_ALTERNATIVES = sortLongestFirst(CREDIT_LABEL_SOURCE);

/** 单个署名标签，允许两类常见复合形态：
 * - 中英混排后缀：`词Lyricist`、`曲Composer`、`翻唱Cover`
 * - 多标签连接：`策划/统筹`、`作词、作曲`、`监制&混音`、`Mixed & Mastered`
 */
const CREDIT_LABEL_PATTERN = new RegExp(
  `^(?:${CREDIT_LABEL_ALTERNATIVES})(?:\\s*(?:&|＆|and|with)\\s*(?:${CREDIT_LABEL_ALTERNATIVES}))*`,
  "i",
);

/** 紧随中文标签的英文单后缀（`词Lyricist`、`曲Composer`）。 */
const CREDIT_LABEL_SUFFIX_PATTERN = /^(?:[a-z]{2,20})$/i;

/** 多标签连接符：`策划/统筹`、`作词、作曲`、`监制&混音`。 */
const CREDIT_LABEL_JOINER_PATTERN = /[/／、,，&＆]/;

/** 可与并列词组合成复合署名的动作词：`Arranged & Conducted by`、`Mixed & Mastered by`。 */
const CREDIT_ACTION_WORDS = [
  "arranged", "conducted", "mixed", "mastered", "recorded",
  "produced", "written", "composed", "performed", "programmed",
];
// 注意必须用括号包住整组可选分支，否则 `^a|b|...|z$` 只会锚定首尾两项。
const CREDIT_ACTION_PATTERN = new RegExp(`^(?:${CREDIT_ACTION_WORDS.join("|")})$`, "i");

/**
 * 判断头部是否形如 `(乐器)? 动作词 ((&|and) 动作词)* by`，
 * 例如 `Strings Arranged & Conducted by`、`Mixed & Mastered by`。
 * `by` 之后可以还有取值（`Strings Arranged & Conducted by 某某`）。
 */
const isCreditActionPhrase = (value: string): boolean => {
  const normalized = value.trim().replace(/[\s\u3000]+/g, " ");
  // `by` 后面允许紧跟取值，取第一个 `by` 之前的部分作为标签区。
  const byMatch = /^(.*?)\s+by(?:\s|$)/i.exec(normalized);
  if (!byMatch) return false;
  const beforeBy = byMatch[1].trim();
  if (!beforeBy) return false;
  // 允许最前面有一个乐器/声部限定词，随后必须全部是动作词。
  const tokens = beforeBy.split(/\s+/);
  const actionTokens = tokens.filter((token) => !/^[&＆]$/i.test(token) && !/^and$/i.test(token));
  if (actionTokens.length === 0) return false;
  // 首词可以是乐器/声部，其余必须是动作词。
  const actions = CREDIT_ACTION_PATTERN.test(actionTokens[0]) ? actionTokens : actionTokens.slice(1);
  if (actions.length === 0) return false;
  return actions.every((token) => CREDIT_ACTION_PATTERN.test(token));
};

/**
 * 无分隔符的英文署名：`Recorded at ...`、`Engineered by ...`、`Mastered by ...`。
 * 这类行没有冒号，必须按「行首命中已知英文标签」判定。
 *
 * 注意 `Special Thanks` / `Thanks To` 这类**纯致谢行也可能完全没有分隔符**，
 * 不能只依赖带冒号的形态（旧测试只覆盖了 `Special Thanks：某某`，裸写形态长期漏网）。
 */
const STARTS_WITH_CREDIT_ENGLISH_PATTERN = new RegExp(
  `^(?:${[
    "production\\s+coordination",
    "special\\s+thanks?(?:\\s+to)?", "thanks?(?:\\s+to)?",
    "recorded\\s+at", "engineered\\s+by", "mixed\\s+by", "mastered\\s+by",
    "lyrics?\\s+by", "music\\s+by", "written\\s+by", "produced\\s+by",
    "composed\\s+by", "arranged\\s+by", "performed\\s+by",
    "vocals?\\s+recorded\\s+at",
  ].join("|")})(?:\\s|$)`,
  "i",
);

/** 行首装饰：书名号、括号、项目符号与空白。署名行常带这些前缀，必须先剥离。 */
const LEADING_DECORATION_PATTERN = /^[\s\u3000\-—–~～·•*＊=＝+＋|｜/]+|^[【\[（(「『《<]+/;

/** 包裹式标签：`【翻唱】某某`、`（后期）某某`、`[Mixing] John`。 */
const WRAPPED_CREDIT_LABEL_PATTERN = /^[【\[（(「『《<]\s*([^】\]）)」』》>]{1,12}?)\s*[】\]）)」』》>]\s*(.+)$/u;

/** 署名标签与取值之间的分隔符（在标签之后首次出现的位置切分）。 */
const CREDIT_SEPARATOR_PATTERN = /(?::|：|-|—|–|\||｜|\/|／)/;

/** 会出现在真实歌词里的高频虚词/实义词，用于否决结构判定，避免误杀正常歌词。 */
const LYRIC_STOP_WORDS = [
  "的", "了", "吗", "吧", "呢", "啊", "呀", "哦", "嘛", "么", "着", "过", "得",
  "我", "你", "他", "她", "它", "们", "谁", "这", "那", "什么", "怎么", "为",
  "是", "不", "没", "有", "在", "就", "都", "很", "会", "说", "想", "要", "能",
  "起", "来", "去", "给", "被", "让", "把", "和", "但", "也", "还", "又", "只",
  "如", "若", "却", "而", "与", "或", "每", "各", "些", "个", "里", "外",
  "心", "爱", "梦", "风", "雨", "夜", "天", "光", "声", "家", "人", "情",
  "the", "and", "you", "me", "we", "is", "are", "to", "of", "in", "on", "for",
];

/** 判断取值片段是否含歌词高频虚词；命中则说明它更像正常歌词而非人名。 */
const hasLyricStopWord = (value: string): boolean =>
  LYRIC_STOP_WORDS.some((word) => value.includes(word));

/**
 * 剥离行首装饰或包裹式括号后返回 `标签\u0000取值`；无法拆分时返回 undefined。
 * 顺序很重要：包裹式标签必须先于装饰剥离判断，否则 `【翻唱】X` 会被剥成 `翻唱】X`。
 */
const splitCreditHead = (text: string): string | undefined => {
  const trimmed = text.trim();

  // 包裹式：`【翻唱】某某` 没有分隔符，靠括号定位标签边界。
  const wrapped = WRAPPED_CREDIT_LABEL_PATTERN.exec(trimmed);
  if (wrapped) return `${wrapped[1].trim()}\u0000${wrapped[2].trim()}`;

  const undecorated = trimmed.replace(LEADING_DECORATION_PATTERN, "").trim();
  const separatorMatch = CREDIT_SEPARATOR_PATTERN.exec(undecorated);
  if (!separatorMatch) return undefined;
  const head = undecorated.slice(0, separatorMatch.index).trim();
  const tail = undecorated.slice(separatorMatch.index + separatorMatch[0].length).trim();
  if (!head || !tail) return undefined;
  return `${head}\u0000${tail}`;
};

/** 判断标签头部是否「完全由署名标签构成」。 */
const isCreditLabelOnly = (value: string): boolean => {
  if (!value) return false;

  // 中英混排：中文标签直接拼接英文标签，如 `曲Composer`、`词Lyricist`、`翻唱Cover`。
  // 首字符必须是中日文字符，否则 `Special Thanks` 会被误拆成 `S` + `pecial Thanks`。
  const composite = /^([\u4e00-\u9fff\u3040-\u30ff])[A-Za-z][A-Za-z\s]*$/u.exec(value);
  if (composite) {
    const englishPart = value.slice(1).trim();
    if (isCreditLabelOnly(composite[1]) && isCreditLabelOnly(englishPart)) return true;
  }

  // 多词英文标签：`Special Thanks`、`Mixed By`、`Production Coordination`。
  // 匹配前压掉空格，兼容 `specialthanks` 这类上游已去掉空格的形式。
  const compact = value.replace(/[\s\u3000]+/g, "");
  const wholeLabel = CREDIT_LABEL_PATTERN.exec(value)?.[0].replace(/[\s\u3000]+/g, "");
  if (wholeLabel === compact) return true;

  // `Arranged & Conducted by` 这类并列动作短语。
  if (isCreditActionPhrase(value)) return true;

  // 逐段拆分连接符，任一段是「已知标签 或 接在已知标签后的英文单后缀」即可。
  const segments = value.split(CREDIT_LABEL_JOINER_PATTERN).filter(Boolean);
  if (segments.length === 0) return false;
  let previousWasLabel = false;
  for (const segment of segments) {
    const compactSegment = segment.replace(/[\s\u3000]+/g, "");
    if (CREDIT_LABEL_PATTERN.exec(segment)?.[0].replace(/[\s\u3000]+/g, "") === compactSegment) {
      previousWasLabel = true;
      continue;
    }
    if (previousWasLabel && CREDIT_LABEL_SUFFIX_PATTERN.test(compactSegment)) continue;
    return false;
  }
  return true;
};

/** 头部恰好是纯角色词（`合`、`男`、`合唱`），用于区分「角色标注」与「角色标记 + 歌词」。 */
const DUET_ROLE_LABEL_PATTERN =
  /^(?:男|女|合|合唱|对唱|独唱|童声|念白|所有人|大家一起)$/u;

/**
 * 取值侧是否含有「实质歌词内容」。
 *
 * 判定标准刻意宽松：只要有效字符达到 4 个以上，就认为右侧是歌词正文而非人名。
 * 制作名单的取值是人名（通常 2~4 字，且多以分隔符并列），不会是一整句歌词；
 * 而 `【合】有英雄漂泊异乡 故土遥远` 的右侧是一整句，必须归为歌词。
 */
const isSubstantiveLyricTail = (tail: string): boolean => {
  const compact = tail
    .normalize("NFKC")
    .replace(/[\s\u3000\p{P}\p{S}]/gu, "");
  return compact.length >= 4;
};

/** 词表命中的署名行（含行首装饰剥离、包裹式标签与多标签合并）。 */
export const isCreditKeywordLine = (text: string): boolean => {
  const undecorated = text.trim().replace(LEADING_DECORATION_PATTERN, "").trim();

  // `Strings Arranged & Conducted by 某某` 这类没有冒号的英文署名，先整行判定。
  if (isCreditActionPhrase(undecorated)) return true;
  if (STARTS_WITH_CREDIT_ENGLISH_PATTERN.test(undecorated)) return true;

  const parts = splitCreditHead(text);
  if (!parts) return false;
  const [head, tail] = parts.split("\u0000");
  // 只压缩空白，不能整体删除：`Special Thanks` 这类多词英文标签依赖词间空格。
  const normalizedHead = head.normalize("NFKC").replace(/[\s\u3000]+/g, " ").trim();
  if (!normalizedHead) return false;
  // 标签必须覆盖整个头部，避免「曲终人散：」这类以署名词开头的正常歌词被误判。
  if (!isCreditLabelOnly(normalizedHead)) return false;

  // 角色词（男/女/合/合唱…）单独成标签时，只可能是「空取值」的分工标注。
  // `【合】有英雄漂泊异乡`、`【男】让我用心把你留下来` 这类是**真实歌词**
  // （角色标记 + 歌词正文），若按标签命中整行剔除会大面积误杀合唱段落。
  // 因此当头部是纯角色词、且取值侧存在实质歌词内容时，拒绝判定为署名行。
  if (DUET_ROLE_LABEL_PATTERN.test(normalizedHead) && isSubstantiveLyricTail(tail)) {
    return false;
  }
  return true;
};

/**
 * 结构判定：`短标签 + 分隔符 + 空格分隔的人名串`。
 *
 * 真实歌词极少出现「无谓语标签 + 冒号 + 纯空格分隔的短片段」这种形态，而制作名单
 * 几乎全是这个结构（`翻唱：悼子\ワカイ调和剂\夙夜\浅安` 在网易云里就是空格分隔）。
 * 为防止误杀，同时要求：标签不含标点与数字、行内不含歌词高频虚词、右侧每个片段都不含虚词。
 */
export const isCreditStructuredLine = (text: string): boolean => {
  const parts = splitCreditHead(text);
  if (!parts) return false;
  const [head, tail] = parts.split("\u0000");

  const normalizedHead = head.normalize("NFKC").trim();
  const compactHead = normalizedHead.replace(/[\s\u3000]/g, "");
  if (/[，。！？；、,.!?;:："'“”]/u.test(compactHead)) return false;
  if (/\d/.test(compactHead)) return false;
  if (!/^[\u4e00-\u9fffA-Za-z\u3040-\u30ff]{1,6}$/u.test(compactHead)) return false;

  const normalizedTail = tail.normalize("NFKC").trim();
  if (!normalizedTail) return false;
  if (/[，。！？；,.!?;]/u.test(normalizedTail)) return false;

  const segments = normalizedTail.split(/[\s\u3000\\／/|｜、,，&＆]+/u).filter(Boolean);
  // 单段时要求排除虚词（`混音：张三` 这类单人名仍会被词表路径捕获），
  // 多段时只否定含虚词的片段，避免「悼子\夙夜」这种真名被虚词表误伤。
  if (segments.length === 1 && hasLyricStopWord(segments[0])) return false;
  if (segments.some((segment) => segment.length > 8 || hasLyricStopWord(segment))) return false;

  return true;
};

/** 过滤会直接暴露创作人员的 LRC 署名行。 */
export const isCreditLyricLine = (text: string) =>
  isCreditKeywordLine(text) || isCreditStructuredLine(text);

/**
 * 单行是否属于「不可用于出题」的无效歌词。
 *
 * 与 `sanitizeLyrics` 使用同一套单行判定，供出题侧在选取歌词窗口时二次校验，
 * 避免 24 小时歌词缓存里的历史脏数据被截取。
 */
export const isUnusableLyricLine = (text: string): boolean =>
  isCreditLyricLine(text) ||
  isCopyrightNoticeLine(text) ||
  isDuetRoleLine(text) ||
  isInstrumentalLyricLine(text) ||
  isSymbolOnlyLyricLine(text) ||
  isNumericOnlyLyricLine(text) ||
  isBopomofoOnlyLyricLine(text) ||
  isPlaceholderMaskLyricLine(text) ||
  isBracketedStageDirectionLine(text) ||
  isTooShortLyricLine(text);

const INSTRUMENTAL_MARKERS = new Set([
  "music",
  "instrumental",
  "interlude",
  "intro",
  "outro",
  "inst",
  "伴奏",
  "间奏",
  "前奏",
  "尾奏",
  "纯音乐",
  "器乐",
]);

/** 过滤 LRC 中表示间奏/纯音乐的占位行，避免把无歌词段落当作可猜片段。 */
export const isInstrumentalLyricLine = (text: string) => {
  const normalized = normalizeComparableText(text);
  if (INSTRUMENTAL_MARKERS.has(normalized)) return true;
  // 网易云会把间奏写成 Music1、[Music] 或 Music - Instrumental 等占位文本。
  if (/^(?:music|instrumental|interlude|intro|outro|inst)(?:\d+)?$/.test(normalized)) return true;
  if (/^(?:music|instrumental|interlude|intro|outro|inst)(?:music|instrumental|interlude|intro|outro|inst)$/.test(normalized)) return true;
  // `纯音乐，请欣赏`、`纯音乐 请欣赏`、`本曲为纯音乐，请欣赏` 这类带后缀的占位说明。
  // `normalizeComparableText` 会保留逗号，因此整串不等于 `纯音乐`，需要单独按前缀判定。
  return /^(?:本曲为|本首歌为|此曲为)?(?:纯音乐|純音樂|纯音乐请欣赏)/.test(normalized);
};

/** 纯符号行（`~~~~`、`...`、`— — —`、`· · ·`）没有任何可猜信息。 */
export const isSymbolOnlyLyricLine = (text: string) =>
  /^[\s\u3000~～·•*＊=＝+＋#＃\-—–─_＿.,，。!！?？…、;；:：'"“”‘’()（）\[\]【】<>《》/／\\|｜]+$/u.test(text);

/** 只由数字与单位/括号构成的行（如 `00:12`、`120 bpm`）不承载歌词内容。 */
export const isNumericOnlyLyricLine = (text: string) => {
  const stripped = text
    .normalize("NFKC")
    .replace(/[\s\u3000()（）\[\]【】,.，、:：]/gu, "")
    .replace(/(?:s|sec|min|kbps|hz|bpm|khz|fps)/giu, "");
  return stripped.length > 0 && /^\d+$/u.test(stripped);
};

/**
 * 占位遮罩行：整行由**同一个 ASCII 字母重复 ≥3 次**构成（`XXXXXXXXX`、`xxx`、`OOOOOO`）。
 *
 * 网易云上大量用户上传谱会把未填写的段落写成这种遮罩，它没有任何可猜信息。
 * 判定要求「整行（去掉空白与连接符后）只由同一字母组成且长度 ≥3」，
 * 这样 `X你太美`、`xxxxx我爱你`、`XXXXXXXXXXXXXXXXXX你好` 这类含实际文字的行不会被误杀。
 */
export const isPlaceholderMaskLyricLine = (text: string): boolean => {
  const stripped = text.normalize("NFKC").replace(/[\s\u3000\-—–_.,，、]/gu, "");
  if (stripped.length < 3) return false;
  return /^([A-Za-z])\1+$/u.test(stripped);
};

/** 舞台指示/编辑注记的固定词汇：`(Repeat)`、`（以下反复）`、`(silence)`、`(间奏)`。 */
const STAGE_DIRECTION_SOURCE = [
  "repeat", "silence", "silent", "instrumental", "interlude", "intro", "outro",
  "fade", "fadeout", "fade in", "fade out", "spoken", "whisper", "echo",
  "以下反复", "以下重复", "间奏", "前奏", "尾奏", "反复", "重复", "此处",
  "略", "待补", "待定", "无歌词", "看不懂", "听不清", "念白",
].join("|");

const STAGE_DIRECTION_PATTERN = new RegExp(`^(?:${STAGE_DIRECTION_SOURCE})$`, "i");

/**
 * 整行被一对括号完整包裹的舞台指示行。
 *
 * 网易云上大量上传谱把说明性文字整行写在括号里，例如
 * `(何が綴られていたのか、私たちの文明では到底理解できない)`、`（以下反复）`、`(Repeat)`。
 * 这些句子不含任何可猜的歌词内容，且**会暴露段落结构**，必须剔除。
 *
 * 但括号在真实歌词里同样常见（和声、重复句、英文衬词），所以判定必须保守：
 * 只有满足以下任一条才剔除，且内层不能含中日文字符串之外的自然语气：
 * 1. 内层命中舞台指示词表；
 * 2. 内层含 `、`/`,`/`，` 这类**并列或断句**标点（真实歌词的括号内容极少是长句）。
 *
 * `（啦啦啦）`、`(你是我的眼)`、`(Oh yeah baby)`、`（爱してる）` 都因不满足以上条件而保留。
 */
export const isBracketedStageDirectionLine = (text: string): boolean => {
  const wrapped = /^[（(\[【「『《<]\s*([\s\S]*?)\s*[）)\]】」』》>]$/u.exec(text.trim());
  if (!wrapped) return false;
  const inner = wrapped[1].trim();
  if (!inner) return false;

  // 内层若本身是纯符号/纯遮罩，交给各自的判定，避免重复归类。
  if (/^[\p{P}\p{S}\s\u3000]+$/u.test(inner)) return false;

  if (STAGE_DIRECTION_PATTERN.test(inner)) return true;

  // 并列/断句标点：真实歌词的括号内容极少出现需要断句的长句。
  return /[、,，;；]/u.test(inner);
};

/**
 * 有效字符过短的行。
 *
 * 注意：单个汉字/假名在真实歌词里确实存在（`啊`、`喂`、`一`、`二`），
 * 因此这条规则只用于「非中日文字符且有效字符不足 2 个」的情形，
 * 避免把合法的单字歌词一并剔除。判定垃圾行主要依赖署名与符号/数字规则。
 */
export const isTooShortLyricLine = (text: string) => {
  const meaningful = text
    .normalize("NFKC")
    .replace(/[\s\u3000\p{P}\p{S}]/gu, "");
  if (meaningful.length >= 2) return false;
  // 单个中日文字符不视为垃圾行。
  return !/^[\u4e00-\u9fff\u3040-\u30ff]$/u.test(meaningful);
};

/**
 * 整行是署名式的取值片段（人名串），用于把连排制作名单整块剔除。
 *
 * 为免误杀真实歌词（如 `第一句歌词`），这里只接受**明确的多段人名串**：
 * 必须由 `\`、`/`、空格、顿号等分隔出至少 2 段短片段，
 * 或整行是「名字 + 名字」这种无谓语并列。单段连续文本一律视为歌词。
 */
export const isCreditTailLine = (text: string): boolean => {
  if (isCreditLyricLine(text)) return true;
  const trimmed = text.trim().replace(LEADING_DECORATION_PATTERN, "").trim();
  if (!trimmed || /[:：]/u.test(trimmed)) return false;
  // 含句末语气/标点的明显是歌词
  if (/[，。！？；,.!?;、]/u.test(trimmed)) return false;
  const segments = trimmed.split(/[\s\u3000\\／/|｜&＆]+/u).filter(Boolean);
  // 必须是多个短片段；单段连续文本（哪怕很短）视作歌词，避免误杀 `第一句歌词`。
  if (segments.length < 2) return false;
  if (segments.some((segment) => segment.length > 8 || hasLyricStopWord(segment))) return false;
  return trimmed.length <= 40;
};

/** 相邻署名行的合并窗口：制作名单通常连续排布，间隔往往在 3 秒内。 */
const CREDIT_BLOCK_GAP_MS = 3_000;

/**
 * 版权与法律声明的固定短语。
 *
 * 这类行既不像「标签：取值」（`词版权管理方：` 的头部是扩展短语），也不含任何人名，
 * 但它同样把版方/录音制品信息暴露给出题者，必须剔除。用**包含**判定而非前缀判定，
 * 因为实际形态多样：`词版权管理方：X`、`录音作品及MV版权：X`、`（未经许可,不得翻唱或使用）`。
 */
const COPYRIGHT_NOTICE_SOURCE = [
  "版权管理方", "版权代理", "版权方", "录音作品", "录音制品", "录音制作者",
  "未经许可", "未经授权", "不得翻唱", "不得使用", "不得转载", "禁止翻唱",
  "版权所有", "all rights reserved", "copyright", "℗", "©",
  "词版权", "曲版权", "词曲版权", "op：", "sp：",
].join("|");

const COPYRIGHT_NOTICE_PATTERN = new RegExp(COPYRIGHT_NOTICE_SOURCE, "i");

/** 版权/法律声明行：整行命中固定短语即判定无效。 */
export const isCopyrightNoticeLine = (text: string): boolean => {
  const normalized = text.normalize("NFKC").replace(/[\s\u3000]+/g, " ").trim();
  if (!normalized) return false;
  return COPYRIGHT_NOTICE_PATTERN.test(normalized);
};

/**
 * 对唱角色标注行（`男：`、`女：`、`合：`、`合唱：`）。
 *
 * 这类行给出的是演唱分工而非歌词内容，且右侧通常为空，
 * `splitCreditHead` 会因「取值缺失」直接返回 undefined 而漏网。
 */
const DUET_ROLE_PATTERN = /^(?:男|女|合|合唱|对唱|独唱|童声|念白|所有人|大家一起)\s*[:：]\s*$/u;

/**
 * 包裹式角色标注：`【合】`、`（男）`、`[女]`，内层只有一个角色词且**没有取值**。
 *
 * 注意必须要求「括号内仅含角色词」，否则 `【合】有英雄漂泊异乡` 这类
 * 「角色标记 + 真实歌词」的合唱段落会被整行误杀（实测《千里邀月》踩到）。
 */
const WRAPPED_DUET_ROLE_PATTERN =
  /^[【\[（(「『《<]\s*(?:男|女|合|合唱|对唱|独唱|童声|念白|所有人|大家一起)\s*[】\]）)」』》>]\s*$/u;

export const isDuetRoleLine = (text: string): boolean => {
  const trimmed = text.trim();
  return DUET_ROLE_PATTERN.test(trimmed) || WRAPPED_DUET_ROLE_PATTERN.test(trimmed);
};

/**
 * 注音符号行（`ㄅㄆㄇㄈㄉㄊㄋㄌ`）。
 *
 * 周杰伦《反方向的钟》开头有一段注音符号口白，网易云把它当歌词上传。
 * 它既非符号、也非数字、也不短，但没有任何可猜的中文/日文/拉丁语义。
 */
export const isBopomofoOnlyLyricLine = (text: string): boolean => {
  const stripped = text.normalize("NFKC").replace(/[\s\u3000\p{P}\p{S}]/gu, "");
  return stripped.length > 0 && /^[\u3105-\u312f\u31a0-\u31bf]+$/u.test(stripped);
};

export const parseLrc = (raw: string): SongLyricLine[] => {
  const lines: Array<Omit<SongLyricLine, "endTime">> = [];
  const timePattern = /\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g;

  for (const sourceLine of raw.split(/\r?\n/)) {
    const timestamps = [...sourceLine.matchAll(timePattern)];
    const text = sourceLine.replace(timePattern, "").trim();
    if (!text || timestamps.length === 0) continue;

    for (const timestamp of timestamps) {
      const minutes = Number(timestamp[1]);
      const seconds = Number(timestamp[2]);
      const milliseconds = Number((timestamp[3] ?? "0").padEnd(3, "0"));
      lines.push({
        time: minutes * 60_000 + seconds * 1_000 + milliseconds,
        text,
      });
    }
  }

  lines.sort((left, right) => left.time - right.time);
  return lines.map((line, index) => ({
    ...line,
    endTime: lines[index + 1]?.time ?? line.time + 5_000,
  }));
};

/**
 * 去掉作词、作曲、编曲等署名，以及会直接暴露答案的歌名行。
 * 过滤后重新计算每句结束时间，避免被删除的元数据行造成音频切片错位。
 *
 * 过滤分四步：单行无效判定（署名 / 间奏 / 符号 / 数字 / 过短）→
 * 连排署名块整体剔除 → 答案泄露剔除 → 重复行去重。
 */
export const sanitizeLyrics = (
  lyrics: SongLyricLine[],
  song: Pick<SongSearchResult, "title" | "artist" | "album">,
): SongLyricLine[] => {
  const title = normalizeComparableText(song.title);
  const album = song.album ? normalizeComparableText(song.album) : "";
  const artistTokens = song.artist
    .split(/[\/,、&与和]/)
    .map(normalizeComparableText)
    .filter((token) => token.length >= 2);
  const wholeArtist = normalizeComparableText(song.artist);

  const forbidden = new Set([
    title,
    wholeArtist,
    ...artistTokens,
    album,
    `${title}${wholeArtist}`,
    `${wholeArtist}${title}`,
  ].filter(Boolean));

  // 第一步：单行无效判定，得到「署名行位置」用于后续连排合并。
  const invalid = lyrics.map((line) => isUnusableLyricLine(line.text));
  const creditLine = lyrics.map((line) => isCreditLyricLine(line.text));

  // 第二步：制作名单常连续排布（截图里连排 5 行），相邻署名行整块剔除，
  // 避免「翻唱」后面的纯人名续行因为不含标签而被漏掉。
  for (let index = 1; index < lyrics.length; index += 1) {
    if (!creditLine[index] && !creditLine[index - 1]) continue;
    if (lyrics[index].time - lyrics[index - 1].time > CREDIT_BLOCK_GAP_MS) continue;
    if (!isCreditTailLine(lyrics[index].text)) continue;
    invalid[index] = true;
  }

  const seen = new Set<string>();
  const filtered = lyrics.filter((line, index) => {
    if (invalid[index]) return false;

    const normalizedLine = normalizeComparableText(line.text);
    if (forbidden.has(normalizedLine)) return false;
    if (title.length >= 2 && normalizedLine.includes(title)) return false;
    for (const token of artistTokens) {
      if (normalizedLine.includes(token)) return false;
    }
    if (album.length >= 2 && normalizedLine.includes(album)) return false;

    // 第三步：重复行去重。副歌反复出现会让同一句占满整个候选窗口，
    // 只保留首次出现，避免出题截到一片重复文本。
    if (seen.has(normalizedLine)) return false;
    seen.add(normalizedLine);
    return true;
  });

  return filtered.map((line, index) => ({
    ...line,
    endTime: filtered[index + 1]?.time ?? Math.max(line.endTime, line.time + 5_000),
  }));
};

const readWiki = (raw: unknown): SongEncyclopedia & { language?: string } => {
  const tags = new Set<string>();
  const aliases = new Set<string>();
  let summary: string | undefined;
  let language: string | undefined;

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const record = asRecord(value);
    if (Object.keys(record).length === 0) return;

    const title = readString(record.title ?? record.name ?? record.key)?.toLowerCase();
    const content = readString(record.content ?? record.text ?? record.value);
    if (title && content) {
      if (title.includes("语种") || title.includes("语言") || title.includes("language")) {
        language = content;
      } else if (title.includes("别名") || title.includes("alias")) {
        content.split(/[、,，/]/).map((item) => item.trim()).filter(Boolean).forEach((item) => aliases.add(item));
      } else if (
        title.includes("曲风") ||
        title.includes("流派") ||
        title.includes("标签") ||
        title.includes("genre") ||
        title.includes("tag")
      ) {
        content.split(/[、,，/]/).map((item) => item.trim()).filter(Boolean).forEach((item) => tags.add(item));
      } else if (!summary && (title.includes("简介") || title.includes("介绍") || title.includes("summary"))) {
        summary = content;
      }
    }

    const metaList = asArray(record.wikiSubMetaVos ?? record.tags);
    metaList.forEach((entry) => {
      const text = readString(asRecord(entry).text ?? asRecord(entry).name ?? entry);
      if (text && !isCreditLyricLine(text)) tags.add(text);
    });

    Object.values(record).forEach(visit);
  };

  visit(raw);
  return {
    summary,
    aliases: aliases.size ? [...aliases] : undefined,
    tags: [...tags],
    language,
  };
};

export class NeteaseMusicProvider implements MusicProvider {
  private apiPromise?: Promise<ApiModule>;
  private readonly randomCNIP: boolean;
  private anonymousCookie?: string;
  private readonly cache: LRUCache<string, CacheEntry>;
  private readonly refreshers = new Map<string, { ttlMs: number; loader: () => Promise<unknown> }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly ipByScope = new Map<string, string>();
  private readonly queue: PQueue;
  private readonly pendingRejections = new Map<number, (error: unknown) => void>();
  private requestIdCounter = 0;
  private readonly maxConcurrentRequests: number;
  private readonly minRequestIntervalMs: number;
  private readonly rateLimitCooldownMs: number;
  private readonly maxRateLimitCooldownMs: number;
  private readonly maxQueuedRequests: number;
  private readonly queueTimeoutMs: number;
  private cooldownUntil = 0;
  private rateLimitStrikes = 0;
  private lastRateLimitAt = 0;
  private lastRateLimitMessage = "操作频繁，请稍候再试";

  readonly deviceName: string;
  private readonly enableGeneralUnblock: boolean;
  private readonly logger?: EventLogger;
  private readonly now: () => number;
  private readonly random: { nextFloat?: () => number };
  private readonly maintenanceTimer: ReturnType<typeof setInterval>;
  private lastUserRequestAt: number;

  constructor(private readonly options: NeteaseMusicProviderOptions = {}) {
    this.deviceName = options.deviceName?.trim() || "BakaGame";
    this.enableGeneralUnblock = options.enableGeneralUnblock ?? (
      typeof process !== "undefined" && process.env?.ENABLE_GENERAL_UNBLOCK !== undefined
        ? process.env.ENABLE_GENERAL_UNBLOCK === "true"
        : true
    );
    if (typeof process !== "undefined" && process.env) {
      process.env.ENABLE_GENERAL_UNBLOCK = String(this.enableGeneralUnblock);
    }
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? { nextFloat: () => Math.random() };
    this.lastUserRequestAt = this.now();
    this.randomCNIP = options.randomCNIP ?? true;
    this.cache = new LRUCache<string, CacheEntry>({
      max: Math.max(1, options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES),
      maxSize: Math.max(1, options.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES),
      sizeCalculation: (entry) => entry.size,
    });
    this.maxConcurrentRequests = Math.max(
      1,
      options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
    );
    this.minRequestIntervalMs = Math.max(
      0,
      options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
    );
    this.rateLimitCooldownMs = Math.max(
      0,
      options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
    );
    this.maxRateLimitCooldownMs = Math.max(
      this.rateLimitCooldownMs,
      options.maxRateLimitCooldownMs ?? DEFAULT_MAX_RATE_LIMIT_COOLDOWN_MS,
    );
    this.maxQueuedRequests = Math.max(
      1,
      options.maxQueuedRequests ?? DEFAULT_MAX_QUEUED_REQUESTS,
    );
    this.queueTimeoutMs = Math.max(1, options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS);
    this.queue = new PQueue({
      concurrency: this.maxConcurrentRequests,
      ...(this.minRequestIntervalMs > 0
        ? { interval: this.minRequestIntervalMs, intervalCap: 1 }
        : {}),
    });
    this.maintenanceTimer = setInterval(() => { void this.runCacheMaintenance(); }, 60_000);
    (this.maintenanceTimer as unknown as { unref?: () => void }).unref?.();
  }

  async search(keyword: string, limit = 20, cookie?: string): Promise<SongSearchResult[]> {
    const normalized = keyword.trim();
    if (!normalized) return [];
    const normalizedLimit = Math.max(1, Math.min(limit, 50));
    return this.cached(
      this.cacheKey("search", cookie, normalized.toLocaleLowerCase(), normalizedLimit),
      SEARCH_CACHE_TTL_MS,
      async () => {
        const response = await this.call(["cloudsearch", "search"], {
          keywords: normalized,
          limit: normalizedLimit,
          type: 1,
        }, cookie);
        const body = responseBody(response);
        const result = asRecord(body.result);
        return asArray(result.songs)
          .map(normalizeSong)
          .filter((song): song is SongSearchResult => Boolean(song));
      },
    );
  }

  async getSong(songId: string, cookie?: string): Promise<SongDetails> {
    const id = songId.trim();
    if (!id) throw new AppError("INVALID_SONG", "歌曲 ID 不能为空");
    return this.loadSong(id, true, cookie);
  }

  async refreshSongAudio(songId: string, cookie?: string): Promise<string> {
    const id = songId.trim();
    if (!id) throw new AppError("INVALID_SONG", "歌曲 ID 不能为空");
    const key = this.cacheKey("audio", cookie, id);
    this.cache.delete(key);
    this.refreshers.delete(key);
    return this.loadAudioUrl(id, cookie, true);
  }

  async getSongMetadata(songId: string, cookie?: string): Promise<SongDetails> {
    const id = songId.trim();
    if (!id) throw new AppError("INVALID_SONG", "歌曲 ID 不能为空");
    return this.cached(
      this.cacheKey("metadata", undefined, id),
      SONG_METADATA_CACHE_TTL_MS,
      () => this.loadSong(id, false, cookie),
    );
  }

  async getSongPopularity(songId: string, cookie?: string): Promise<number | undefined> {
    const id = songId.trim();
    if (!id) return undefined;
    return this.cached(
      this.cacheKey("popularity", undefined, id),
      POPULARITY_CACHE_TTL_MS,
      async () => {
        const response = await this.callOptional(["song_red_count"], { id }, cookie);
        if (!response) return undefined;
        const body = responseBody(response);
        const data = asRecord(body.data);
        return readNumber(data.count ?? body.count);
      },
    );
  }

  async getSongChorus(songId: string, cookie?: string): Promise<SongChorus | undefined> {
    const id = songId.trim();
    if (!id) return undefined;
    return this.cached(
      this.cacheKey("song-chorus", undefined, id),
      SONG_CHORUS_CACHE_TTL_MS,
      async () => {
        const response = await this.callOptional(["song_chorus"], { id }, cookie);
        if (!response) return undefined;
        const body = responseBody(response);
        const list = asArray(body.chorus ?? asRecord(body.data).chorus ?? body.data);
        const item = asRecord(list[0]);
        const startTime = readNumber(item.startTime);
        if (startTime === undefined) return undefined;
        const endTime = readNumber(item.endTime);
        return {
          startTime,
          ...(endTime !== undefined && endTime > startTime ? { endTime } : {}),
        };
      },
    );
  }

  async getPlaylistSongs(playlistId: string, cookie?: string) {
    const id = playlistId.trim();
    if (!/^\d+$/.test(id)) throw new AppError("INVALID_PLAYLIST", "歌单 ID 无效");
    return this.cached(
      this.cacheKey("playlist", cookie, id),
      COLLECTION_CACHE_TTL_MS,
      async () => {
        const response = await this.call(["playlist_track_all", "playlist_detail"], {
          id,
          limit: 1000,
          offset: 0,
        }, cookie);
        const body = responseBody(response);
        let playlist = asRecord(body.playlist ?? asRecord(body.data).playlist);
        if (!readString(playlist.name)) {
          const detailResponse = await this.callOptional(["playlist_detail"], { id }, cookie);
          if (detailResponse) playlist = asRecord(responseBody(detailResponse).playlist);
        }
        const rawSongs = asArray(body.songs ?? playlist.tracks ?? asRecord(body.data).songs);
        const songs = rawSongs
          .map(normalizeSong)
          .filter((song): song is SongSearchResult => Boolean(song));
        const name = readString(playlist.name) ?? `歌单 ${id}`;
        const songCount = readNumber(
          playlist.trackCount ?? playlist.trackNumber ?? songs.length,
        ) ?? songs.length;
        return { info: { id, name, songCount }, songs };
      },
    );
  }

  async searchArtists(keyword: string, limit = 20, cookie?: string) {
    const normalized = keyword.trim();
    if (!normalized) return [];
    const normalizedLimit = Math.max(1, Math.min(limit, 50));
    return this.cached(
      this.cacheKey("artist-search", undefined, normalized.toLocaleLowerCase(), normalizedLimit),
      SEARCH_CACHE_TTL_MS,
      async () => {
        const response = await this.call(["cloudsearch", "search"], {
          keywords: normalized,
          limit: normalizedLimit,
          type: 100,
        }, cookie);
        const body = responseBody(response);
        const result = asRecord(body.result);
        return asArray(result.artists ?? result.artist)
          .map((value): SongArtistSearchResult | undefined => {
            const artist = asRecord(value);
            const id = readString(artist.id);
            const name = readString(artist.name);
            if (!id || !name) return undefined;
            const avatarUrl = normalizeHttpsUrl(artist.picUrl ?? artist.img1v1Url);
            return avatarUrl ? { id, name, avatarUrl } : { id, name };
          })
          .filter((artist): artist is SongArtistSearchResult => artist !== undefined);
      },
    );
  }

  async getArtistSongs(artistId: string, cookie?: string) {
    const id = artistId.trim();
    if (!/^\d+$/.test(id)) throw new AppError("INVALID_ARTIST", "歌手 ID 无效");
    return this.cached(
      this.cacheKey("artist-songs", undefined, id),
      ARTIST_SONGS_CACHE_TTL_MS,
      async () => {
        const response = await this.call(["artist_songs", "artist_top_song"], {
          id,
          limit: 1000,
          offset: 0,
          order: "hot",
        }, cookie);
        const body = responseBody(response);
        return asArray(body.songs ?? asRecord(body.data).songs ?? body.hotSongs)
          .map(normalizeSong)
          .filter((song): song is SongSearchResult => Boolean(song));
      },
    );
  }

  private loginCookie(): Record<string, unknown> {
    return {
      os: "pc",
      appver: "3.1.29.205117",
      osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
      channel: "netease",
      mobilename: this.deviceName,
      model: this.deviceName,
    };
  }

  private loginUserAgent(): string {
    return "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.29.205117";
  }

  async createQrLogin(): Promise<MusicQrLogin> {
    const loginCookie = this.loginCookie();
    const loginUa = this.loginUserAgent();
    const keyResponse = await this.call(
      ["login_qr_key"],
      { ua: loginUa },
      loginCookie,
      this.randomCNIP,
      true,
      false,
    );
    const keyBody = responseBody(keyResponse);
    if (responseCode(keyBody) !== 200) throw musicLoginError(keyBody, "无法创建登录二维码");
    const key = readString(asRecord(keyBody.data).unikey ?? keyBody.unikey);
    if (!key) throw new AppError("MUSIC_LOGIN_FAILED", "无法创建登录二维码");

    const qrResponse = await this.call(
      ["login_qr_create"],
      { key, qrimg: true, platform: this.deviceName, ua: loginUa },
      loginCookie,
      this.randomCNIP,
      true,
      false,
    );
    const qrBody = responseBody(qrResponse);
    if (responseCode(qrBody) !== 200) throw musicLoginError(qrBody, "无法生成登录二维码");
    const qrData = asRecord(qrBody.data);
    const qrUrl = readString(qrData.qrurl);
    const qrImage = readString(qrData.qrimg);
    if (!qrUrl || !qrImage) throw new AppError("MUSIC_LOGIN_FAILED", "无法生成登录二维码");
    return { key, qrUrl, qrImage };
  }

  async checkQrLogin(keyValue: string): Promise<MusicQrLoginCheck> {
    const key = keyValue.trim();
    if (!key) throw new AppError("INVALID_LOGIN", "二维码登录密钥不能为空");
    const response = await this.call(
      ["login_qr_check"],
      { key, ua: this.loginUserAgent() },
      this.loginCookie(),
      this.randomCNIP,
      true,
      false,
    );
    const body = responseBody(response);
    const code = responseCode(body);
    if (code === 8810 || code === 10004) throw musicLoginError(body, "扫码登录失败");
    const message = responseMessage(body, "等待扫码");
    if (code === 800) return { status: "expired", message };
    if (code === 802) return { status: "scanned", message };
    if (code !== 803) return { status: "waiting", message };

    const cookie = responseCookie(response);
    if (!cookie) throw new AppError("MUSIC_LOGIN_FAILED", "扫码成功但未取得登录 Cookie");
    await this.uploadDeviceInfo(cookie, this.deviceName);
    const session = await this.getLoginStatus(cookie);
    return { status: "authorized", message, session };
  }

  async uploadDeviceInfo(
    cookieValue: string,
    deviceName = this.deviceName,
  ): Promise<boolean> {
    const cookie = cookieValue.trim();
    if (!cookie) return false;
    const name = deviceName.trim() || this.deviceName;
    try {
      const response = await this.callOptional(
        ["deviceinfo_center_upload"],
        { deviceName: name },
        `${cookie}; os=pc`,
      );
      if (response) return true;
      if (this.options.loadApi) {
        return false;
      }
      const requestModule = await import("@neteasecloudmusicapienhanced/api/util/request");
      const request = (requestModule.default ?? requestModule) as (...args: unknown[]) => Promise<unknown>;
      const createOptionModule = await import("@neteasecloudmusicapienhanced/api/util/option");
      const createOption = (createOptionModule.default ?? createOptionModule) as (...args: unknown[]) => unknown;
      await request(
        "/api/deviceinfo/center/upload",
        { deviceName: name },
        createOption({ cookie: `${cookie}; os=pc` }, "eapi"),
      );
      return true;
    } catch (error) {
      this.logger?.warn("上报网易云设备名称未成功，保持原设备名运行", describeError(error));
      return false;
    }
  }

  async getLoginStatus(cookieValue: string): Promise<MusicLoginSession> {
    const cookie = cookieValue.trim();
    if (!cookie) throw new AppError("MUSIC_SESSION_INVALID", "登录 Cookie 不能为空");
    const response = await this.call(["login_status"], {}, cookie, false, true, false);
    const body = responseBody(response);
    const data = asRecord(body.data);
    const profile = asRecord(body.profile ?? data.profile);
    const nestedCode = readNumber(data.code);
    const userId = readString(profile.userId ?? profile.id);
    if (
      responseCode(body) !== 200 ||
      (nestedCode !== undefined && nestedCode !== 200) ||
      !userId
    ) {
      throw new AppError("MUSIC_SESSION_INVALID", "网易云登录状态已失效");
    }
    return {
      cookie,
      account: await this.enrichVipAccount(cookie, readLoginAccount(body)),
    };
  }

  private async loadSong(
    songId: string,
    includeResources: boolean,
    cookie?: string,
  ): Promise<SongDetails> {
    const id = songId.trim();
    if (!id) throw new AppError("INVALID_SONG", "歌曲 ID 不能为空");

    const detailResponse = await this.cached(
      this.cacheKey("song-detail", undefined, id),
      SONG_METADATA_CACHE_TTL_MS,
      () => this.call(["song_detail"], { ids: id }, cookie),
    );
    const detailBody = responseBody(detailResponse);
    const rawSong = asArray(detailBody.songs)[0];
    const base = normalizeSong(rawSong);
    if (!base) throw new AppError("SONG_NOT_FOUND", "未找到歌曲信息");

    const wikiPromise = this.cached(
      this.cacheKey("song-wiki", undefined, id),
      SONG_WIKI_CACHE_TTL_MS,
      () => this.callOptional(["song_wiki_summary", "song_wiki_home"], { id }, cookie),
    );
    const lyricPromise = includeResources
      ? this.cached(
          this.cacheKey("song-lyrics", undefined, id),
          SONG_LYRICS_CACHE_TTL_MS,
          () => this.call(["lyric_new", "lyric"], { id }, cookie),
        )
      : Promise.resolve(undefined);
    const popularityPromise = this.getSongPopularity(id, cookie).catch(() => undefined);
    const chorusPromise = includeResources
      ? this.getSongChorus(id, cookie).catch(() => undefined)
      : Promise.resolve(undefined);
    const urlPromise = includeResources ? this.loadAudioUrl(id, cookie) : Promise.resolve("");

    const [wikiResponse, lyricResponse, urlResponse, popularity, chorus] = await Promise.all([
      wikiPromise,
      lyricPromise,
      urlPromise,
      popularityPromise,
      chorusPromise,
    ]);

    const songRecord = asRecord(rawSong);
    const album = asRecord(songRecord.al ?? songRecord.album);
    const publishTime = readNumber(songRecord.publishTime ?? album.publishTime);
    const wiki = readWiki(wikiResponse ? responseBody(wikiResponse) : undefined);

    let audioUrl = "";
    let lyrics: SongLyricLine[] = [];
    if (includeResources) {
      audioUrl = urlResponse;
      const lyricBody = responseBody(lyricResponse);
      const lrc = asRecord(lyricBody.lrc ?? lyricBody.yrc);
      lyrics = sanitizeLyrics(parseLrc(readString(lrc.lyric) ?? ""), base);

      if (!audioUrl) throw new AppError("SONG_UNAVAILABLE", "该歌曲暂时没有可用播放地址");
    }

    return {
      ...base,
      audioUrl,
      lyrics,
      releaseYear: publishTime ? new Date(publishTime).getUTCFullYear() : undefined,
      popularity: popularity ?? base.popularity ?? readNumber(songRecord.pop ?? songRecord.popularity),
      language: wiki.language,
      encyclopedia: {
        summary: wiki.summary,
        aliases: wiki.aliases,
        tags: wiki.tags,
      },
      chorus,
    };
  }

  private async loadApi(): Promise<ApiModule> {
    if (!this.apiPromise) {
      this.apiPromise = (async () => {
        const api = this.options.loadApi
          ? await this.options.loadApi()
          : await import("@neteasecloudmusicapienhanced/api") as ApiModule;
        await this.prepareAnonymousSession(api);
        return api;
      })();
    }
    return this.apiPromise;
  }

  private async unblockSongAudio(songId: string, cookie?: string): Promise<string> {
    // 1. 优先通过 API 模块提供的 song_url_match 接口解灰
    const matchResponse = await this.callOptional(["song_url_match"], { id: songId }, cookie);
    if (matchResponse) {
      const body = responseBody(matchResponse);
      const url = readString(body.data) ?? readString(body.proxyUrl);
      const normalized = normalizeAudioUrl(url);
      if (normalized) return normalized;
    }

    // 2. 尝试 song_url_v1 带 unblock 参数解灰
    const v1Response = await this.callOptional(
      ["song_url_v1"],
      { id: songId, level: "standard", unblock: "true" },
      cookie,
    );
    if (v1Response) {
      const body = responseBody(v1Response);
      const songData = asRecord(asArray(body.data)[0]);
      const url = readString(songData.url) ?? readString(songData.proxyUrl);
      const normalized = normalizeAudioUrl(url);
      if (normalized) return normalized;
    }

    // 3. 在未显式注入外部 mock API 的生产环境下，尝试直接调用内置 matchID 工具
    if (!this.options.loadApi) {
      try {
        const { matchID } = await import("@neteasecloudmusicapienhanced/unblockmusic-utils");
        const result = await matchID(songId);
        const data = asRecord(result?.data);
        const normalized = normalizeAudioUrl(data.url);
        if (normalized) return normalized;
      } catch (error) {
        this.logger?.warn("直接调用解灰工具未成功", describeError(error));
      }
    }

    return "";
  }

  private async loadAudioUrl(songId: string, cookie?: string, force = false): Promise<string> {
    const key = this.cacheKey("audio", cookie, songId);
    const value = await this.cached(
      key,
      AUDIO_URL_CACHE_TTL_MS,
      async () => {
        const response = await this.call(["song_url", "song_url_v1"], {
          id: songId,
          level: "standard",
          br: 320000,
        }, cookie);
        const body = responseBody(response);
        const songData = asRecord(asArray(body.data)[0]);
        let audioUrl = normalizeAudioUrl(songData.url) ?? "";
        const isRestricted = !audioUrl || songData.freeTrialInfo != null || songData.code === 404;

        if (isRestricted && this.enableGeneralUnblock) {
          const unblockedUrl = await this.unblockSongAudio(songId, cookie);
          if (unblockedUrl) {
            audioUrl = unblockedUrl;
            this.logger?.info("网易云歌曲解灰成功", { songId, audioUrl });
          }
        }

        return audioUrl;
      },
      { force, priority: 4, cacheNegative: false },
    );
    if (!value) throw new AppError("SONG_UNAVAILABLE", "该歌曲暂时没有可用播放地址");
    return value;
  }

  private async prepareAnonymousSession(api: ApiModule) {
    if (this.anonymousCookie || typeof api.register_anonimous !== "function") return;
    try {
      const response = await this.scheduleRequest(() =>
        (api.register_anonimous as ApiFunction)({
          crypto: "weapi",
          cookie: {},
          randomCNIP: this.randomCNIP,
          ...(this.randomCNIP ? { realIP: this.ipForCookie() } : {}),
        }));
      this.anonymousCookie = responseCookie(response);
    } catch (error) {
      this.logger?.warn("注册网易云匿名令牌未成功，继续以无凭据模式运行", describeError(error));
    }
  }

  private async call(
    names: string[],
    params: Record<string, unknown>,
    cookie?: string | Record<string, unknown>,
    randomCNIP = this.randomCNIP,
    preserveErrorResponse = false,
    includeAnonymousCookie = true,
  ): Promise<ApiResponse> {
    const api = await this.loadApi();
    let hasEndpoint = false;
    let lastErrorResponse: ApiResponse | undefined;
    let lastError: unknown;
    for (const name of names) {
      const fn = api[name];
      if (typeof fn === "function") {
        hasEndpoint = true;
        try {
          const response = await this.scheduleRequest(() =>
            (fn as ApiFunction)(
              this.withCookie(params, cookie, randomCNIP, includeAnonymousCookie),
            ),
          );
          // Enhanced API 的不同端点可能选择 reject，也可能正常 resolve 一个 405 body。
          // scheduleRequest 内部已统一触发 enterRateLimitCooldown，此处将 405 body 转为业务异常。
          if (this.isRateLimitError(response)) {
            throw this.upstreamError(response);
          }
          return response;
        } catch (error) {
          lastError = error;
          if (error instanceof AppError && error.code === "MUSIC_API_RATE_LIMITED") {
            throw error;
          }
          if ("body" in asRecord(error)) lastErrorResponse = error as ApiResponse;
          if (this.isRateLimitError(error)) {
            throw this.upstreamError(error);
          }
          // 同一能力可能有多个兼容端点；当前端点运行失败时继续尝试后备实现。
        }
      }
    }
    if (!hasEndpoint) {
      throw new AppError("MUSIC_API_UNAVAILABLE", `音乐 API 缺少接口：${names.join(" / ")}`);
    }
    if (preserveErrorResponse && lastErrorResponse) return lastErrorResponse;
    throw this.upstreamError(lastErrorResponse ?? lastError);
  }

  private async callOptional(
    names: string[],
    params: Record<string, unknown>,
    cookie?: string | Record<string, unknown>,
  ): Promise<ApiResponse | undefined> {
    try {
      return await this.call(names, params, cookie);
    } catch (error) {
      if (error instanceof AppError && error.code === "MUSIC_API_UNAVAILABLE") return undefined;
      if (error instanceof AppError && error.code === "MUSIC_API_RATE_LIMITED") throw error;
      this.logger?.warn("网易云可选接口调用降级", {
        endpoints: names,
        error: describeError(error),
      });
      return undefined;
    }
  }

  private async enrichVipAccount(
    cookie: string,
    account: SonGuessrMusicAccount,
  ): Promise<SonGuessrMusicAccount> {
    const response = await this.callOptional(
      ["vip_info_v2", "vip_info"],
      account.userId ? { uid: account.userId } : {},
      cookie,
    );
    if (!response) return { ...account, vipStatus: "unknown" };
    const body = responseBody(response);
    if (responseCode(body) !== 200) return { ...account, vipStatus: "unknown" };
    return readVipAccount(body, account, this.now());
  }

  private cacheKey(namespace: string, cookie: string | undefined, ...parts: unknown[]) {
    const scope = cookie?.trim()
      ? createHash("sha256").update(cookie.trim()).digest("hex").slice(0, 16)
      : "anonymous";
    return [namespace, scope, ...parts].map(String).join(":");
  }

  private async cached<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    options: { force?: boolean; priority?: number; background?: boolean; cacheNegative?: boolean } = {},
  ): Promise<T> {
    const now = this.now();
    if (!options.background) this.lastUserRequestAt = now;
    const entry = this.cache.get(key);
    const hardTtl = Math.max(ttlMs, ttlMs * 3);
    if (!options.force && entry) {
      if (now < entry.hardExpireAt) {
        entry.lastAccessAt = now;
        entry.hits += 1;
        if (now >= entry.softExpireAt) void this.refreshCacheEntry(key, ttlMs, loader, options.priority ?? entry.priority);
        return cloneCacheValue(entry.value as T);
      }
      this.cache.delete(key);
      this.refreshers.delete(key);
    }
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return cloneCacheValue(await existing);

    const allowNegative = options.cacheNegative !== false;
    this.refreshers.set(key, { ttlMs, loader });
    const request = loader().then((value) => {
      // 负结果不写缓存：上游抖动可能返回空地址 / 空值，一旦落缓存就会被钉死整个 TTL，
      // 玩家重试也只会拿到同一个空值。`cacheNegative` 缺省为 true 以保持既有缓存语义，
      // 播放地址这类「重试可能成功」的取值显式传 false，只跳过空结果、正常地址照旧缓存。
      const storeResult = allowNegative || Boolean(value);
      if (storeResult) {
        const fetchedAt = this.now();
        const serializedSize = value === undefined ? 32 : Math.max(32, JSON.stringify(value).length * 2);
        this.cache.set(key, {
          value,
          softExpireAt: fetchedAt + ttlMs * 0.8,
          hardExpireAt: fetchedAt + hardTtl,
          lastAccessAt: fetchedAt,
          hits: 1,
          priority: options.priority ?? 1,
          size: serializedSize,
        });
      }
      return value;
    }).finally(() => {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return cloneCacheValue(await request);
  }

  private async refreshCacheEntry(
    key: string,
    ttlMs: number,
    loader: () => Promise<unknown>,
    priority: number,
  ) {
    if (this.inFlight.has(key) || this.now() < this.cooldownUntil || this.queue.size > 0) return;
    try {
      await this.cached(key, ttlMs, loader, { priority, force: true, background: true });
    } catch (error) {
      this.logger?.warn("网易云缓存预刷新失败", { key, error: describeError(error) });
    }
  }

  private async runCacheMaintenance() {
    if (this.queue.size > 0 || this.now() < this.cooldownUntil) return;
    const now = this.now();
    if (now - this.lastUserRequestAt > 30 * 60_000) {
      for (const [key, entry] of this.cache.entries()) {
        if (entry.hits <= 1 && now - entry.lastAccessAt > 30 * 60_000) {
          this.cache.delete(key);
          this.refreshers.delete(key);
        }
      }
      for (const key of this.refreshers.keys()) if (!this.cache.has(key) && !this.inFlight.has(key)) this.refreshers.delete(key);
      return;
    }
    const candidates = [...this.cache.entries()]
      .filter(([, entry]) => now >= entry.hardExpireAt || now >= entry.softExpireAt)
      .sort(([, left], [, right]) => (right.priority + right.hits) - (left.priority + left.hits));
    for (const [key, entry] of candidates.slice(0, 4)) {
      const refresher = this.refreshers.get(key);
      if (!refresher) {
        this.cache.delete(key);
        continue;
      }
      if (now >= entry.hardExpireAt) this.cache.delete(key);
      await this.refreshCacheEntry(key, refresher.ttlMs, refresher.loader, entry.priority);
    }
    for (const key of this.refreshers.keys()) if (!this.cache.has(key) && !this.inFlight.has(key)) this.refreshers.delete(key);
  }

  private scheduleRequest<T>(task: () => Promise<T>): Promise<T> {
    if (this.now() < this.cooldownUntil) {
      return Promise.reject(this.busyError());
    }
    if (this.queue.size >= this.maxQueuedRequests) {
      return Promise.reject(this.busyError("网易云请求排队过多，请稍后重试"));
    }

    const id = ++this.requestIdCounter;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectHandler: ((err: unknown) => void) | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectHandler = reject;
      timeoutTimer = setTimeout(() => {
        if (this.pendingRejections.has(id)) {
          this.pendingRejections.delete(id);
          reject(this.busyError("网易云请求等待超时，请稍后重试"));
        }
      }, this.queueTimeoutMs);
    });

    this.pendingRejections.set(id, (err) => {
      clearTimeout(timeoutTimer);
      rejectHandler?.(err);
    });

    const executionPromise = this.queue.add(async () => {
      clearTimeout(timeoutTimer);
      if (!this.pendingRejections.has(id)) {
        return;
      }
      this.pendingRejections.delete(id);

      if (this.now() < this.cooldownUntil) {
        throw this.busyError();
      }
      try {
        const result = await task();
        if (this.isRateLimitError(result)) {
          this.enterRateLimitCooldown(result);
        }
        return result;
      } catch (error) {
        if (this.isRateLimitError(error)) {
          this.enterRateLimitCooldown(error);
        }
        throw error;
      }
    }) as Promise<T>;

    return Promise.race([executionPromise, timeoutPromise]);
  }

  private enterRateLimitCooldown(error: unknown) {
    const body = responseBody(error);
    this.lastRateLimitMessage = responseMessage(body, this.lastRateLimitMessage);
    const now = this.now();
    if (now - this.lastRateLimitAt > this.maxRateLimitCooldownMs) {
      this.rateLimitStrikes = 0;
    }
    this.rateLimitStrikes = Math.min(this.rateLimitStrikes + 1, 8);
    this.lastRateLimitAt = now;
    const baseDuration = Math.min(
      this.maxRateLimitCooldownMs,
      this.rateLimitCooldownMs * 2 ** (this.rateLimitStrikes - 1),
    );
    // 注入微量随机 Jitter 抖动，防止限流恢复瞬间突发惊群重连
    const jitter = Math.floor(
      (this.random.nextFloat?.() ?? Math.random()) * (baseDuration * 0.05),
    );
    const duration = Math.min(this.maxRateLimitCooldownMs, baseDuration + jitter);
    this.cooldownUntil = Math.max(this.cooldownUntil, now + duration);

    const rejections = Array.from(this.pendingRejections.values());
    this.queue.clear();
    this.pendingRejections.clear();

    this.logger?.warn("网易云接口触发限流退避", {
      strikes: this.rateLimitStrikes,
      cooldownDurationMs: duration,
      cooldownUntil: new Date(this.cooldownUntil).toISOString(),
      droppedQueuedRequests: rejections.length,
      reason: this.lastRateLimitMessage,
    });

    const busy = this.busyError(this.lastRateLimitMessage);
    for (const reject of rejections) {
      reject(busy);
    }
  }

  private busyError(message = this.lastRateLimitMessage) {
    return new AppError("MUSIC_API_RATE_LIMITED", message, {
      upstreamCode: 405,
      retryAfterMs: Math.max(0, this.cooldownUntil - this.now()),
    });
  }

  private upstreamError(error: unknown) {
    if (error instanceof AppError) return error;
    const body = responseBody(error);
    const code = responseCode(body) ?? readNumber(asRecord(error).status);
    const message = responseMessage(
      body,
      error instanceof Error && error.message
        ? error.message
        : "网易云音乐接口请求失败，请稍后重试",
    );
    return new AppError(
      code === 405 ? "MUSIC_API_RATE_LIMITED" : "MUSIC_API_FAILED",
      message,
      { upstreamCode: code },
    );
  }

  private isRateLimitError(error: unknown) {
    const body = responseBody(error);
    return responseCode(body) === 405 || readNumber(asRecord(error).status) === 405;
  }

  private ipForCookie(cookie?: string | Record<string, unknown>) {
    const cookieStr = typeof cookie === "string" ? cookie : JSON.stringify(cookie ?? "");
    const scope = cookieStr?.trim()
      ? createHash("sha256").update(cookieStr.trim()).digest("hex").slice(0, 16)
      : "anonymous";
    const existing = this.ipByScope.get(scope);
    if (existing) return existing;
    const ip = randomChineseIp(this.random);
    this.ipByScope.set(scope, ip);
    if (this.ipByScope.size > 128) {
      const oldest = this.ipByScope.keys().next().value;
      if (oldest !== undefined) this.ipByScope.delete(oldest);
    }
    return ip;
  }

  private withCookie(
    params: Record<string, unknown>,
    cookie?: string | Record<string, unknown>,
    randomCNIP = this.randomCNIP,
    includeAnonymousCookie = true,
  ): Record<string, unknown> {
    const requestCookie = cookie ?? (includeAnonymousCookie ? this.anonymousCookie : undefined);
    return {
      ...params,
      // 始终显式传入 cookie，阻止 Enhanced API 从进程环境变量 NETEASE_COOKIE 偷读旧凭据。
      cookie: requestCookie ?? {},
      // 同一登录态使用稳定伪装 IP，减少单一出口的限流聚集，也避免请求间频繁漂移触发风控。
      ...(randomCNIP ? { realIP: this.ipForCookie(cookie) } : {}),
      randomCNIP,
    };
  }
}
