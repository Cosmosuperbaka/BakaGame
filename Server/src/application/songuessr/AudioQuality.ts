import { AppError } from "../../domain/Errors";
import type { SongAudioVariant } from "../../infrastructure/music/AudioQuality";
import type { SonGuessrAudioQualityAck, SongAudioQuality } from "../../shared/Index";
import { audioTicketUrl } from "./AudioTicket";
import type { SonGuessrContext } from "./Context";
import { withSongAccount } from "./MusicPool";
import type { SonGuessrRoomRecord, SonGuessrRoundRecord } from "./Records";
import type { SongCommandAt } from "./RoomAccess";

/**
 * 玩家自选的播放音质。
 *
 * 装题时服务端只取一档默认地址（公共快照里的站内地址跳转到它）；玩家选了别的档，客户端
 * 用本回合号来要这一档，服务端回一条带 `q` 参数的站内地址。音质是每个人自己的事：
 * 不改公共快照与私有态，也不影响别人听到的那一档。
 *
 * 取到的各档挂在回合对象上（WeakMap）：回合换了自然作废，不进房间记录也不随快照落盘
 * （上游地址会过期，恢复后客户端重新要）。同一档在一个回合里只向上游取一次、全房共用，
 * 拿不到也记下，本回合不再为它打上游。
 */
interface RoundAudioVariants {
  /** 按请求的档位记结果；null 表示这首歌在本房拿不到这一档（含退路）。 */
  readonly byRequest: Map<SongAudioQuality, SongAudioVariant | null>;
  /** 同一档的并发请求合并成一次上游调用。 */
  readonly inFlight: Map<SongAudioQuality, Promise<SongAudioVariant | null>>;
  /**
   * 按实际档位记：站内地址按它跳转（请求无损、实际拿到极高时，跳转键是极高）；
   * 之后有人直接要这一档也直接复用，不再打上游。
   */
  readonly byActual: Map<SongAudioQuality, SongAudioVariant>;
}

const roundVariants = new WeakMap<SonGuessrRoundRecord, RoundAudioVariants>();

const variantsOf = (round: SonGuessrRoundRecord): RoundAudioVariants => {
  let variants = roundVariants.get(round);
  if (!variants) {
    variants = { byRequest: new Map(), inFlight: new Map(), byActual: new Map() };
    roundVariants.set(round, variants);
  }
  return variants;
};

/** 站内播放地址跳转用：本回合某一档的上游地址，没取过就是 undefined，由调用方回到默认地址。 */
export const roundAudioVariantUrl = (
  round: SonGuessrRoundRecord,
  quality: SongAudioQuality
): string | undefined => roundVariants.get(round)?.byActual.get(quality)?.url;

/** 回合的站内播放地址加上档位参数。档位只是跳转选择，凭据仍是票据本身。 */
const variantTicketUrl = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  round: SonGuessrRoundRecord,
  quality: SongAudioQuality
) => `${audioTicketUrl(ctx.options.publicBaseUrl, room.id, round)}?q=${quality}`;

const loadVariant = async (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  round: SonGuessrRoundRecord,
  quality: SongAudioQuality
): Promise<SongAudioVariant | null> => {
  const provider = ctx.options.musicProvider;
  const load = provider.getSongAudioVariant?.bind(provider);
  const variants = variantsOf(round);
  if (!load) {
    variants.byRequest.set(quality, null);
    return null;
  }
  const songId = round.song.id;
  try {
    const variant = await withSongAccount(
      ctx,
      room,
      songId,
      (cookie) => load(songId, quality, cookie),
      {
        requireVip: songId.startsWith("qq:") && round.song.requiresVip === true,
        // 高音质档要看账号权限：池里有更高会员档的号就先用它，免得被上游降档。
        preferHigherTier: true,
      }
    );
    variants.byRequest.set(quality, variant);
    variants.byActual.set(variant.quality, variant);
    return variant;
  } catch (error) {
    // 「这首歌没有这一档」本回合记住；限流、超时这类瞬态失败不记，原样报给客户端，
    // 客户端先用默认地址播，下一回合再要。
    if (error instanceof AppError && error.code === "SONG_UNAVAILABLE") {
      variants.byRequest.set(quality, null);
      return null;
    }
    throw error;
  }
};

export async function audioQuality(
  ctx: SonGuessrContext,
  at: SongCommandAt,
  roundNumber: number,
  quality: SongAudioQuality
): Promise<SonGuessrAudioQualityAck> {
  const { room, connection } = at;
  const round = room.currentRound;
  // 猜题与结算放的是同一个回合的音频：两段都能换档。
  if (
    !round ||
    round.number !== roundNumber ||
    (room.phase !== "playing" && room.phase !== "roundResult")
  ) {
    return { ignored: true };
  }
  const variants = variantsOf(round);
  // 本回合要过这一档就用记下的结果（null 是「拿不到」，不再打上游）；没要过但别的档降档时拿到过它，也直接用。
  const requested = variants.byRequest.get(quality);
  let variant: SongAudioVariant | null | undefined =
    requested !== undefined ? requested : variants.byActual.get(quality);
  if (variant === undefined) {
    let pending = variants.inFlight.get(quality);
    if (!pending) {
      // 只有真要打上游时才扣额度：命中本回合已有的结果、搭上别人在途的请求都不花。
      if (!ctx.musicLimiter.allow(connection.id, ctx.now())) {
        throw new AppError("RATE_LIMITED", "音乐请求过于频繁，请稍后再试");
      }
      pending = loadVariant(ctx, room, round, quality);
      variants.inFlight.set(quality, pending);
      const settle = () => {
        variants.inFlight.delete(quality);
      };
      pending.then(settle, settle);
    }
    variant = await pending;
  }
  if (room.currentRound !== round) return { ignored: true };
  if (!variant) return { unavailable: true };
  return {
    quality: variant.quality,
    audioUrl: variantTicketUrl(ctx, room, round, variant.quality),
    ...(variant.format ? { format: variant.format } : {}),
  };
}
