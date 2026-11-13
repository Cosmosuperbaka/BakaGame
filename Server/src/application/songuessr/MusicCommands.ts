import { AppError } from "../../domain/Errors";
import type { ConnectionRecord } from "../../shared/Index";
import { resolveAnimeMatchedSongs } from "./AnimeResolution";
import type { SonGuessrContext } from "./Context";
import { musicSearchOptions, withAggregatedAccounts, withSongAccount } from "./MusicAccounts";
import { parsePlaylistId } from "./PlaylistId";
import type { SongCommandAt } from "./RoomAccess";

/**
 * 客户端可直接触发的音乐类命令的统一前置闸门：正式成员或本轮出题人 + 按连接配额。
 *
 * 这两条此前都缺：命令只要求「人在房间里」，旁观者同样能发起搜索；
 * 且完全没有调用配额，见 `musicLimiter` 的注释。
 * 配额之外放行当前待出题人：房主可以把旁观者指定为出题人（见 `submitterCandidates`），
 * 而选歌一定要用搜索与歌单，按「正式成员」拦会把这条合法路径堵死。
 *
 * 它要扣配额，不是无副作用的纯判定，所以不放进命令表的守卫列表，由各处理函数在开头调用：
 * 被前面守卫拒绝的请求不消耗配额，记账时机与改表之前一致。
 */
export const requireMusicQuota = (ctx: SonGuessrContext, at: SongCommandAt) => {
  const { room, connection, seat: player } = at;
  const maySearchMusic =
    player.membership === "active" || room.pendingSubmitterPlayerId === player.id;
  if (!maySearchMusic) {
    throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能进行音乐操作");
  }
  if (!ctx.musicLimiter.allow(connection.id, ctx.now())) {
    throw new AppError("RATE_LIMITED", "音乐请求过于频繁，请稍后再试");
  }
};

export const searchMusic = async (ctx: SonGuessrContext, at: SongCommandAt, keyword: string) => {
  const { room } = at;
  requireMusicQuota(ctx, at);
  // 先算可播标注再取号：取号会把在途数抬起来，反着算会把刚好打满上限的会员号误判成不可用。
  const options = musicSearchOptions(ctx, room);
  return {
    results: await withAggregatedAccounts(ctx, room, (cookie) =>
      ctx.options.musicProvider.search(keyword, undefined, cookie, options)
    ),
  };
};

export const resolvePlaylist = async (ctx: SonGuessrContext, at: SongCommandAt, value: string) => {
  const { room } = at;
  requireMusicQuota(ctx, at);
  const playlistId = parsePlaylistId(value);
  const provider = ctx.options.musicProvider;
  const resolve = provider.getPlaylistSongs?.bind(provider);
  if (!resolve) throw new AppError("MUSIC_API_UNAVAILABLE", "当前音乐 API 不支持读取歌单");
  const result = await withSongAccount(ctx, room, playlistId, (cookie) =>
    resolve(playlistId, cookie)
  );
  return { playlist: result.info };
};

export const searchArtists = async (ctx: SonGuessrContext, at: SongCommandAt, keyword: string) => {
  const { room } = at;
  requireMusicQuota(ctx, at);
  const provider = ctx.options.musicProvider;
  const search = provider.searchArtists?.bind(provider);
  if (!search) throw new AppError("MUSIC_API_UNAVAILABLE", "当前音乐 API 不支持搜索歌手");
  // 与歌曲检索同口径：先按池内能力算偏好，再取号，避免在途数影响会员判定。
  const options = musicSearchOptions(ctx, room);
  return {
    results: await withAggregatedAccounts(ctx, room, (cookie) =>
      search(keyword, 20, cookie, options)
    ),
  };
};

export const searchBangumi = async (ctx: SonGuessrContext, keyword: string) => {
  const provider = ctx.options.bangumiProvider;
  if (!provider) throw new AppError("BANGUMI_API_UNAVAILABLE", "当前未配置 Bangumi 接口");
  return { results: await provider.searchSubjects(keyword, 20) };
};

/**
 * 番剧封面补图：只读数据集不含图片，搜索列表缺的封面滚进视口时才来要一次。
 * 命中回填缓存就不回源，所以反复搜索同一部番剧不会再打上游。
 */
export const getSubjectImage = async (ctx: SonGuessrContext, subjectId: string) => {
  const provider = ctx.options.bangumiProvider;
  if (!provider) throw new AppError("BANGUMI_API_UNAVAILABLE", "当前未配置 Bangumi 接口");
  return { imageUrl: await provider.resolveSubjectImage(subjectId) };
};

/** 取回番剧信息后才解析歌曲：解析里会按连接重新确认席位，等待期间离房的人拿不到结果。 */
export const getAnimeSongs = async (
  ctx: SonGuessrContext,
  connection: ConnectionRecord,
  subjectId: string
) => {
  const provider = ctx.options.bangumiProvider;
  if (!provider) throw new AppError("BANGUMI_API_UNAVAILABLE", "当前未配置 Bangumi 接口");
  const anime = await provider.getSubject(subjectId);
  const results = await resolveAnimeMatchedSongs(ctx, anime, connection);
  return { results };
};
