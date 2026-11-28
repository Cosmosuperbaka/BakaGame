import type { ToolMedia } from "../Media";
import { SONGUESSR_NO_SEARCH_RULE } from "../Policy";
import type { SongClipAudio } from "./SongClip";

/** 片段数据 → MCP `audio` 内容块。自有座位与接管页面共用这一份。 */
export const songClipMedia = (audio: SongClipAudio): ToolMedia => ({
  type: "audio",
  mimeType: audio.mimeType,
  data: Buffer.from(audio.data).toString("base64"),
});

const seconds = (ms: number): string => (Math.max(0, ms) / 1000).toFixed(1);

/** 听片段后的一句反馈：格式、实际覆盖的区间与截短原因，末尾重申不许查。 */
export const songClipFeedback = (audio: SongClipAudio, start: number, end: number): string => {
  const notes = [
    `已播放本回合片段：音频作为 audio 内容块（${audio.mimeType}）随本次结果返回，`,
    `约 ${seconds(audio.endTime - audio.startTime)} 秒，对应片段区间 ${start}–${end} 毫秒`,
  ];
  if (audio.clipped) notes.push("；片段较长，只附上了开头一段");
  else if (audio.truncated) notes.push("；音源码率较高，只附上了开头一段");
  notes.push(`。${SONGUESSR_NO_SEARCH_RULE}`);
  return notes.join("");
};
