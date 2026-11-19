import type {
  SongAlbumSearchResult,
  SongArtistSearchResult,
  SongChorus,
  SongDetails,
  SongPlaylistInfo,
  SongSearchResult,
  SonGuessrMusicAccount,
} from "../../shared/Index";

/**
 * 房间侧的取歌凭据有两种形状：只登录了一端时是裸字符串（`MUSIC_U=…`、`qm_keyst=…`），
 * 两端同时在房时是 `{ netease, qq }` 组合包，由聚合 provider 拆给各自上游。
 */
export type MusicCookieInput = string | Partial<Record<"netease" | "qq", string>>;

/** 音源平台。URN 前缀即平台名（见 `MusicUrn`）。 */
export type MusicPlatform = "netease" | "qq";

export interface MusicSearchOptions {
  /**
   * 池内至少有一个会员账号的平台。只有 QQ 用得上：会员专享曲目拿到非会员账号时
   * 取不到直链，结果需标「不可播放」；网易云走解灰兜底，不按会员档判可用性。
   */
  vipPlatforms?: readonly MusicPlatform[];
  /**
   * 共有曲目代表哪一侧的平台顺序。默认网易云先于 QQ；只有 QQ 账号的房间传入
   * `["qq", "netease"]`，避免把共有曲目默认归到本房没有直接凭据的一侧。
   */
  platformPreference?: readonly MusicPlatform[];
}

/** 跨平台兜底检索所需的曲目信息。 */
export interface SongFailoverHint {
  title: string;
  artist: string;
  durationMs?: number;
}

/**
 * 音乐上游适配层契约。实现有网易云、QQ 音乐与把两者合起来的聚合 provider。
 *
 * **每玩家配额隔离的前置条件由调用方承担，不在本接口的方法签名里。**
 * `NeteaseMusicProvider` 用 `musicIpScope`（一个 AsyncLocalStorage）给匿名请求按玩家分出口 IP
 * 与限流配额，作用域必须在**整条调用链的最外层**建立 —— 应用层的做法见
 * `SonGuessrService.execute`。从作用域外调用本接口的匿名请求不会失败，但会落到共享的
 * `anonymous` 出口、和所有同样无域的请求挤在同一份配额里（一人打满、全服 405）。
 * 这条降级现在是可观测的：每次调用计数，并按固定间隔补一条告警。
 * 有意使用共享出口的后台任务（预热、缓存维护）用 `runWithAnonymousMusicIpScope` 显式声明，
 * 那是设计如此而不是配置错误，不该混进告警。带房主凭证的请求不受影响：scope 由凭证决定。
 */
export interface MusicProvider {
  search(
    keyword: string,
    limit?: number,
    cookie?: MusicCookieInput,
    options?: MusicSearchOptions
  ): Promise<SongSearchResult[]>;
  /**
   * 取完整歌曲（含音频与歌词）。`allowFailover=false` 只允许解析本 ID 所属平台，
   * 供调用方按已知备用音源逐个尝试时避免每失败一次就重新按歌名跨平台搜索。
   * `hint` 是调用方已知的曲目信息：跨平台兜底直接用它检索，不必再回源取原曲元数据
   * （原平台正被限流时，取元数据会撞上同一条限流线，兜底随之落空）。
   */
  getSong(
    songId: string,
    cookie?: MusicCookieInput,
    options?: { allowFailover?: boolean; hint?: SongFailoverHint }
  ): Promise<SongDetails>;
  refreshSongAudio?(songId: string, cookie?: MusicCookieInput): Promise<string>;
  getSongMetadata(songId: string, cookie?: MusicCookieInput): Promise<SongDetails>;
  getSongPopularity?(songId: string, cookie?: MusicCookieInput): Promise<number | undefined>;
  getSongChorus?(songId: string, cookie?: MusicCookieInput): Promise<SongChorus | undefined>;
  getAmllTtmlLyrics?(songId: string): Promise<string | undefined>;
  searchAmllTtmlLyrics?(songName: string, artistName?: string): Promise<string | undefined>;
  createQrLogin?(platform?: "netease" | "qq", type?: "qq" | "wx" | "mobile"): Promise<MusicQrLogin>;
  checkQrLogin?(
    key: string,
    platform?: "netease" | "qq",
    type?: "qq" | "wx" | "mobile"
  ): Promise<MusicQrLoginCheck>;
  getLoginStatus?(
    cookie: string,
    platform?: "netease" | "qq",
    options?: { forceRefresh?: boolean }
  ): Promise<MusicLoginSession>;
  uploadDeviceInfo?(cookie: string, deviceName?: string): Promise<boolean>;
  getPlaylistSongs?(
    playlistId: string,
    cookie?: MusicCookieInput
  ): Promise<{ info: SongPlaylistInfo; songs: SongSearchResult[] }>;
  searchArtists?(
    keyword: string,
    limit?: number,
    cookie?: MusicCookieInput,
    options?: MusicSearchOptions
  ): Promise<SongArtistSearchResult[]>;
  getArtistSongs?(artistId: string, cookie?: MusicCookieInput): Promise<SongSearchResult[]>;
  /** 按关键词检索专辑（供「专辑型 Bangumi 条目」取曲目用，见 `SongAlbumSearchResult`）。 */
  searchAlbums?(
    keyword: string,
    limit?: number,
    cookie?: MusicCookieInput,
    options?: MusicSearchOptions
  ): Promise<SongAlbumSearchResult[]>;
  /** 取整张专辑的曲目。 */
  getAlbumSongs?(albumId: string, cookie?: MusicCookieInput): Promise<SongSearchResult[]>;
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
