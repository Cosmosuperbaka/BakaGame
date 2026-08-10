import { AppError } from "../domain/errors";
import type {
  SongDetails,
  SongEncyclopedia,
  SongGuessrMusicAccount,
  SongLyricLine,
  SongSearchResult,
} from "../shared";

type ApiResponse = { body?: unknown } | unknown;
type ApiFunction = (params: Record<string, unknown>) => Promise<ApiResponse>;
type ApiModule = Record<string, unknown>;

export interface MusicProvider {
  search(keyword: string, limit?: number, cookie?: string): Promise<SongSearchResult[]>;
  getSong(songId: string, cookie?: string): Promise<SongDetails>;
  getSongMetadata(songId: string, cookie?: string): Promise<SongDetails>;
  createQrLogin?(): Promise<MusicQrLogin>;
  checkQrLogin?(key: string): Promise<MusicQrLoginCheck>;
  sendPhoneCaptcha?(phone: string, countryCode?: string): Promise<void>;
  loginWithPhone?(params: MusicPhoneLogin): Promise<MusicLoginSession>;
  loginWithEmail?(email: string, password: string): Promise<MusicLoginSession>;
  getLoginStatus?(cookie: string): Promise<MusicLoginSession>;
}

export interface NeteaseMusicProviderOptions {
  loadApi?: () => Promise<ApiModule>;
  /** 通过 Enhanced API 的随机中国出口降低网易云安全风控误判。默认开启。 */
  randomCNIP?: boolean;
}

export interface MusicLoginSession {
  cookie: string;
  account: SongGuessrMusicAccount;
}

export interface MusicPhoneLogin {
  phone: string;
  countryCode?: string;
  password?: string;
  captcha?: string;
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

const normalizeAudioUrl = (value: unknown): string | undefined => {
  const raw = readString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    // 网易云播放接口仍可能返回 HTTP；HTTPS 页面会将其作为混合内容直接拦截。
    if (url.protocol === "http:") url.protocol = "https:";
    return url.toString();
  } catch {
    return raw;
  }
};

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

const readLoginAccount = (body: Record<string, unknown>): SongGuessrMusicAccount => {
  const data = asRecord(body.data);
  const profile = asRecord(body.profile ?? data.profile);
  const account = asRecord(body.account ?? data.account);
  const nickname = readString(profile.nickname ?? account.userName ?? account.nickname) ?? "网易云用户";
  return {
    userId: readString(profile.userId ?? profile.id ?? account.id ?? account.userId),
    nickname,
    avatarUrl: readString(profile.avatarUrl ?? profile.avatar),
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
  return {
    id,
    title,
    artist: artistNames(song),
    album: readString(album.name),
    pictureUrl: readString(album.picUrl ?? album.pic),
    durationMs: readNumber(song.dt ?? song.duration),
  };
};

const normalizeComparableText = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_—–/:：·.'"“”‘’()（）\[\]【】]/g, "");

const CREDIT_LINE_PATTERN = /^(?:作词(?:人)?|填词|词曲|词|作曲(?:人)?|谱曲|曲|编曲(?:人|师)?|制作人|制作|监制|混音(?:师)?|母带(?:工程师)?|录音(?:师)?|和声|吉他|贝斯|鼓|弦乐(?:编写)?|统筹|发行|出品|演唱|主唱|歌手|op|sp|publisher|lyric(?:s|ist)?|composer|arranger|producer|vocal(?:s|ist)?|lyrics?\s+by|music\s+by|written\s+by|produced\s+by|production\s+coordination|keyboards?(?:\s*&\s*programming)?|programming|drums?|bass|guitars?|percussion|strings?\s+arranged(?:\s*&\s*conducted)?\s+by|vocals?\s+recorded\s+at|recorded\s+at|engineered\s+by|mixed\s+by|mastered\s+by)\s*(?::|：|-|—|\/|\s)/i;

/** 过滤会直接暴露创作人员的 LRC 署名行。 */
export const isCreditLyricLine = (text: string) => CREDIT_LINE_PATTERN.test(text.trim());

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
  return /^(?:music|instrumental|interlude|intro|outro|inst)(?:\d+)?$/.test(normalized) ||
    /^(?:music|instrumental|interlude|intro|outro|inst)(?:music|instrumental|interlude|intro|outro|inst)$/.test(normalized);
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
 */
export const sanitizeLyrics = (
  lyrics: SongLyricLine[],
  song: Pick<SongSearchResult, "title" | "artist" | "album">,
): SongLyricLine[] => {
  const title = normalizeComparableText(song.title);
  const artist = normalizeComparableText(song.artist);
  const album = song.album ? normalizeComparableText(song.album) : "";
  const forbidden = new Set([
    title,
    artist,
    album,
    `${title}${artist}`,
    `${artist}${title}`,
  ].filter(Boolean));
  const filtered = lyrics.filter((line) => {
    if (isCreditLyricLine(line.text)) return false;
    if (isInstrumentalLyricLine(line.text)) return false;
    const normalizedLine = normalizeComparableText(line.text);
    if (forbidden.has(normalizedLine)) return false;
    // 歌名可能嵌在一句完整歌词里；至少两个字符才做包含判断，避免误伤单字歌名。
    return title.length < 2 || !normalizedLine.includes(title);
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

  constructor(private readonly options: NeteaseMusicProviderOptions = {}) {
    this.randomCNIP = options.randomCNIP ?? true;
  }

  async search(keyword: string, limit = 20, cookie?: string): Promise<SongSearchResult[]> {
    const normalized = keyword.trim();
    if (!normalized) return [];

    const response = await this.call(["cloudsearch", "search"], {
      keywords: normalized,
      limit: Math.max(1, Math.min(limit, 50)),
      type: 1,
    }, cookie);
    const body = responseBody(response);
    const result = asRecord(body.result);
    return asArray(result.songs)
      .map(normalizeSong)
      .filter((song): song is SongSearchResult => Boolean(song));
  }

  async getSong(songId: string, cookie?: string): Promise<SongDetails> {
    return this.loadSong(songId, true, cookie);
  }

  async getSongMetadata(songId: string, cookie?: string): Promise<SongDetails> {
    return this.loadSong(songId, false, cookie);
  }

  async createQrLogin(): Promise<MusicQrLogin> {
    const keyResponse = await this.call(["login_qr_key"], {}, undefined, false);
    const keyBody = responseBody(keyResponse);
    const key = readString(asRecord(keyBody.data).unikey ?? keyBody.unikey);
    if (!key) throw new AppError("MUSIC_LOGIN_FAILED", "无法创建登录二维码");

    const qrResponse = await this.call(["login_qr_create"], { key, qrimg: true }, undefined, false);
    const qrData = asRecord(responseBody(qrResponse).data);
    const qrUrl = readString(qrData.qrurl);
    const qrImage = readString(qrData.qrimg);
    if (!qrUrl || !qrImage) throw new AppError("MUSIC_LOGIN_FAILED", "无法生成登录二维码");
    return { key, qrUrl, qrImage };
  }

  async checkQrLogin(keyValue: string): Promise<MusicQrLoginCheck> {
    const key = keyValue.trim();
    if (!key) throw new AppError("INVALID_LOGIN", "二维码登录密钥不能为空");
    const response = await this.call(["login_qr_check"], { key }, undefined, false);
    const body = responseBody(response);
    const code = responseCode(body);
    const message = responseMessage(body, "等待扫码");
    if (code === 800) return { status: "expired", message };
    if (code === 802) return { status: "scanned", message };
    if (code !== 803) return { status: "waiting", message };

    const cookie = responseCookie(response);
    if (!cookie) throw new AppError("MUSIC_LOGIN_FAILED", "扫码成功但未取得登录 Cookie");
    const session = await this.getLoginStatus(cookie);
    return { status: "authorized", message, session };
  }

  async sendPhoneCaptcha(phoneValue: string, countryCodeValue = "86"): Promise<void> {
    const phone = phoneValue.trim();
    const countryCode = countryCodeValue.trim() || "86";
    if (!phone) throw new AppError("INVALID_LOGIN", "手机号不能为空");
    const response = await this.call(["captcha_sent"], { phone, ctcode: countryCode }, undefined, false);
    const body = responseBody(response);
    if (responseCode(body) !== 200) {
      throw new AppError("MUSIC_LOGIN_FAILED", responseMessage(body, "验证码发送失败"));
    }
  }

  async loginWithPhone(params: MusicPhoneLogin): Promise<MusicLoginSession> {
    const phone = params.phone.trim();
    const countryCode = params.countryCode?.trim() || "86";
    const password = params.password;
    const captcha = params.captcha?.trim();
    if (!phone) throw new AppError("INVALID_LOGIN", "手机号不能为空");
    if (!password && !captcha) throw new AppError("INVALID_LOGIN", "请输入密码或验证码");
    const response = await this.call(["login_cellphone"], {
      phone,
      countrycode: countryCode,
      ...(captcha ? { captcha } : { password }),
    }, undefined, false);
    return this.readLoginSession(response);
  }

  async loginWithEmail(emailValue: string, passwordValue: string): Promise<MusicLoginSession> {
    const email = emailValue.trim();
    const password = passwordValue;
    if (!email || !password) throw new AppError("INVALID_LOGIN", "邮箱和密码不能为空");
    const response = await this.call(["login"], { email, password }, undefined, false);
    return this.readLoginSession(response);
  }

  async getLoginStatus(cookieValue: string): Promise<MusicLoginSession> {
    const cookie = cookieValue.trim();
    if (!cookie) throw new AppError("MUSIC_SESSION_INVALID", "登录 Cookie 不能为空");
    const response = await this.call(["login_status"], {}, cookie, false);
    const body = responseBody(response);
    if (responseCode(body) !== 200) {
      throw new AppError("MUSIC_SESSION_INVALID", "网易云登录状态已失效");
    }
    return { cookie, account: readLoginAccount(body) };
  }

  private async loadSong(
    songId: string,
    includeResources: boolean,
    cookie?: string,
  ): Promise<SongDetails> {
    const id = songId.trim();
    if (!id) throw new AppError("INVALID_SONG", "歌曲 ID 不能为空");

    const detailResponse = await this.call(["song_detail"], { ids: id }, cookie);
    const detailBody = responseBody(detailResponse);
    const rawSong = asArray(detailBody.songs)[0];
    const base = normalizeSong(rawSong);
    if (!base) throw new AppError("SONG_NOT_FOUND", "未找到歌曲信息");

    const wikiPromise = this.callOptional(["song_wiki_summary", "song_wiki_home"], { id }, cookie);
    const lyricPromise = includeResources
      ? this.call(["lyric_new", "lyric"], { id }, cookie)
      : Promise.resolve(undefined);
    const urlPromise = includeResources
      // song_url_v1 在当前 API Enhanced 版本中可能因缺少 xeapi 公钥直接抛错；
      // 优先使用稳定的 song_url，并保留 v1 作为后备。
      ? this.call(["song_url", "song_url_v1"], { id, level: "standard", br: 320000 }, cookie)
      : Promise.resolve(undefined);

    const [wikiResponse, lyricResponse, urlResponse] = await Promise.all([
      wikiPromise,
      lyricPromise,
      urlPromise,
    ]);

    const songRecord = asRecord(rawSong);
    const album = asRecord(songRecord.al ?? songRecord.album);
    const publishTime = readNumber(songRecord.publishTime ?? album.publishTime);
    const wiki = readWiki(wikiResponse ? responseBody(wikiResponse) : undefined);

    let audioUrl = "";
    let lyrics: SongLyricLine[] = [];
    if (includeResources) {
      const urlBody = responseBody(urlResponse);
      audioUrl = normalizeAudioUrl(asRecord(asArray(urlBody.data)[0]).url) ?? "";
      const lyricBody = responseBody(lyricResponse);
      const lrc = asRecord(lyricBody.lrc ?? lyricBody.yrc);
      lyrics = sanitizeLyrics(parseLrc(readString(lrc.lyric) ?? ""), base);

      if (!audioUrl) throw new AppError("SONG_UNAVAILABLE", "该歌曲暂时没有可用播放地址");
      if (lyrics.length === 0) throw new AppError("LYRICS_UNAVAILABLE", "该歌曲没有可用的时间轴歌词");
    }

    return {
      ...base,
      audioUrl,
      lyrics,
      releaseYear: publishTime ? new Date(publishTime).getUTCFullYear() : undefined,
      popularity: readNumber(songRecord.pop ?? songRecord.popularity),
      language: wiki.language,
      encyclopedia: {
        summary: wiki.summary,
        aliases: wiki.aliases,
        tags: wiki.tags,
      },
    };
  }

  private async loadApi(): Promise<ApiModule> {
    if (!this.apiPromise) {
      this.apiPromise = this.options.loadApi
        ? this.options.loadApi()
        : import("@neteasecloudmusicapienhanced/api") as Promise<ApiModule>;
    }
    return this.apiPromise;
  }

  private async call(
    names: string[],
    params: Record<string, unknown>,
    cookie?: string,
    randomCNIP = this.randomCNIP,
  ): Promise<ApiResponse> {
    const api = await this.loadApi();
    let hasEndpoint = false;
    for (const name of names) {
      const fn = api[name];
      if (typeof fn === "function") {
        hasEndpoint = true;
        try {
          return await (fn as ApiFunction)(this.withCookie(params, cookie, randomCNIP));
        } catch {
          // 同一能力可能有多个兼容端点；当前端点运行失败时继续尝试后备实现。
        }
      }
    }
    if (!hasEndpoint) {
      throw new AppError("MUSIC_API_UNAVAILABLE", `音乐 API 缺少接口：${names.join(" / ")}`);
    }
    throw new AppError("MUSIC_API_FAILED", "网易云音乐接口请求失败，请稍后重试");
  }

  private async callOptional(
    names: string[],
    params: Record<string, unknown>,
    cookie?: string,
  ): Promise<ApiResponse | undefined> {
    try {
      return await this.call(names, params, cookie);
    } catch (error) {
      if (error instanceof AppError && error.code === "MUSIC_API_UNAVAILABLE") return undefined;
      return undefined;
    }
  }

  private readLoginSession(response: ApiResponse): MusicLoginSession {
    const body = responseBody(response);
    if (responseCode(body) !== 200) {
      throw new AppError("MUSIC_LOGIN_FAILED", responseMessage(body, "网易云登录失败"));
    }
    const cookie = responseCookie(response);
    if (!cookie) throw new AppError("MUSIC_LOGIN_FAILED", "登录成功但未取得 Cookie");
    return { cookie, account: readLoginAccount(body) };
  }

  private withCookie(
    params: Record<string, unknown>,
    cookie?: string,
    randomCNIP = this.randomCNIP,
  ): Record<string, unknown> {
    return {
      ...params,
      ...(cookie ? { cookie } : {}),
      randomCNIP,
    };
  }
}
