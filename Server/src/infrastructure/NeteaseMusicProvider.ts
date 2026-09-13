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
  "作词(?:人|者)?", "填词", "词曲", "词", "作曲(?:人|者)?", "谱曲", "曲", "制谱",
  // R14 实测：`乐谱 : 彭华锐@牧雨音乐`、`上台乐手：画左：贝斯：...`。
  "乐谱", "(?:上台)?乐手",
  "编曲(?:人|师|者)?", "制作人", "制作", "监制(?:人)?", "统筹", "发行", "出品", "策划", "企划",
  "(?:词曲|作词|作曲)(?:提供|来源)",
  // 繁体写法（港台上传谱高频）：`編曲 Arrange : X`。
  "作詞(?:人)?", "編曲(?:人|师)?", "製作(?:人)?", "監製(?:人)?", "後期", "翻譯", "字幕組",
  "出品人", "发行人", "监制人", "策划人", "企划人", "指挥", "演奏指挥",
  // R13 实测：`录制：Lightroom Studio`、`歌：洛天依 feat.岸晓`（单字 `歌` 的空格形态
  // 由空格拆分的 ≥2 字头部规则天然保护）、`助理/工程师` 支撑 `混音助理工程师` 三段粘连。
  "录制", "歌", "助理", "工程师",
  // R13 实测：`英译：梦圆`、`单品策划:银狼的殷琅`、`曲绘人设加工：绫也茵`（人设+加工）。
  "翻译", "(?:英|日|韩)译", "单品策划", "人设", "加工",
  // 复合标签：网易云常见 `音乐制作：X`、`音乐监制：X`、`专辑封面设计：X` 这类带限定前缀的写法。
  // 单独登记而不放宽 `isCreditLabelOnly` 的「覆盖整个头部」约束，避免 `音乐响起：` 这类歌词被误杀。
  "音乐制作", "音乐监制", "音乐指导", "音乐统筹", "音乐总监", "音乐设计", "音乐混音",
  "音乐出品", "音乐制作人", "音乐总监制",
  // R12 实测：`音乐营销：网易飓风`（`音乐` 单词不进词表，沿用 `音乐X` 整词枚举防误杀）。
  "音乐营销",
  "专辑制作", "专辑封面(?:设计)?", "封面设计", "视觉设计",
  // R12 实测：`专辑：最好的时代`（专辑名是强泄露源）。
  "专辑",
  "合作音乐人", "特邀", "参演", "配音",
  "配唱(?:编写)?", "制作协力", "低音吉他", "第一小提琴", "第二小提琴", "中提琴", "大提琴",
  // R12 实测：`古琴 Guqin：方静宇`（民族乐器对照署名）、`戏腔 Opera tune：海伦`（演唱分工）。
  "古琴", "戏腔",
  // R13 实测：`电贝斯：Ray Vaughn Covington` —— R10 只登记了 `电贝司`（同音异字），
  // `电` 前缀需可选（`^` 锚定下裸 `贝斯` 接不住 `电贝斯`）。
  "电?贝斯",
  // R14 实测：`电子合成器 / 仿音合成器 / 键琴 / 程序编排：C. Y. Kong`。
  "(?:电子|仿音)合成器", "键琴", "程序编排",
  // 出版/公司/企划类：`制作公司 : X`、`厂牌 : X`、`企划宣传：X`、`商务统筹 : X`、
  // `特别鸣谢 : X`、`合作单位：X`。这类行给出的是机构而非歌词，必须剔除。
  "制作公司", "出品公司", "发行公司", "音乐公司", "签约公司", "文化传媒", "传媒",
  "厂牌", "唱片", "唱片公司", "工作室", "录音室(?!$)",
  "企划宣传", "宣传", "推广", "营销", "商务", "商务统筹", "统筹企划",
  "鸣谢", "特别鸣谢", "特别感谢", "致谢", "感谢", "协助单位", "合作单位",
  // 虚拟歌手/音源类：`虚拟人声：X`、`和声配唱 : X`、`主人声 : X`、`合声编写 : X`。
  "虚拟人声", "虚拟歌手", "声库", "音源", "主人声", "副人声", "和声配唱", "和声演唱",
  "合声", "合声编写", "合声配唱", "配唱",
  // 演奏/编制类：`弦乐演奏：X`、`弦乐乐团：X`、`乐队 Orchestra：X`、`乐队队长：X`。
  "弦乐演奏", "弦乐乐团", "管弦乐团", "乐队", "乐团", "队长", "乐队队长", "首席",
  "演奏", "独奏", "合奏", "伴奏", "编程", "音频工程师", "音响",
  "录音软件操作", "软件操作", "前台及舞台音响", "舞台音响",
  // 英文音译/缩写署名：`Program : X`、`PGM：X`。
  "program", "pgm", "md", "arrangement",
  // 美术/画师类：`画师：X`、`绘图：X`、`曲绘：X`、`插画：X`。
  "画师", "绘图", "曲绘", "插画", "美工", "题字", "排版", "设计",
  // `录音(?:师|棚|室)?` 必须保留可选后缀形态：它同时覆盖 `录音师`/`录音棚`/`录音室`，
  // 不要改写成逐个字面量，否则 `录音棚：C.L.K` 这类取值含点的行会掉出词表路径
  // （结构判定因取值含 `.` 而否决）。
  "混音(?:师)?", "录音(?:师|棚|室)?", "混音室", "母带(?:处理|工程师)?",
  "和声(?:编写)?", "和音(?:编写|配唱)?", "合音(?:编写)?", "伴唱", "编写",
  // 「动词/乐器 + 录音/混音/母带/制作」的复合署名，实测高频：
  // `主唱录音：`、`弦乐录音：`、`混音母带：`、`母带制作：`、`母带后期处理录音室：`、
  // `和声编写&和声演唱：`、`MIDI工程：`。`&`/`/` 连接的两段会由 `isCreditLabelOnly`
  // 的逐段拆分处理，但每段本身必须在词表内。
  "主唱录音", "弦乐录音", "管乐录音", "乐器录音", "人声录音", "混音母带", "母带制作",
  // 注意：`母带后期处理` 的展开条目只在 R5 补漏组保留一条（含 录音室|制作人 两种后缀），
  // 这里**不要**再登记字面并列的旧形态 —— 两条字面长度并列时源码顺序靠前者
  // 会抢先匹配并在可选组前截断（`母带后期处理制作人` 只吃到 `母带后期处理`）。
  "和声演唱", "midi工程", "编曲工程", "人声编辑",
  // `乐器录音师`、`人声录音棚`、`混音工程师` 这类「动作 + 师/棚/室/工程师」的完整词形。
  "乐器录音师", "人声录音棚", "混音工程师", "录音工程师", "母带工程师",
  // 实测补漏：`人声录音师`、`人声录音棚A`、`吉他录音`、`母带工作室`、`配唱制作人`、`弦乐指挥`。
  "人声录音师", "人声录音", "人声录音工程师", "吉他录音", "贝斯录音", "鼓录音", "钢琴录音", "弦乐录音师",
  "母带工作室", "混音工作室", "录音工作室", "配唱制作人", "配唱编写", "合声编写",
  "弦乐指挥", "弦乐翻译", "弦乐编写", "弦乐统筹", "管弦乐", "弦乐团",
  // 助理/副手与总监类：`混音助理 : X`、`制作助理 : X`、`艺人合作总监 : X`。
  "制作助理", "混音助理", "录音助理", "配唱助理", "音乐助理", "附加制作",
  "音频编辑", "音频剪辑", "音频助理", "母带助理", "音乐编辑", "助理",
  "艺人(?:合作)?总监", "项目总监", "内容总监", "节目总监",
  // 缩写与单字形态：`和编：清潇Lanoiah`（和声编写缩写）、`器乐 : X`。
  "和编", "合编", "器乐", "管乐", "实录", "弦乐实录", "表演(?:者)?",
  "民乐", "艺人", "母版", "团队", "作品管理", "经纪", "制作人经纪",
  "和声录唱", "歌词制作", "录音时间", "中国笛", "热瓦普", "(?:新疆)?手鼓",
  // R5 实测补漏：`录音制作`、`营销推广`、`混音录音室`、`计算机音乐编成`、`谱务 Scoring`。
  // R9：`录音棚`/`录音室` 单独成头（`鼓录音棚` 粘连拆分需要它们是标签）。
  "录音制作", "营销推广", "混音录音室", "(?:计算机)?音乐编成", "谱务",
  "母带后期处理(?:录音室|制作人)?", "声音工程师", "录音棚", "录音室",
  // R7 实测补漏（官方发行页脚与同人圈混排标签）：
  // `总监制 : X`、`歌曲企划：X`、`承制：X`、`混音工程：X`、`电影原声发行：X`、
  // `音乐监督 X`、`项目/艺人统筹：X`、`宣发支持/宣发执行：X`、`导演：X`、`调色：X`、
  // `服装：X`、`独家短视频平台：X`、`特别说明：X`、`原作：《…》X`、`爱尔兰哨笛 : X`、
  // `弦乐录制：X`、`改编词曲/改编编曲 : X`、`绘 ：X`、`注：X`、`联合出品`（裸行）。
  "总监制", "歌曲企划", "承制", "混音工程", "电影原声发行", "音乐监督",
  "项目", "宣发(?:支持|执行)?", "导演", "调色", "服装", "(?:独家)?短视频平台",
  "特别说明", "原作", "爱尔兰哨笛", "哨笛", "弦乐录制", "改编词曲", "改编编曲",
  "绘", "注", "词作", "语调教", "社团", "物料", "黑胶设计", "联合出品",
  // R8 实测补漏：`三弦 : X`、`中文填词：X`、`贴混：X`、`监督：X`、
  // `绘画：X`、`录音版权：X`。
  "三弦", "(?:中文|粤语|国语)填词", "贴混", "监督", "绘画", "录音版权",
  // R9 实测补漏：`分轨混音/母带：X`、`录混 : X`、`调/影：X`（同人圈单字缩写，
  // 调教/影像制作）、`吉他、贝司、和声：X`（贝斯变体）、`二创效果Edit：X`、
  // `乐队总监 : X`、`前作：《…》`（前作歌名是答案泄露源，同 `原作`）。
  "分轨混音", "录混", "调", "影", "贝司", "二创效果", "乐队", "总监", "前作",
  // R10 实测补漏：`（以下段落作曲作词：街道办／KT）`、`监唱 : X`、
  // `管弦乐配器 Orchestrator:X`、`电贝司 Electric Bass:X`。
  "以下段落", "监唱", "管弦乐", "配器", "电贝司",
  // R11 实测补漏：`音乐项目总监 : X`、`总企划 : X`、`v本家：av号`、
  // `歌词/翻译传导：X`（搬运标注）、`声音剪辑 ：X`、`营销统筹/营销推广机构：X`、
  // 单字缩写 `编/混/母：X`、`唱：人名串`、`背景：绘师串`（同人曲分工标注；
  // `背景` 同时进 SPACE_SPLIT_HEAD_DENY，空格形态按歌词保留）。
  "音乐项目总监", "总企划", "v本家", "歌词传导", "翻译传导", "声音剪辑",
  "营销", "机构", "编", "混", "母", "唱", "背景",
  // 别称/通称（答案泄露源）：`通称：愛情対象年齢`。
  "通称", "別名", "别名", "別称", "又称", "又名",
  // 日系/同人常见署名：`调声 Tuning`、`采样`、`尺八 Shakuhachi`、`调教`、`混响`。
  "调声", "调音", "采样", "混响", "音效", "后期混音", "缩混", "母带制作人",
  // 标题/元信息类（同时是答案泄露源）：`歌曲原名：夜来香`。
  "歌曲原名", "原曲名", "歌曲名", "歌名", "原唱名", "本名",
  // 外语标题头：`Bài Hát: See Tình`（越南语「歌名」）。
  "bài\\s+hát", "canción", "曲名", "楽曲名", "タイトル",
  "video",
  "吉他", "贝斯", "鼓", "弦乐(?:编写)?", "乐器",
  // 中文乐器/声部名：网易云里既有 `钢琴 : X` 也有 `架子鼓 Drums：X`。
  "钢琴", "架子鼓", "爵士鼓", "电子琴", "合成器", "打击乐", "萨克斯", "长笛", "口琴",
  "键盘", "键盘手", "手鼓", "铃鼓", "三角铁", "钟琴", "竖琴", "管风琴", "电钢",
  "短笛", "英国管", "曼陀林", "尤克里里", "西塔尔琴", "班苏里笛", "萨兹琴",
  "木吉他", "电吉他", "原声吉他", "古典吉他", "吉他", "贝斯", "鼓",
  "古筝", "琵琶", "二胡", "笛子", "箫", "唢呐", "马头琴", "手风琴", "小提琴", "大提琴", "中提琴",
  "尺八", "三味线", "太鼓", "箏", "琵琶", "笙", "阮", "柳琴", "扬琴", "冬不拉", "班卓琴",
  "长号", "小号", "圆号", "大号", "双簧管", "单簧管", "巴松", "竖笛", "口哨",
  // 中文声部/编制名
  "人声", "声乐", "说唱", "rap", "戏腔", "京剧", "念白", "朗诵", "口白",
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
  "mixing", "mastering", "programming", "recording", "engineers?(?:ing)?",
  // 英文编排/配器类（实测高频，旧表完全缺失）：
  // `Orchestral Arrangements : X`、`Orchestration : X`、`Synthesizer Programming : X`、
  // `Vocal Arrangements : X`、`Rhythm Arrangements : X`、`Synthesizers : X`。
  "arrangements?", "orchestration", "orchestral", "orchestra",
  "synthesizers?", "synthesizer\\s+programming", "programmed\\s+by",
  "harmony", "harmonies", "choir", "strings?", "horns?", "woodwinds?",
  "brass", "flute", "sax(?:ophone)?", "trumpet", "trombone",
  "band", "quartet", "ensemble", "conductor",
  // 英文职位类：`Editing Engineer`、`Assistant Engineer`、`recording PD`、`Musical Supervisor`。
  "assistant\\s+engineer", "editing\\s+engineer", "recording\\s+pd",
  "musical\\s+supervisor", "supervisor", "coordinator",
  "management", "manager", "director", "directed\\s+by",
  // 多词英文编排/制作署名（旧表遗漏，实测高频）：
  // `Orchestral Arrangements`、`Vocal Arrangements`、`Rhythm Arrangements`、
  // `String Arranger & Conductor`、`Synthesizer Programming`。
  "orchestral\\s+arrangements?", "vocal\\s+arrangements?", "rhythm\\s+arrangements?",
  "string\\s+arranger(?:\\s*&\\s*conductor)?", "synthesizer\\s+programming",
  "vocal\\s+arrangement", "arrangements?",
  "producers?", "publishers?", "composers?", "lyricists?", "arrangers?",
  // 纯英文复合标签的限定词：`Music Producer`、`Musical Supervisor`、`Vocal Arrangements`、
  // `Rhythm Arrangements`。这些词单独出现不足以判定（`music` 可能是歌词），
  // 但 `isCreditLabelOnly` 的英文「逐词复合」分支要求**每个词都是标签且至少两词**，
  // 因此把限定词登记进来是安全的。
  "music", "musical", "vocal", "rhythm", "orchestral", "string", "brass",
  "woodwind", "percussion", "electronic", "synthesizer", "acoustic", "electric",
  // 实测补漏的复合后缀：`调声 Tuning`、`和声 Chorus`、`合成器 Synth`、
  // `演唱 Voice`、`尺八 Shakuhachi`、`编曲 Arrange`、`版权 Publishing`。
  "tuning", "chorus", "synth", "voice", "shakuhachi", "arrange", "publishing",
  // `Soloist – X`、`1st/2nd Violins : X`。
  "soloists?", "solos?", "violins?", "violoncello", "contrabass", "organ", "harpsichord",
  // R5 补漏：`助理 Assistant`、`谱务 Scoring`、`Programmer`、`Studio`、`Sound Engineer`。
  // R9：`Studios : Dragon Studio/...` 头部是复数，`studio` 收 `s?`。
  "assistant", "scoring", "programmers?", "studios?", "sound",
  "artists?", "piccolo", "compositions?", "renditions?", "instrumental", "production",
  "recording\\s+time",
  // 民族乐器拼音/外文名（复合标签英文半）：`古筝 Guzheng`、`琵琶 Pipa`、`笛子 Dizi`。
  "guzheng", "pipa", "dizi", "sitar", "saz", "bansuri", "koto", "shamisen", "taiko",
  "acoustic\\s+guitar", "classical\\s+guitar", "electric\\s+guitar",
  "guitars?", "bass", "drums?", "piano", "keyboards?", "violin", "cello",
  "percussion", "strings?", "midi", "pd", "recording", "rec", "program(?:ming)?",
  // `X Engineer` / `X Studio` / `X Artist` 这类「角色限定 + 通用名词」的英文署名。
  // 网易云上 `混音师 Mixing Engineer`、`人声录音棚 Vocal Recording Studio` 属常见形态，
  // 只登记名词本体即可被复合标签路径覆盖。
  "mixing\\s+engineer", "mastering\\s+engineer", "recording\\s+engineers?",
  "instrumental\\s+recording\\s+engineers?", "vocal\\s+artist", "vocal\\s+recording\\s+studio",
  "recording\\s+studio", "programmed", "keyboards?(?:\\s*&\\s*programming)?",
  "thanks?(?:\\s+to)?", "special\\s+thanks",
  "production\\s+coordination", "recorded\\s+at", "engineered\\s+by",
  "mixed\\s+by", "mastered\\s+by", "lyrics?\\s+by", "music\\s+by",
  "written\\s+by", "produced\\s+by", "composed\\s+by", "arranged\\s+by",
  "performed\\s+by", "vocals?\\s+recorded\\s+at",
  // `X by` 形式的英文署名：`作词 Lyricist by`、`作曲 Composer by`。
  "lyricist\\s+by", "composer\\s+by", "arranger\\s+by", "producer\\s+by",
  // R7 实测补漏：`Mixer : X`、`Studio Personnel : X`、`Synthesizer Operator : X`、
  // `Verse 2: G-Eazy`（数字由槽位规则吃掉）、`二胡Erhu：X`、`策划Planner/ X`、
  // `混音Mix down/ X`、`PV Promotion Video/ X`、`出品社团Products/ X`。
  "mixers?", "personnel", "operators?", "planner", "verse",
  "erhu", "mix\\s*down", "promotions?", "products?",
  // R8 实测补漏：`Prodused : X`（瑞典语拼法）、`Audio Editing : X`、
  // `Production Co-ordination : X`（连字符英式拼法，与已登记的
  // `production coordination` 是同义变体）、`Sub Publishing : X`、
  // `Arranged : X`（无 by 的裸动作形态）。
  "prodused", "audio\\s+editing", "production\\s+co-ordination",
  "sub\\s+publishing", "arranged",
  // R9 实测补漏：`Background Vocals: 光良`（和声英文全称）、`Accordion: 李正帆`、
  // `Vocoder : X`、`中提琴 VIOLA : X`、`CO-PRODUCTION：X`、`ISRC NO : 编码`
  // （国际录音制品编码，真实歌词不含）。
  "background\\s+vocals?", "background\\s+vocal\\s+arrangements?",
  "accordion", "vocoder", "viola", "co-?production", "isrc(?:\\s+no)?",
  // R10 实测补漏：`Lead Vocals : X`、`Linn Drum : X`（鼓机品牌）、`Talkbox : X`、
  // `Mix Engineering : X`（裸 `mix` 不能加 —— `Mix it up` 是歌词）、
  // `Tenor/Baritone Saxophone : X`、`Additional Engineering : X`、
  // `Released on : 日期`、`Sound Produce：X`、`Chamberlin Oboe：X`、
  // `B-Box: X`、`Orchestrator: X`。`engineer(?:ing)?` 复数化收 `Engineers :`。
  "lead\\s+vocals?", "linn\\s+drum", "talk\\s*box", "mix\\s+engineering",
  "tenor", "baritone", "additional\\s+engineering", "released?\\s+on",
  "produce", "oboe", "chamberlin", "b-?box", "orchestrators?",
  // R11 实测补漏：`Digital Edited by X`、`统筹Project Lead : X`、
  // `Marketing coordination : X`、`Marketing and promotion agencies : X`
  // （`and` 由连接组接住）、`Writers: X`。
  "digital\\s+edited\\s+by", "project\\s+lead", "marketing\\s+coordination",
  "marketing", "agencies", "writers?",
  // R12 实测：`戏腔 Opera tune：海伦` —— `tune` 小写开头，TitleCase 对照分支接不住，词表直补。
  "opera\\s+tune",
  // R13 实测翻唱圈标注：`OT : 海阔天空 (Beyond)`（Original Track 原曲名）、
  // `OA : 黄家驹`（Original Artist 原唱）、`Original:フラワリングナイト`。
  // 直接泄露原曲信息，缩写形态只有 2 字母，裸行路径不会误触（要求含中日文字）。
  "ot", "oa", "original",
  // R14 实测：`RIT:tu vivi nell'aria`（原曲标注，OT 家族）、
  // `Album: 幽闭サテライト - ...`（专辑名标注）、
  // `Instrumentation & Programming : Benny Blanco`。
  "rit", "album", "instrumentation", "programming",
].join("|");

/**
 * 正则的可选分支按「先长后短」排序，避免短标签抢先匹配。
 * 例：`sp` 会以忽略大小写的方式吃掉 `Special Thanks` 的开头，`曲` 会吃掉 `曲绘`。
 *
 * **必须按字面匹配长度排序，而不是源码字符串长度**：`混音(?:师)?` 源码长度 10，
 * 但实际只匹配 2~3 个字符；若按源码长度排序，它会排到 `混音母带`（字面 4 字）之前，
 * 在 `^` 锚定下先吃掉 `混音` 两个字符就停下，导致 `混音母带：X` 整条掉出词表。
 * 因此这里剥离正则元字符后按**字面长度**排序（组内取最小字面长度，保守靠后）。
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

  /**
   * 估算分支的**最小字面匹配长度**：把正则语法剥掉后剩下的可见字符数。
   * 例：`混音(?:师)?` → `混音` = 2；`混音母带` → 4。据此让字面更长的分支优先。
   *
   * 关键：**可选组（`(?:...)?`）内的字面一律不计**，否则 `混音(?:师)?` 会被算成 4，
   * 与纯字面 `混音母带` 打平，稳定排序又会让它凭源码顺序抢先匹配。
   */
  const literalLength = (alternative: string): number => {
    const required = alternative.replace(/\(\?:[^()]*\)\?/g, "");
    return required.replace(/\\(.)/g, "$1").replace(/[()|^$.*+?[\]{}]/g, "").length;
  };

  return splitAlternatives(source)
    .sort((a, b) => literalLength(b) - literalLength(a))
    .join("|");
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

/** 多标签连接符：`策划/统筹`、`作词、作曲`、`监制&混音`、`和音编写及演唱`。
 * `及` 也算连接符：它只在头部拆分用，且拆出的**每段都必须是标签**，
 * 歌词头（`早餐及午餐：`）拆出的非标签段会自然否决。
 * **`和` 不能进通用 joiner**：它同时是 `和声`/`和音`/`和编` 等标签的首字，
 * 单字符切分会把 `吉他、贝司、和声` 切出孤立 `声` 段而整条漏网 ——
 * `和` 的拆分见 isCreditLabelOnly 末尾的独立分支。 */
const CREDIT_LABEL_JOINER_PATTERN = /[/／、,，&＆及]/;

/** 可与并列词组合成复合署名的动作词：`Arranged & Conducted by`、`Mixed & Mastered by`。 */
const CREDIT_ACTION_WORDS = [
  "arranged", "conducted", "mixed", "mastered", "recorded",
  "produced", "written", "composed", "performed", "programmed",
];
// 注意必须用括号包住整组可选分支，否则 `^a|b|...|z$` 只会锚定首尾两项。
const CREDIT_ACTION_PATTERN = new RegExp(`^(?:${CREDIT_ACTION_WORDS.join("|")})$`, "i");

/**
 * 英文制作署名短标签（Discogs 风格实体唱片信息）：
 * `Mixed At – Enterprise Studios`、`Mastered At – Precision Mastering`、
 * `Distributed By – EMI (Taiwan) Ltd.`、`Backing Vocals – ...`、`A&R – ...`、
 * `Executive-Producer – ...`、`Presenter – ...`、`Vocal edite：...`。
 *
 * 这类行**分隔符是 en dash 而非冒号**，且整体（`Mixed At`）不是单个已知标签，
 * 因此词表与结构判定双双漏网。判定必须用**显式枚举**而不能放宽成
 * 「`<任意词> At/By`」—— 否则 `Killed By – the storm` 这类歌词会被整行误杀。
 * 匹配时用前缀形式（`EN_CREDIT_PREFIX_PATTERN`）直接测试整行，
 * 绕开 `Executive-Producer` 被内部连字符抢先切开的问题。
 */
const EN_CREDIT_SHORT_LABELS = [
  "a&r", "a & r", "executive-producer", "executive producer", "presenter",
  "presented by", "backing vocals", "backing vocal", "vocal edite", "vocal edit",
  "art direction", "artwork by", "design by", "photography", "photography by",
  "liner notes", "booklet", "management by", "booking",
  "licensed by", "license", "market", "marketing",
  "distributed by", "manufactured by", "pressed by", "published by",
  "recorded at", "mixed at", "mastered at", "remixed at",
];

/** `EN_CREDIT_SHORT_LABELS` 的行首前缀形态，长分支优先避免被短分支截断。 */
const EN_CREDIT_PREFIX_PATTERN = new RegExp(
  `^(?:${[...EN_CREDIT_SHORT_LABELS]
    .sort((left, right) => right.length - left.length)
    .join("|")})(?:\\s|$)`,
  "i",
);


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
    "recorded\\s+at", "recorded\\s+by", "engineered\\s+by", "mixed\\s+by", "mastered\\s+by",
    "mixing\\s+at", "mastering\\s+at", "recording\\s+at",
    "lyrics?\\s+by", "music\\s+by", "written\\s+by", "produced\\s+by",
    "composed\\s+by", "arranged\\s+by", "performed\\s+by",
    "vocals?\\s+recorded\\s+at",
    // R11 实测：`Digital Edited by 정은경 @ Ingridstudio` 无冒号无分隔，
    // 词表条目只在头部路径生效，必须走整行前缀判定。
    "digital\\s+edited\\s+by",
  ].join("|")})(?:\\s|$)`,
  "i",
);

/**
 * `<乐器/声部> 录音地点` 形态的英文署名行：
 * `Drums Recorded at Aroom Studio`、`Strings Recorded at 广州中国唱片社录音室`、
 * `Vocals & Piano Recorded at Avon Studios,`、`Music & Vocals Recorded at Avon Acoustic Ltd`、
 * `Strings Recording Co-ordination by Stanley Leung`。
 *
 * 这些行以**乐器词开头**，`STARTS_WITH_CREDIT_ENGLISH_PATTERN` 的 `Recorded at`
 * 是行首锚定、接不住；且头部 `Strings Recorded` 整体不是任何单个标签，词表也接不住。
 * 判定：行首是一串已知英文乐器/声部词（`&` **或空格**连接，覆盖
 * `Solo Cello` 这类多词乐器），随后紧跟
 * `Recorded/Mixed/Mastered (at|by)` 或 `Recording`（录音事务说明）。
 * 乐器词必须逐词命中英文标签，`Drums are beating at dawn` 这类歌词
 * （第二词是 be 动词）不会命中。
 */
const isInstrumentRecordingHead = (value: string): boolean => {
  const normalized = value.trim().replace(/[\s\u3000]+/g, " ");
  const match =
    /^([A-Za-z]+(?:[\s&＆]+[A-Za-z]+)*)\s+(?:(?:recorded|mixed|mastered)\s+(?:at|by)\b|recording\b)/i.exec(
      normalized,
    );
  if (!match) return false;
  const words = match[1].split(/[\s&＆]+/i).filter(Boolean);
  return (
    words.length > 0 &&
    words.every(
      (word) =>
        CREDIT_LABEL_PATTERN.exec(word)?.[0].replace(/[\s\u3000]+/g, "").toLowerCase() ===
        word.toLowerCase(),
    )
  );
};

/** 行首装饰：书名号、括号、项目符号与空白。署名行常带这些前缀，必须先剥离。 */
const LEADING_DECORATION_PATTERN = /^[\s\u3000\-—–~～·•*＊=＝+＋|｜/]+|^[【\[（(「『《<]+/;

/** 包裹式标签：`【翻唱】某某`、`（后期）某某`、`[Mixing] John`。 */
const WRAPPED_CREDIT_LABEL_PATTERN = /^[【\[（(「『《<]\s*([^】\]）)」』》>]{1,12}?)\s*[】\]）)」』》>]\s*(.+)$/u;

/**
 * 空格分隔下**不可信**的头部：这些词虽是署名标签，但同样是高频歌词开头。
 * 空格分隔只在头部是纯制作行话时才信任，`感谢 陪伴`、`设计 一场相遇` 这类
 * 「标签词 + 歌词」的组合必须保留（冒号形态不受影响，`感谢：X` 仍会剔除）。
 */
const SPACE_SPLIT_HEAD_DENY = new Set([
  "感谢", "特别感谢", "鸣谢", "致谢", "谢谢", "感激",
  "策划", "设计", "宣传", "推广", "邀请", "呈现",
  // `导演` 被歌词借用作隐喻（`导演 我的人生这一场戏`），空格形态不可信。
  "导演",
  // `背景` 同理：`背景 夜色沉沉` 是歌词，`背景：绘师串` 是冒号署名。
  "背景",
  // `专辑` 同理：`专辑 里的歌` 是歌词，`专辑：最好的时代` 是元信息署名。
  "专辑",
  // R13：`翻译 爱的语言`、`录制 这一刻` 是歌词写法，冒号形态（`翻译：梦圆`）仍是署名。
  "翻译", "录制",
]);

/** 署名标签与取值之间的分隔符（在标签之后首次出现的位置切分）。
 * 半角连字符 `-` 只在**非字母数字夹心**时才当分隔符：`Mixed - Mastered by X`
 * 是并列署名，而 `Production Co-ordination`、`G-Eazy`、`L-O-V-E`（拼写歌词）
 * 里的连字符是词内成分 —— 裸 `-` 会把标签在词中切碎（`Production Co|ordination`）
 * 导致整条署名漏网。全角 `—`/`–` 不受约束（中文标签不会夹用）。 */
const CREDIT_SEPARATOR_PATTERN = /(?::|：|—|–|\||｜|\/|／|(?<![A-Za-z0-9])-(?![A-Za-z0-9]))/;

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
  if (separatorMatch) {
    const head = undecorated.slice(0, separatorMatch.index).trim();
    const tail = undecorated.slice(separatorMatch.index + separatorMatch[0].length).trim();
    if (head && tail) return `${head}\u0000${tail}`;
  }

  // 空格分隔的署名行：`制作人 徐鲤`、`录音师 韦生@鲸升音乐`、`录音棚 鲸升音乐`。
  // 空格是极弱的分隔符，**绝不能**无条件当分隔符用：
  // 1. 只信任**中文头部** —— `Piano in the dark`、`Drums are beating` 这类
  //    「英文乐器词 + 空格 + 歌词」是真实歌词的常见开头，英文头一律不拆
  //    （英文署名有 `Mixed by X` 的专用路径覆盖，不需要空格兜底）；
  // 2. 头部至少 2 个字符 —— 单字标签（`曲 终人散`、`词 爱恨`）是歌词写法，不拆；
  // 3. 头部不在 SPACE_SPLIT_HEAD_DENY：`感谢`/`设计` 这类**同时是高频歌词开头**
  //    的词，`感谢 陪伴` 是歌词而非署名（冒号形态不受影响，`感谢：X` 仍会剔除）。
  const spaceMatch = /^(\S+)[\s\u3000]+(\S.*)$/u.exec(undecorated);
  if (
    spaceMatch &&
    /[\u4e00-\u9fff\u3040-\u30ff]/u.test(spaceMatch[1]) &&
    [...spaceMatch[1]].length >= 2 &&
    !SPACE_SPLIT_HEAD_DENY.has(spaceMatch[1]) &&
    isCreditLabelOnly(spaceMatch[1])
  ) {
    return `${spaceMatch[1]}\u0000${spaceMatch[2].trim()}`;
  }
  return undefined;
};

/**
 * 裸机构名单行（无冒号、整行独占）：`太合音乐集团`、`朴林西思文化传媒`、
 * `北京国际音乐产业大会`、`主题歌音乐专辑工作团队`。以**强机构后缀**收尾的
 * 短行是制作名单页脚。刻意不收录 `唱片`/`娱乐`/`音乐` 等弱词 ——
 * `发霉的旧唱片` 这类歌词结尾必须保留；主体至少 3 字也排除 `某某公司` 式巧合。
 */
const BARE_ORG_SUFFIX_PATTERN =
  /^[\u4e00-\u9fffA-Za-z0-9·]{3,20}(?:集团|文化传媒|传媒|有限公司|公司|产业大会|工作团队)$/u;

/** 中文录音/混音机构粘连英文机构名：`升赫录音棚Soundhub Studio`。
 * 中文段以强设施词收尾 + 英文段是「首字母大写词 + Studio(s) 收尾」的机构形态；
 * 英文侧必须带 Studio(s) 后缀，`Love音乐` 这类非机构粘连不会命中。 */
const ZH_STUDIO_EN_ORG_PATTERN =
  /^[\u4e00-\u9fff]{2,20}(?:录音棚|录音室|工作室)[\s\u3000]*[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*\s+Studios?$/u;

/** 判断标签头部是否「完全由署名标签构成」。 */
const isCreditLabelOnly = (value: string): boolean => {
  if (!value) return false;

  // 中英混排：中文标签拼接英文标签，如 `曲Composer`、`词Lyricist`、`翻唱Cover`；
  // 网易云大量使用**带空格**的写法：`制作人 Producer`、`混音师 Mixing Engineer`、
  // `母带制作 Mastering Engineer`、`木吉他 Acoustic Guitar`。
  // 因此中文段要**整体捕获**（不止首字），中英之间允许空白；否则 `制作人 Producer`
  // 会被切成 `制` + `作人 Producer`，中文段过短而整条掉出词表。
  // 首字符必须是中日文字符，否则 `Special Thanks` 会被误拆成 `S` + `pecial Thanks`。
  const composite = /^([\u4e00-\u9fff\u3040-\u30ff]+)[\s\u3000]+([A-Za-z][A-Za-z\s]*)$/u.exec(value);
  if (composite) {
    if (isCreditLabelOnly(composite[1]) && isCreditLabelOnly(composite[2].trim())) return true;
    // 中文标签 + 英文对照翻译（TitleCase）：`制谱 Music Copyist`、`企划 Creative Planning`、
    // `古琴 Guqin`。对照词永远追不完词表（copyist/planning/guqin…），而 TitleCase 是
    // 双语署名的强特征：句中歌词的英文短语几乎必含小写虚词，逐词首字母大写的
    // 短语只会出现在对照署名里。每词 ≥2 字母排除 `设计 A Story` 这类歌词，词数 ≤4。
    if (
      isCreditLabelOnly(composite[1]) &&
      /^(?:[A-Z][A-Za-z]{1,19})(?:\s+[A-Z][A-Za-z]{1,19}){0,3}$/u.test(composite[2].trim())
    ) {
      return true;
    }
  }
  // 无空格粘连形态：`曲Composer`、`词Lyricist`（英文字母紧贴中文）。
  const glued = /^([\u4e00-\u9fff\u3040-\u30ff]+)([A-Za-z][A-Za-z\s]*)$/u.exec(value);
  if (glued) {
    if (isCreditLabelOnly(glued[1]) && isCreditLabelOnly(glued[2].trim())) return true;
    // 英文侧是普通英文单词后缀：`二创效果Edit`。与 joiner 段级的
    // 「已知标签 + 英文单后缀」同语义；中文侧必须是完整标签，
    // `Love音乐` 这类非标签中文侧不会命中。
    if (isCreditLabelOnly(glued[1]) && CREDIT_LABEL_SUFFIX_PATTERN.test(glued[2].trim())) {
      return true;
    }
  }
  // 反向粘连：英文标签在前 + 中文标签紧贴，如 `Vocal录音室`、`Vocal制作助理`。
  // 正向（中文在前）由上面的 glued 覆盖；两侧都必须各自是完整标签，
  // `Love音乐` 这类（Love 非标签）不会命中。
  const reversed = /^([A-Za-z][A-Za-z\s]*?)([\u4e00-\u9fff\u3040-\u30ff]+)$/u.exec(value);
  if (reversed) {
    if (isCreditLabelOnly(reversed[1].trim()) && isCreditLabelOnly(reversed[2])) return true;
  }

  // 多词英文标签：`Special Thanks`、`Mixed By`、`Production Coordination`。
  // 匹配前压掉空格，兼容 `specialthanks` 这类上游已去掉空格的形式。
  const compact = value.replace(/[\s\u3000]+/g, "");
  const wholeLabel = CREDIT_LABEL_PATTERN.exec(value)?.[0].replace(/[\s\u3000]+/g, "");
  if (wholeLabel === compact) return true;

  // 英文「限定词 + 角色」：`Music Producer`、`Musical Supervisor`、`Vocal Arrangements`。
  // 逐词判定 —— 每个词都必须是已知英文标签，才能合成一个复合标签。
  // 旧实现只覆盖中文打头的复合形态（`制作人 Producer`），纯英文复合全部漏网。
  // `and`/`with` 是并列连接词而非标签：`Marketing and promotion agencies`
  // 的语义是「A and B + 中心词」，连接词剔除后剩余词全部命中词表才判。
  // 歌词（`you and me`、`and I love you`）剔完连接词后剩余词不是标签，自然否决。
  if (/^[A-Za-z][A-Za-z\s]*$/u.test(value)) {
    const words = value
      .trim()
      .split(/[\s\u3000]+/u)
      .filter(Boolean)
      .filter((word) => !/^(?:and|with|&)$/i.test(word));
    if (words.length >= 2 && words.every((word) => CREDIT_LABEL_PATTERN.exec(word)?.[0].replace(/[\s\u3000]+/g, "") === word)) {
      return true;
    }
  }

  // 英文制作署名短标签：`A&R`、`Executive-Producer`、`Mixed At`（整体命中集合）。
  const normalizedForSet = value
    .normalize("NFKC")
    .trim()
    .replace(/[\s\u3000]+/g, " ")
    .toLowerCase();
  if (EN_CREDIT_SHORT_LABELS.includes(normalizedForSet)) return true;

  // 长复合技术标签：`弦乐线上录音系统及弦乐档案编辑 : Leonard Fong`。
  // 结构判定限头 6 字、词表追不全这类展开写法；用「纯中文 + 强技术词」判定：
  // 只有含**录音/混音/母带的具体设施词**（系统/棚/室/工作室）才算，
  // `回忆的录音` 这类歌词化表达不含设施词、不会命中。
  if (
    /^[\u4e00-\u9fff]{2,24}$/u.test(value) &&
    /录音系统|录音棚|录音室|混音室|混音棚|混音师|录音师|母带处理|母带工程|工作室|导演团队/u.test(value)
  ) {
    return true;
  }
  // 中文设施词机构名 + 英文机构名粘连：`升赫录音棚Soundhub Studio`（见常量注释）。
  if (ZH_STUDIO_EN_ORG_PATTERN.test(value)) {
    return true;
  }

  // 裸机构名单行：`太合音乐集团`、`朴林西思文化传媒`、`北京国际音乐产业大会`、
  // `主题歌音乐专辑工作团队`。以**强机构后缀**收尾的短行是制作名单页脚。
  // 刻意不收录 `唱片`/`娱乐`/`音乐` 等弱词 —— `发霉的旧唱片` 这类歌词结尾
  // 必须保留；主体至少 3 字也排除 `某某公司` 式的两字巧合。
  if (BARE_ORG_SUFFIX_PATTERN.test(value)) {
    return true;
  }

  // 编号/字母槽位：`键盘2`、`吉他1`、`人声录音棚A`、`人声录音棚B`。
  // 大编制制作名单会把同类乐器/录音棚按编号排布，词表里的 `键盘` 覆盖不到 `键盘2`。
  // 只允许在**已登记标签**后追加 1~2 位数字或单个大写字母，
  // 小写字母不放宽（`词a` 这类更像打字残渣以外的正常内容）。
  const slot = /^(.+?)(?:\d{1,2}|[A-Z])$/u.exec(compact);
  if (slot && CREDIT_LABEL_PATTERN.exec(slot[1])?.[0].replace(/[\s\u3000]+/g, "") === slot[1]) {
    return true;
  }

  // 括号限定词：`Assistant Engineer (香港)`、`主唱录音（北京）`、`混音师(Studio A)`。
  // 制作名单常用括号标注地区/棚号等限定信息，剥离后若剩余部分是纯标签即命中。
  const withoutQualifier = value.replace(/[\s\u3000]*[（(][^（()）]{1,20}[)）]\s*$/u, "").trim();
  if (withoutQualifier && withoutQualifier !== value && isCreditLabelOnly(withoutQualifier)) return true;
  // 中部括号限定词：`人声&吉他&鼓（打击乐）录音棚`。限定语夹在标签组合中间，
  // 剥离后各段仍是标签（`鼓录音棚` 走粘连拆分）即命中；歌词 `爱（真的）你`
  // 剥出 `爱你` 非标签，不受影响。
  const withoutMiddleQualifier = value.replace(/[（(][^（()）]{1,20}[)）]/u, "").trim();
  if (withoutMiddleQualifier && withoutMiddleQualifier !== value && isCreditLabelOnly(withoutMiddleQualifier)) return true;

  // 纯中文标签粘连：`小提琴演奏`、`制作统筹`、`音乐出品发行公司`。
  // 这类头由**两个已知标签直接拼接**而成（中间无连接符），逐段拆分接不住。
  // 枚举全部切分点，任一侧组合都命中词表才算；两侧都必须是完整登记标签，
  // 因此 `曲终人散`（曲|终人散，右侧非标签）、`说唱脸谱`（说唱|脸谱）等歌词头不受影响。
  if (/^[\u4e00-\u9fff]{2,12}$/u.test(value)) {
    for (let cut = 1; cut < value.length; cut += 1) {
      if (isCreditLabelOnly(value.slice(0, cut)) && isCreditLabelOnly(value.slice(cut))) {
        return true;
      }
    }
  }

  // 人名 + OP/SP 粘连：`梁翘柏OP : OP of Kubert Leung Musichic LTD.`、
  // `AlbertOP : OP of Lin Xi ...`。这是版权代理行的固定写法
  // （「词曲版权人 + OP/SP 缩写」），人名不可能进词表，
  // 只能按「中文人名或首字母大写英文名 + OP/SP 结尾」这一版权特有结构判定。
  if (/^(?:[\u4e00-\u9fff]{2,6}|[A-Z][a-z]{1,11})(?:OP|SP)$/u.test(value)) return true;

  // 尾缀署名介词：`Chorus by : 陈奕迅`。剥离 ` by` 后按纯标签判定；
  // 递归兜底保证 `Kiss by` 这类剥出的词不是标签时不会误判。
  const withoutBy = value.replace(/\s+by$/i, "").trim();
  if (withoutBy && withoutBy !== value && isCreditLabelOnly(withoutBy)) return true;

  // 序数前缀：`1st Violins : X`、`2nd Violins : X`（弦乐声部分排），
  // 以及拼写数词形态 `First Violin : X`、`Second Violins : X`。
  const withoutOrdinal = value
    .replace(
      /^(?:(?:\d{1,2}(?:st|nd|rd|th))|(?:first|second|third|fourth|fifth))\s+/i,
      "",
    )
    .trim();
  if (withoutOrdinal && withoutOrdinal !== value && isCreditLabelOnly(withoutOrdinal)) return true;

  // `原` 前缀：`原制作人 : X`、`原混音/母带工程师：X`（标注原版本制作班底）。
  // `原` 单字不是标签，粘连切分点枚举接不住；剥离后剩余部分是完整标签组合即判。
  // `原` 开头的歌词（`原来如此`）剥出 `来如此` 非标签，递归自然否决。
  const withoutOrigin = value.replace(/^原(?=[\u4e00-\u9fff]{2,})/u, "").trim();
  if (withoutOrigin && withoutOrigin !== value && isCreditLabelOnly(withoutOrigin)) return true;

  // 序数尾缀：`Violin 1st : X`、`Violin 2nd：X`（分谱编号后置写法）。
  const withoutOrdinalSuffix = value.replace(/\s+\d{1,2}(?:st|nd|rd|th)$/i, "").trim();
  if (
    withoutOrdinalSuffix &&
    withoutOrdinalSuffix !== value &&
    isCreditLabelOnly(withoutOrdinalSuffix)
  ) {
    return true;
  }

  // `Arranged & Conducted by` 这类并列动作短语。
  if (isCreditActionPhrase(value)) return true;

  // 中文标签以 `.` 分隔的形态：`作曲.监制 : X`、`词.曲 : X`、`编.混.母 : X`。
  // `.` 不进通用 joiner（英文缩写 `C. Y. Kong` 依赖它），单独按「每段都是
  // 完整标签」判定 —— `谁.在.唱` 这类歌词拆出的段不是标签，自然否决。
  if (/^[\u4e00-\u9fff]{1,8}(?:\.[\u4e00-\u9fff]{1,8})+$/u.test(value)) {
    const dotSegments = value.split(".");
    if (dotSegments.length > 1 && dotSegments.every((segment) => isCreditLabelOnly(segment))) {
      return true;
    }
  }

  // `和` 连接：`词和曲：X`、`填词和编曲：X`。独立于通用 joiner ——
  // `和` 同时是 `和声`/`和音`/`和编` 等标签的首字，单字符切分会把
  // `吉他、贝司、和声` 切出孤立 `声` 段而整条漏网。按 `和` 切开的
  // 每段都必须递归命中完整标签，`我和你`、`早餐和午餐` 自然否决。
  if (value.includes("和")) {
    const andSegments = value.split("和").filter(Boolean);
    if (andSegments.length > 1 && andSegments.every((segment) => isCreditLabelOnly(segment))) {
      return true;
    }
  }

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
    // 段级递归：`鼓录音棚`（鼓|录音棚粘连）这类复合段不命中词表，
    // 但整体是合法标签组合。只在**真拆分产物**（多段）上递归 ——
    // 单段即 value 本身，递归会无限自调用爆栈。
    if (segments.length > 1 && isCreditLabelOnly(segment)) {
      previousWasLabel = true;
      continue;
    }
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
  // `Drums Recorded at Aroom Studio` 这类以乐器词开头的录音信息行。
  if (isInstrumentRecordingHead(undecorated)) return true;
  // Discogs 风格短标签（`Mixed At – X`、`Executive-Producer – X`）：分隔符是 en dash，
  // `Executive-Producer` 还会被内部连字符抢先切开，必须用整行前缀判定绕开。
  if (EN_CREDIT_PREFIX_PATTERN.test(undecorated)) return true;
  // 唱片版权行：`P - Line: 2016 ...`、`C-Line: 2016 ...`（Phonogram/Copyright 标准写法）。
  // ` - ` 会把 head 切成孤立的 `P`，整行掉出词表路径，按单字母前缀整行判定。
  // `line` 后必须紧跟冒号：`C line up ...` 这类潜在歌词不受影响。
  if (/^[pc]\s*[-—–]?\s*line\s*[:：]/i.test(undecorated)) return true;
  // 主要版权厂牌裸行：`Warner/Chappell Music, Hong Kong Limite`。纯英文裸行走不进
  // 裸行路径（要求含中日文字），按「厂牌名开头 + 行内含公司后缀词」双条件判定；
  // `\b` 词边界防止 `emi` 吃掉 `Eminem` 一类人名，公司后缀词排除
  // `Universal love is all we need` 这类纯英文歌词。
  if (
    /^(?:warner(?:\s*\/\s*chappell)?|chappell|universal|sony|emi|bmg|kobalt|peermusic)\b/i.test(undecorated) &&
    /\b(?:music|records?|publishing|entertainment|limited|ltd|group|studios?)\b/i.test(undecorated)
  ) {
    return true;
  }
  // CV 配音标注：`温迪（CV：喵酱）`、`雷电将军（CV：菊花花）`。同人曲的角色名单
  // 本身就是歌曲指纹，且整行不含任何歌词正文，按结构整行判定。
  if (/^[^（()）]{1,20}（\s*CV\s*[：:][^（()）]{1,20}）\s*$/u.test(undecorated)) {
    return true;
  }
  // 书名号标题 + 制作名单：`《Plot: 0》动画 staff`。标题部分永远不进词表，
  // 按「书名号包裹 + staff/制作名单收尾」结构判定。注意 LEADING_DECORATION
  // 已把行首 `《` 剥掉（undecorated 形如 `Plot: 0》动画 staff`），
  // 左书名号必须可选，且标题段限 40 字内防止吞进长歌词。
  if (/^[《【]?[^《【》】]{1,40}[》】]\s*(?:动画|番剧|制作)?\s*(?:staff|制作名单|名单)\s*$/iu.test(undecorated)) {
    return true;
  }

  // 裸标签行：credit 块的段落标题独占一行（`出品`、`联合出品`），无冒号也无取值，
  // `splitCreditHead` 因找不到分隔符而整条失效。这里**只接受单个已登记标签**
  // 或强机构后缀行（`BARE_ORG_SUFFIX_PATTERN`），**不走** `isCreditLabelOnly`
  // 的粘连/逐段拆分 —— `后期制作人`（后期|制作人）这类两标签粘连是真实歌词，
  // 必须保留（正式测试回归抓到过）。同时沿用 SPACE_SPLIT_HEAD_DENY：
  // `感谢`、`导演` 这类高频歌词词裸写整行时按歌词保留；单字行交给过短/角色判定。
  if (
    /[\u4e00-\u9fff\u3040-\u30ff]/u.test(undecorated) &&
    [...undecorated].length >= 2 &&
    !SPACE_SPLIT_HEAD_DENY.has(undecorated) &&
    (CREDIT_LABEL_PATTERN.exec(undecorated)?.[0].replace(/[\s\u3000]+/g, "") ===
      undecorated.replace(/[\s\u3000]+/g, "") ||
      BARE_ORG_SUFFIX_PATTERN.test(undecorated) ||
      ZH_STUDIO_EN_ORG_PATTERN.test(undecorated))
  ) {
    return true;
  }

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
  // 英文段落词（`solo：我一个人跳舞`、`rap：看我的flow`）与乐器独奏署名同名，
  // 但它们常被用作歌词排版标记。区分标准与角色词一致：
  // 头部**恰好是这个词**（不是 `Guitar Solo` 这类复合署名）且右侧是实质歌词 → 放行。
  if (/^(?:solo|rap)$/i.test(normalizedHead) && isSubstantiveLyricTail(tail)) {
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
  isTechnicalInfoLine(text) ||
  isAffiliationCreditLine(text) ||
  isPlatformCreditLine(text) ||
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
 * 判定要求「整行（去掉空白与**全部标点/符号**后）只由同一字母组成且长度 ≥3」，
 * 这样 `X你太美`、`xxxxx我爱你`、`XXXXXXXXXXXXXXXXXX你好` 这类含实际文字的行不会被误杀；
 * 同时能覆盖 `～∧o∧o@∧o@∧o～...` 这类**符号夹单字母**的颜文字噪声行
 * （剥掉 `～∧@-` 后只剩重复的 `o`）。`U.S.A.`、`O.O` 剥后不足 3 位或非单字母，保留。
 */
export const isPlaceholderMaskLyricLine = (text: string): boolean => {
  const stripped = text.normalize("NFKC").replace(/[\s\u3000\p{P}\p{S}]/gu, "");
  if (stripped.length < 3) return false;
  return /^([A-Za-z])\1+$/u.test(stripped);
};

/** 舞台指示/编辑注记的固定词汇：`(Repeat)`、`（以下反复）`、`(silence)`、`(间奏)`。 */
const STAGE_DIRECTION_SOURCE = [
  "repeat", "silence", "silent", "instrumental", "interlude", "intro", "outro",
  "fade", "fadeout", "fade in", "fade out", "spoken", "whisper", "echo",
  // `(Music)`、`(Music♂)` 这类括号内间奏占位。
  "music",
  "以下反复", "以下重复", "间奏", "前奏", "尾奏", "反复", "重复", "此处",
  "略", "待补", "待定", "无歌词", "看不懂", "听不清", "念白",
  // 多语言段落标记：`(Припев:)`（俄语副歌）、`(Coro:)`（西/意）、`(Refrain)`（法语）、
  // `(サビ)`（日语副歌）、`(간주)`（韩语间奏）。这些在网易云外语曲目里很常见。
  "припев", "куплет", "chorus", "verse", "bridge", "pre-chorus", "hook",
  "coro", "estribillo", "refrain", "pont", "サビ", "aメロ", "bメロ", "間奏",
  "간주", "후렴", "절",
].join("|");

/** 括号内的制作方标注：`（烛光制作）`、`(某某出品)`、`（原创团队献上）`。 */
const BRACKET_PRODUCTION_SUFFIX_PATTERN =
  /^[\u4e00-\u9fffA-Za-z0-9·]{1,12}(?:制作|出品|原创|献上|呈献|作品)$/u;

const STAGE_DIRECTION_PATTERN = new RegExp(`^(?:${STAGE_DIRECTION_SOURCE})$`, "i");

/**
 * 整行被一对括号完整包裹的舞台指示行。
 *
 * 网易云上大量上传谱把说明性文字整行写在括号里，例如
 * `(何が綴られていたのか、私たちの文明では到底理解できない)`、`（以下反复）`、`(Repeat)`、
 * `(Припев:)`。这些句子不含任何可猜的歌词内容，且**会暴露段落结构**，必须剔除。
 *
 * 但括号在真实歌词里同样常见（和声、重复句、英文衬词），所以判定必须保守：
 * 只有满足以下任一条才剔除：
 * 1. 内层命中舞台指示词表（含多语言段落标记）；
 * 2. 内层形如「标签 + 冒号」（`Припев:`、`Verse 1:`、`Chorus：`），冒号后为空 ——
 *    这是段落标记的通用形态，任何真实歌词括号内容都不会以「单个词 + 冒号结尾」出现；
 * 3. 内层含 `、`/`,`/`，` 这类**并列或断句**标点（真实歌词的括号内容极少是长句）。
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

  // 去掉尾部的冒号后再比对词表，兼容 `(Припев:)`、`(Repeat:)` 形态。
  const withoutTrailingColon = inner.replace(/[:：]\s*$/u, "").trim();
  // 剥掉**两端**装饰符号，兼容 `(Music♂)`、`(*music*)` 这类带符号的间奏占位。
  const withoutSymbols = withoutTrailingColon
    .replace(/^[\p{S}\p{P}]+|[\p{S}\p{P}]+$/gu, "")
    .trim();
  if (STAGE_DIRECTION_PATTERN.test(withoutSymbols)) return true;

  // 括号内的制作方标注：`（烛光制作）`、`(某某出品)`。
  if (BRACKET_PRODUCTION_SUFFIX_PATTERN.test(inner)) return true;

  // 括号内的原曲信息：`（飞机场的10:30 - 陶喆）`。
  // 形态特征高度特异：内层含「分:秒」式时间戳，随后是破折号 + 短人名尾，
  // 真实歌词的括号和声/衬词不会长这样。
  if (/^[^：:]{1,30}\d{1,2}:\d{2}\s*[-–—]\s*[^-–—]{1,20}$/u.test(inner)) return true;

  // 「单词 + 冒号结尾」的段落标记形态（`Verse 1:`、`Припев:`），冒号后无内容。
  if (/^[^\s:：,，、;；]{1,20}(?:\s\d{1,2})?\s*[:：]\s*$/u.test(inner)) return true;

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
  // 商用授权/搬运声明：`已获商用授权`、`未经著作权人许可禁止搬运`、`禁止翻录`、`禁止Remix`。
  "商用授权", "著作权人", "禁止搬运", "禁止翻录", "禁止转载", "翻录", "remix",
  "仅供个人学习", "不得用于商业",
  // 出版方行：`/ EMI Music Publishing (S.E. Asia) Ltd, Taiwan Branch` —— 唱片内页
  // 连排出版信息被拆成的碎片行，`publishing` 一词在真实歌词里不会出现。
  "music publishing", "publishing\\s*\\(",
  // 授权/改编声明：`——正版授权，改编自《Counting stars》——`。
  "正版授权", "改编自", "翻唱自", "原曲出自",
  // 出处声明：`本歌曲来自〖云上工作室〗`。不要求平台名命中 ——
  // 「本歌曲来自 X」是发行侧固定句式，真实歌词不会这么说。
  "本(?:歌曲|作品|音乐)来自",
  // R8 实测补漏：`已买版权 禁止二改二传`、`版权公司：X`、
  // `Used by permission of ...`（内页授权套话）、`X reserved.`（省略
  // all rights 的页脚碎片；`Spot is forever reserved` 这类无句点歌词不受影响）。
  "已买版权", "版权公司", "used\\s+by\\s+permission", "reserved\\.",
  // R10 实测补漏：`(Admin. by Warner/Chappell Music Korea)`（版权管理代理套话）。
  "admin\\.?\\s+by",
].join("|");

const COPYRIGHT_NOTICE_PATTERN = new RegExp(COPYRIGHT_NOTICE_SOURCE, "i");

/** 版权/法律声明行：整行命中固定短语即判定无效。 */
export const isCopyrightNoticeLine = (text: string): boolean => {
  const normalized = text.normalize("NFKC").replace(/[\s\u3000]+/g, " ").trim();
  if (!normalized) return false;
  return COPYRIGHT_NOTICE_PATTERN.test(normalized);
};

/**
 * 技术参数与联系信息行：`ISRC：TWA451498702`、`UPC：...`、
 * `合作：st399@vip.163.com`、`联系：xxx@qq.com`、`https://...`。
 *
 * 这类行不含任何歌词语义，却会被出题者看到唱片编号与联系方式。
 * 判定分两支：**编号类标签**（ISRC/UPC/ISWC/EAN/barcode）与
 * **邮箱/网址**（含 `@` 且形如邮箱，或含协议/域名）。
 * 注意 `@` 判定要足够具体，避免误伤歌词里的 `@`（如 `Sing @ the top`）。
 */
const TECHNICAL_ID_PATTERN = /^(?:isrc|upc|ean|iswc|isbn|barcode|条形码)\s*[:：]?\s*[A-Z0-9-]{6,}$/i;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_PATTERN = /https?:\/\/|www\.[A-Za-z0-9-]+\.[A-Za-z]{2,}/i;

export const isTechnicalInfoLine = (text: string): boolean => {
  const normalized = text.normalize("NFKC").replace(/[\s\u3000]+/g, " ").trim();
  if (!normalized) return false;
  if (TECHNICAL_ID_PATTERN.test(normalized)) return true;
  if (EMAIL_PATTERN.test(normalized)) return true;
  if (URL_PATTERN.test(normalized)) return true;
  // `ISRC :` / `UPC：` 这类只有标签、取值另起/缺失的残留行。
  return /^(?:isrc|upc|ean|iswc|isbn|barcode)\s*[:：]\s*$/i.test(normalized);
};

/**
 * 团体/工作室归属署名：`朗梓朔@维伴音乐`、`王皓@WONDERWALL`、`洪信杰@牛班NEWBAND`。
 *
 * 网易云近年大量出现「人名 @ 团队名」的归属写法，用于标注乐手所属厂牌或乐队。
 * 它既不含冒号（`splitCreditHead` 拆不出标签），也不是邮箱（`@` 后无 TLD），
 * 因此会从词表、结构、技术信息三条路径全部漏出。
 *
 * 判定必须严格，避免误伤歌词里的 `@`：
 * 1. `@` 两侧**紧贴**（不允许空白），排除 `Sing @ the top`、`I'll be there @ 3am`；
 * 2. `@` 右侧是**团队名形态**：含至少一个 ASCII 大写字母且长度 ≥3
 *    （`WONDERFALL`、`NEWBAND`、`牛班NEWBAND`、`BrandNew`），或全中文（`维伴音乐`、`爱之音`）。
 *    这自然排除 `me@you`、`love@first`、`你@我`（右侧无大写或过短）；
 *    `@` 左侧允许人名形态（中文名、英文名、`张人杰Andy` 这类中英混排）；
 * 3. 整行**只由归属片段构成**（允许 `/`、空白、顿号分隔多个片段），
 *    排除夹在句子里的 `Send it to me @ midnight` 这类歌词。
 */
const AFFILIATION_SEGMENT_PATTERN =
  /^(?:[\u4e00-\u9fff]{1,12}[A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*[\u4e00-\u9fff]{1,12}|[A-Za-z][A-Za-z0-9]*|[A-Za-z0-9]*[A-Za-z])@(?:[\u4e00-\u9fffA-Za-z0-9]+)$/u;

export const isAffiliationCreditLine = (text: string): boolean => {
  const normalized = text.normalize("NFKC").trim();
  if (!normalized || !normalized.includes("@")) return false;
  // 团队名常含空格（`Kevin刘瀚文@Soundhub Studios`）：先把它后面的
  // 机构词并回 @ 片段（去掉空格粘连成 `@SoundhubStudios`），否则空格拆分
  // 会把 `Studios` 甩成无 @ 的独立片段而整行判定失败。
  // 只并回明确的机构后缀词，`Sing @ the top of my lungs` 不受影响。
  const merged = normalized.replace(
    /(@[\u4e00-\u9fffA-Za-z0-9]+)[\s\u3000]+((?:Studios?|Records?|Music|Entertainment|Company|Corporation|Corp\.?|Ltd\.?|Limited|Group|Band|Production|Productions|Studio)\b)/gu,
    "$1$2",
  );
  const segments = merged.split(/[\s\u3000/／,，、|｜]+/u).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const match = AFFILIATION_SEGMENT_PATTERN.exec(segment);
    if (!match) return false;
    // `@` 右侧的团队名必须是「团队形态」：≥3 个 ASCII 字母且含大写，
    // 或 ≥2 个汉字。仅此一条即可排除 `me@you`、`love@first`、`你@我`。
    const team = match[0].slice(match[0].lastIndexOf("@") + 1);
    const ascii = team.replace(/[^A-Za-z]/g, "");
    if (/^[\u4e00-\u9fff]+$/u.test(team)) return team.length >= 2;
    return ascii.length >= 3 && /[A-Z]/.test(ascii);
  });
};

/**
 * 平台/企划出品声明：`网易云音乐特别企划“回声不息”出品`、`本歌曲来自〖网易音乐人〗`。
 *
 * 这类行既非署名也非版权，但会把「这是网易云自制的企划曲」这一背景信息泄露给猜题者，
 * 且行末常带书名号/引号包裹的企划名，词表永远追不全。按**平台名 + 出品/来自**结构判定。
 */
const PLATFORM_CREDIT_PATTERN =
  /(?:网易(?:音乐人|云音乐|云|音乐)?|qq音乐|酷狗音乐|咪咕音乐|bilibili)/iu;

export const isPlatformCreditLine = (text: string): boolean => {
  const normalized = text.normalize("NFKC").replace(/[\s\u3000]+/g, " ").trim();
  if (!normalized) return false;
  // 整行被括号包裹且内层含平台名：`【bilibili音乐·2022虚拟歌手贺岁纪】`。
  // 这类企划行没有出品/来自等关键词也必须判定 —— 平台名本身已是泄露源。
  // 必须要求平台名命中，否则 `【副歌】` 这类段落标注会被整行误杀。
  if (
    PLATFORM_CREDIT_PATTERN.test(normalized) &&
    /^[【\[（(][^【\[（()）】\]]{1,40}[】\])）]$/u.test(normalized)
  ) {
    return true;
  }
  if (!PLATFORM_CREDIT_PATTERN.test(normalized)) return false;
  // `from` 是发行侧英文关键词：`From 爱你的网易云音乐`。大小写都要接住，必须带 i。
  return /出品|来自|企划|独家|首发|联合|制作|from/i.test(normalized);
};

/**
 * 对唱角色标注行（`男：`、`女：`、`合：`、`合唱：`，以及任意演唱人名的 `徐良L:`、`Ty：`、
 * 声乐角色的 `戏腔：`、`京剧：`）。
 *
 * 这类行给出的是**演唱分工而非歌词内容**，且右侧为空，
 * `splitCreditHead` 会因「取值缺失」直接返回 undefined 而漏网。
 *
 * 判定放宽为「**短标签 + 冒号结尾且右侧为空**」，而不是固定词表 —— 因为
 * `戏腔`/`京剧`/`徐良L`/`Ty` 这类分工名永远枚举不完，而「空取值」这一结构特征本身
 * 就足以判定它不含可猜内容。安全性依据：实测 150 首真实歌曲里该形态只有 4 种，
 * 全是分工标注，**没有任何一行真实歌词是「短标签 + 冒号 + 空」**。
 *
 * 标签允许含空格以覆盖英文演唱者（`Ariana Grande：`、`2 Chainz：`），
 * 也允许 `、/／` 连接多人分工（`封茗囧菌、双笙：`），但要求不含句末标点、
 * 不含引号、每段长度 ≤20，避免把 `Say: "..."` 这类带取值的行误判
 * （右侧非空天然不命中）。
 */
const EMPTY_VALUE_LABEL_PATTERN = /^[^\s:：'"，。！？、；]{1,20}(?:[\s、／/][^\s:：'"，。！？、；]{1,20}){0,3}\s*[:：]\s*$/u;

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
  return EMPTY_VALUE_LABEL_PATTERN.test(trimmed) || WRAPPED_DUET_ROLE_PATTERN.test(trimmed);
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
