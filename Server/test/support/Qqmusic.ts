import type {
  ArtistSongsQuery,
  LoginQrCheckQuery,
  LoginQrCreateQuery,
  LoginRefreshQuery,
  LoginStatusQuery,
  LyricQuery,
  PlaylistDetailQuery,
  PlaylistTrackAllQuery,
  Response,
  SearchQuery,
  SongDetailQuery,
  SongUrlQuery,
} from "qqmusic-api-enhanced";

type QqmusicApi = typeof import("qqmusic-api-enhanced").default;

/**
 * 音源库方法桩工厂：查询参数与响应封面按库类型约束，响应体保留未标注 JSON。
 * 实现侧本就以 asRecord 消费上游返回，用例也刻意覆盖多种响应形状，
 * 把响应体钉成库声明的 Result 会改掉夹具语义。返回值即传入的 mock，保留 .mock 断言能力。
 */
export const qqStub = {
  search: (handler: (query?: SearchQuery) => Promise<Response>): QqmusicApi["search"] => handler,
  song_detail: (
    handler: (query?: SongDetailQuery) => Promise<Response>
  ): QqmusicApi["song_detail"] => handler,
  song_url: (handler: (query?: SongUrlQuery) => Promise<Response>): QqmusicApi["song_url"] =>
    handler,
  lyric: (handler: (query?: LyricQuery) => Promise<Response>): QqmusicApi["lyric"] => handler,
  playlist_detail: (
    handler: (query?: PlaylistDetailQuery) => Promise<Response>
  ): QqmusicApi["playlist_detail"] => handler,
  playlist_track_all: (
    handler: (query?: PlaylistTrackAllQuery) => Promise<Response>
  ): QqmusicApi["playlist_track_all"] => handler,
  artist_songs: (
    handler: (query?: ArtistSongsQuery) => Promise<Response>
  ): QqmusicApi["artist_songs"] => handler,
  login_qr_create: (
    handler: (query?: LoginQrCreateQuery) => Promise<Response>
  ): QqmusicApi["login_qr_create"] => handler,
  login_qr_check: (
    handler: (query?: LoginQrCheckQuery) => Promise<Response>
  ): QqmusicApi["login_qr_check"] => handler,
  login_status: (
    handler: (query?: LoginStatusQuery) => Promise<Response>
  ): QqmusicApi["login_status"] => handler,
  login_refresh: (
    handler: (query?: LoginRefreshQuery) => Promise<Response>
  ): QqmusicApi["login_refresh"] => handler,
};
