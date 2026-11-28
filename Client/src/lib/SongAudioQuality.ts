import { isSongAudioQuality } from "@bakagame/shared/values";
import type { SongAudioQuality, SongAudioQualityPreference } from "@bakagame/shared";
import { notifyPreferencesChanged } from "@/lib/PreferenceBus";
import { localStore } from "@/lib/SafeStorage";
import { SONG_AUDIO_QUALITY_KEY } from "@/lib/Storage";

/**
 * 音质选单上的一项。`label` 是选单里的名字，`short` 是音量条上那颗小胶囊的字，`spec` 是右侧的
 * 一句规格。回合的歌来自哪个平台对猜题的人是保密的，所以名字取两家都认得的叫法：
 * 同一档两家叫法不同时，规格里补上另一家的名字。
 */
export interface SongAudioQualityOption {
  value: SongAudioQualityPreference;
  label: string;
  short: string;
  spec: string;
}

/** 立体声按从低到高排，「自动」放最前。 */
export const STEREO_QUALITY_OPTIONS: readonly SongAudioQualityOption[] = [
  { value: "auto", label: "自动", short: "自动", spec: "默认档" },
  { value: "standard", label: "标准", short: "标准", spec: "128k" },
  { value: "higher", label: "较高", short: "较高", spec: "192k" },
  { value: "exhigh", label: "极高", short: "极高", spec: "320k · HQ" },
  { value: "lossless", label: "无损", short: "无损", spec: "FLAC · SQ" },
  { value: "hires", label: "Hi-Res", short: "Hi-Res", spec: "24bit" },
  { value: "master", label: "母带", short: "母带", spec: "超清 · 臻品" },
];

/** 空间音频各档没有上下级，按两家共有的在前排。 */
export const SPATIAL_QUALITY_OPTIONS: readonly SongAudioQualityOption[] = [
  { value: "effect", label: "高清臻音", short: "臻音", spec: "QQ 臻品音质" },
  { value: "surround", label: "沉浸环绕声", short: "环绕", spec: "QQ 全景声" },
  { value: "dolby", label: "杜比全景声", short: "杜比", spec: "Dolby Atmos" },
  { value: "vivid", label: "臻音全景声", short: "全景声", spec: "Audio Vivid" },
];

const OPTIONS = new Map(
  [...STEREO_QUALITY_OPTIONS, ...SPATIAL_QUALITY_OPTIONS].map((option) => [option.value, option])
);

export const qualityOption = (value: SongAudioQualityPreference): SongAudioQualityOption =>
  OPTIONS.get(value) ?? STEREO_QUALITY_OPTIONS[0]!;

export const DEFAULT_AUDIO_QUALITY: SongAudioQualityPreference = "auto";

/** 只采用认得的存档；缺失、被改坏或来自旧版本的值一律回到「自动」。 */
export function readSavedAudioQuality(): SongAudioQualityPreference {
  const saved = localStore.get(SONG_AUDIO_QUALITY_KEY);
  return saved === "auto" || isSongAudioQuality(saved) ? saved : DEFAULT_AUDIO_QUALITY;
}

export function saveAudioQuality(value: SongAudioQualityPreference): void {
  if (localStore.get(SONG_AUDIO_QUALITY_KEY) === value) return;
  if (localStore.set(SONG_AUDIO_QUALITY_KEY, value)) notifyPreferencesChanged();
}

/**
 * 每档预期的编码，用来在请求之前判断这台设备解不解得了。网易云的沉浸环绕声与臻音全景声
 * 编码随声道类型变化，事先说不准，留空：拿到地址后按回执里的格式再判一次，播放失败也会回退。
 */
const EXPECTED_MIME: Partial<Record<SongAudioQuality, string>> = {
  standard: "audio/mpeg",
  higher: 'audio/mp4; codecs="mp4a.40.2"',
  exhigh: "audio/mpeg",
  lossless: "audio/flac",
  hires: "audio/flac",
  master: "audio/flac",
  effect: "audio/flac",
  dolby: 'audio/mp4; codecs="ec-3"',
};

/** 上游回执里的文件格式到媒体类型。认不出的格式不拦，交给播放结果判定。 */
const FORMAT_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/mp4",
  mp4: "audio/mp4",
  ogg: "audio/ogg",
  ec3: 'audio/mp4; codecs="ec-3"',
  eac3: 'audio/mp4; codecs="ec-3"',
};

/** 同一页面里解码能力不会变：每种媒体类型只问浏览器一次。 */
const playableMime = new Map<string, boolean>();

const canPlayMime = (mime: string | undefined): boolean => {
  if (!mime || typeof document === "undefined") return true;
  let playable = playableMime.get(mime);
  if (playable === undefined) {
    try {
      playable = document.createElement("audio").canPlayType(mime) !== "";
    } catch {
      playable = true;
    }
    playableMime.set(mime, playable);
  }
  return playable;
};

/** 这台设备能不能解这一档。主流浏览器都能原生解 FLAC；杜比全景声要系统带解码器，多数电脑没有。 */
export const canDecodeQuality = (quality: SongAudioQuality): boolean =>
  canPlayMime(EXPECTED_MIME[quality]);

export const canDecodeFormat = (quality: SongAudioQuality, format: string | undefined): boolean =>
  quality === "dolby" ? canDecodeQuality("dolby") : canPlayMime(format && FORMAT_MIME[format]);
