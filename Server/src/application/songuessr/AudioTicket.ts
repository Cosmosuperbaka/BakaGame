import { timingSafeEqual } from "node:crypto";
import type { SonGuessrRoundRecord } from "./Records";

/**
 * 站内播放地址的路径前缀。上游播放地址会带歌曲标识与签名，不能下发给客户端；
 * 客户端拿到的是这条路径加房号与票据，请求它由服务端回跳转，音频本身不经过服务端。
 */
export const SONG_AUDIO_ROUTE_PREFIX = "/api/songuessr/audio";

/** 24 字节随机数，base64url 编码后 32 个字符，远高于 128 位下限。 */
const AUDIO_TICKET_BYTES = 24;

/**
 * 回合装题时签发的不透明票据。必须取密码学随机数：测试里的 `ctx.random` 是可预测的种子源，
 * 票据又是唯一的访问凭据，不能从房号、歌曲或时间推出来。
 */
export const issueAudioTicket = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(AUDIO_TICKET_BYTES))).toString("base64url");

/**
 * 回合的站内播放地址。`publicBaseUrl` 是服务端对外基址：旧壳把快照里的地址原样交给播放器，
 * 相对路径会被解析到壳自己的来源上，所以组合根配了基址就必须下发绝对地址。
 */
export const audioTicketUrl = (
  publicBaseUrl: string | undefined,
  roomId: string,
  round: Pick<SonGuessrRoundRecord, "audioTicket">
): string =>
  `${(publicBaseUrl ?? "").replace(/\/+$/, "")}${SONG_AUDIO_ROUTE_PREFIX}/${encodeURIComponent(roomId)}/${round.audioTicket}`;

/** 常量时间比较：长度本身不是秘密（票据定长），不等长直接判否。 */
export const isAudioTicketMatch = (presented: string, actual: string): boolean => {
  const left = Buffer.from(presented);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
};
