import { Elysia } from "elysia";
import { SONG_AUDIO_ROUTE_PREFIX } from "../../application/songuessr/AudioTicket";
import {
  SONG_AUDIO_REDIRECT_GLOBAL_MAX_PER_WINDOW,
  SONG_AUDIO_REDIRECT_IP_MAX_PER_WINDOW,
  SONG_AUDIO_REDIRECT_WINDOW_MS,
} from "../../config/Constants";
import { ThreeTierRateLimiter } from "../../infrastructure/RateLimiter";
import { requestContext } from "../RequestContext";
import { httpError, rateLimitHeaders, traceIdOf } from "../HttpErrorEnvelope";

/** 路由只需要服务的这一个能力：按房号与票据取当前回合保存的上游地址。 */
export interface SongAudioSource {
  resolveAudioRedirect(roomId: string, ticket: string): string | undefined;
}

export interface SongAudioRoutesOptions {
  song: SongAudioSource;
  /** 缺省按常量建一份；测试注入小额度验证限流。 */
  rateLimiter?: ThreeTierRateLimiter;
}

/**
 * 响应在任何情况下都不许被缓存（浏览器与共享缓存都不存）：上游地址会过期，
 * 服务端刷新之后客户端重新请求同一个票据地址才能拿到新地址；404 也不缓存，
 * 免得边缘把「票据无效」存下来。
 */
const NO_STORE = "no-store";

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/**
 * 猜歌播放地址的站内入口：`GET|HEAD /api/songuessr/audio/<房号>/<票据>`。
 *
 * 公共快照里不再下发上游播放地址（上游地址带歌曲标识与签名，等于把答案发给全房）。
 * 客户端拿到的是这条站内地址，请求它时服务端只回 302，浏览器自己去上游取音频：
 * 音频数据不经过服务端，源站带宽不承担听众流量。
 *
 * - 票据即凭证，不要求登录态：媒体元素在壳里是跨源请求，带不带凭据不可靠。
 * - 房间不在、没有进行中的回合、票据不符三种情况回完全相同的 404，探测者区分不出。
 * - 跳转目标只取自服务端保存的上游地址，不读请求里的任何参数，不构成开放跳转。
 * - 本路由不发任何出站请求；302 带 `Referrer-Policy: no-referrer`（全局安全头），
 *   浏览器据此跳转后不会把本站地址作为来源带给上游。
 * - 残余风险：打开浏览器网络面板的人仍能看到跳转目标。
 */
export const songAudioRoutes = ({ song, rateLimiter }: SongAudioRoutesOptions) => {
  const limiter =
    rateLimiter ??
    new ThreeTierRateLimiter({
      windowMs: SONG_AUDIO_REDIRECT_WINDOW_MS,
      ipMaxRequests: SONG_AUDIO_REDIRECT_IP_MAX_PER_WINDOW,
      globalMaxRequests: SONG_AUDIO_REDIRECT_GLOBAL_MAX_PER_WINDOW,
    });

  return new Elysia({ name: "song-audio" }).use(requestContext).get(
    `${SONG_AUDIO_ROUTE_PREFIX}/:roomId/:ticket`,
    ({ params, peerIp, clientIp, set }) => {
      set.headers["cache-control"] = NO_STORE;
      const traceId = traceIdOf(set.headers);
      // 限流先于查表：枚举票据的每一次尝试都要先过额度，且被拒不暴露任何房间信息。
      const verdict = limiter.consume(clientIp, peerIp ?? "unknown");
      Object.assign(set.headers, rateLimitHeaders(verdict));
      if (!verdict.allowed) {
        set.status = 429;
        return httpError("RATE_LIMITED", "播放请求过于频繁，请稍后重试", traceId);
      }

      const target = song.resolveAudioRedirect(params.roomId, params.ticket);
      if (!target || !isHttpUrl(target)) {
        set.status = 404;
        return httpError("AUDIO_NOT_FOUND", "播放地址不存在或已失效", traceId);
      }
      return new Response(null, { status: 302, headers: { location: target } });
    },
    {
      detail: {
        tags: ["System"],
        summary: "猜歌站内播放地址（跳转到上游音频）",
        description:
          "票据地址即凭证：房间在且票据对应当前回合时回 302 跳转到上游音频，否则一律 404。音频数据不经过本服务，响应不可缓存。",
      },
    }
  );
};
