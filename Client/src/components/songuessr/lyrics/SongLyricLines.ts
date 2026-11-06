import type { LyricLine } from "@applemusic-like-lyrics/core";
import type { SongLyricLine } from "@bakagame/shared";

/** 与服务端一致：有翻译时仅显示翻译，否则保留行级及逐字注音。 */
export function toAMLLLines(lines: SongLyricLine[]): LyricLine[] {
  return lines.map((line) => {
    const translatedLyric = line.translatedLyric?.trim() ?? "";
    return {
      startTime: line.time,
      endTime: line.endTime,
      translatedLyric,
      romanLyric: translatedLyric ? "" : (line.romanLyric ?? ""),
      isBG: Boolean(line.isBG),
      isDuet: Boolean(line.isDuet),
      words: line.words?.length
        ? line.words.map((word) => ({
            ...word,
            romanWord: translatedLyric ? "" : (word.romanWord ?? ""),
          }))
        : [{ startTime: line.time, endTime: line.endTime, word: line.text, romanWord: "" }],
    };
  });
}

/** 媒体时钟可能改变走停的全部事件：`play` 只表示请求了播放，真正走起来要看 `playing`。 */
export const MEDIA_CLOCK_EVENTS = [
  "play",
  "playing",
  "pause",
  "waiting",
  "seeking",
  "seeked",
  "canplay",
  "ended",
  "timeupdate",
] as const;

/**
 * 媒体时钟此刻是否真的在走。
 *
 * 内核的逐字遮罩是自由运行的 Web Animation，启动后不再对齐媒体：`play` 已发出但 seek 或缓冲
 * 没结束时放它走，首句遮罩就会领先声音，直到下一句才靠重新启用纠正回来。
 */
export const isMediaClockRunning = (audio: HTMLAudioElement) =>
  !audio.paused &&
  !audio.ended &&
  !audio.seeking &&
  audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
