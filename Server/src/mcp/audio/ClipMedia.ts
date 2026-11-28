import type { ToolMedia } from "../Media";
import { SONGUESSR_NO_SEARCH_RULE } from "../Policy";
import type { SongClipAudio } from "./SongClip";

/**
 * 一次工具结果里附带的音频总量上限（base64 字符数），刚好容得下一段满额片段：
 * 单段片段有上限，但一次 `ui_run` / `page_act` 可以连点多次播放，不设总量就能叠出几十 MB。
 */
export const MAX_RESULT_MEDIA_CHARS = 6 * 1024 * 1024;

/** 缓存命中时片段是同一个对象：编码结果跟着它走，重播不再重复转 base64。 */
const ENCODED = new WeakMap<SongClipAudio, ToolMedia>();

const mediaOf = (audio: SongClipAudio): ToolMedia => {
  let media = ENCODED.get(audio);
  if (!media) {
    media = {
      type: "audio",
      mimeType: audio.mimeType,
      data: Buffer.from(audio.data).toString("base64"),
    };
    ENCODED.set(audio, media);
  }
  return media;
};

const seconds = (ms: number): string => (Math.max(0, ms) / 1000).toFixed(1);

type Attached = "added" | "repeated" | "over-budget";

/** 同样的片段在本次结果里已经有了就不再附带一份；加上会超出总量就不附带。 */
const attach = (list: ToolMedia[], media: ToolMedia): Attached => {
  if (list.some((existing) => existing === media || existing.data === media.data))
    return "repeated";
  const used = list.reduce((sum, existing) => sum + existing.data.length, 0);
  if (used + media.data.length > MAX_RESULT_MEDIA_CHARS) return "over-budget";
  list.push(media);
  return "added";
};

/**
 * 把听到的片段挂进本次结果的媒体列表，返回给 Agent 的一句反馈：格式、实际覆盖的区间、
 * 截短原因与是否附带，末尾重申不许查。自有座位与接管页面共用这一份。
 */
export const attachSongClip = (
  list: ToolMedia[],
  audio: SongClipAudio,
  start: number,
  end: number
): string => {
  const outcome = attach(list, mediaOf(audio));
  if (outcome === "over-budget")
    return `已播放本回合片段，但本次结果附带的音频已到上限，这段没有附上；单独再点一次播放即可收到。${SONGUESSR_NO_SEARCH_RULE}`;
  const notes = [
    outcome === "repeated"
      ? `已重播本回合片段：与本次结果里已附带的那段 audio 内容块相同，不再重复附带，`
      : `已播放本回合片段：音频作为 audio 内容块（${audio.mimeType}）随本次结果返回，`,
    `约 ${seconds(audio.endTime - audio.startTime)} 秒，对应片段区间 ${start}–${end} 毫秒`,
  ];
  if (audio.clipped) notes.push("；片段较长，只附上了开头一段");
  else if (audio.truncated) notes.push("；音源码率较高，只附上了开头一段");
  notes.push(`。${SONGUESSR_NO_SEARCH_RULE}`);
  return notes.join("");
};
