import type { SongAudioQuality } from "../../shared/Index";

/** 指定音质取到的播放地址。实际档位可能低于请求的档位：曲目没有那一档或账号没有权限时上游会降档。 */
export interface SongAudioVariant {
  url: string;
  quality: SongAudioQuality;
  /** 上游报的文件格式（小写，如 `flac`、`mp3`、`m4a`）；没报时缺席，交给客户端试播判定。 */
  format?: string;
}

/**
 * 偏好档拿不到时依次尝试的档位（含自己），从近到远，最多三档。
 *
 * 立体声高解析档沿「母带 → Hi-Res → 无损」往下退；空间音频各档之间没有上下级，拿不到就退回无损。
 * 只退到极高为止：再往下就不如回合装题时已经取好的默认那一档，交给客户端回退到默认地址，
 * 不为一档更差的音质多打上游。标准与较高是玩家为省流量主动选的，按自己那一档取。
 */
export const AUDIO_QUALITY_ATTEMPTS: Record<SongAudioQuality, readonly SongAudioQuality[]> = {
  standard: ["standard"],
  higher: ["higher", "standard"],
  exhigh: ["exhigh"],
  lossless: ["lossless", "exhigh"],
  hires: ["hires", "lossless", "exhigh"],
  effect: ["effect", "lossless", "exhigh"],
  surround: ["surround", "lossless", "exhigh"],
  dolby: ["dolby", "lossless", "exhigh"],
  vivid: ["vivid", "lossless", "exhigh"],
  master: ["master", "hires", "lossless"],
};

/** 上游的文件格式字段归一成小写短名；空串与非字符串都按「没报」处理。 */
export const readAudioFormat = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const format = value.trim().toLowerCase().replace(/^\./, "");
  return /^[a-z0-9-]{1,12}$/.test(format) ? format : undefined;
};
