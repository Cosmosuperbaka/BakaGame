import type { SongClipPreview } from "@bakagame/shared";
import { SONG_CLIP_MAX_MS, SONG_CLIP_MIN_MS } from "@bakagame/shared";

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** 毫秒转 `分:秒.十分位`，时间轴与歌词行共用一种读数。 */
export function formatClipTime(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const minutes = Math.floor(safe / 60_000);
  const seconds = (safe % 60_000) / 1_000;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/**
 * 歌曲在编辑器里的时间轴总长。
 *
 * 上游偶尔不给时长：此时以最后一句歌词的结束时间再留一段余量兜底，至少让时间轴可用。
 */
export function resolveClipDuration(song: SongClipPreview): number {
  const lastLyricEnd = song.lyrics.reduce((max, line) => Math.max(max, line.endTime), 0);
  const fallback = Math.max(lastLyricEnd + 30_000, 60_000);
  const raw = song.durationMs && song.durationMs > 0 ? song.durationMs : fallback;
  return Math.max(raw, SONG_CLIP_MIN_MS);
}

/**
 * 把任意起止收进可提交范围：负值归零、至少 3 秒、至多 30 秒、终点不越过歌曲时长。
 *
 * `moved` 决定超长时牺牲哪一端：拖起点就固定起点截终点，拖终点就固定终点回推起点，
 * 两个手柄都不会因为对方越界而跳走。
 */
export function clampClipRange(
  start: number,
  end: number,
  domain: number,
  moved: "start" | "end"
): [number, number] {
  const maxStart = Math.max(0, domain - SONG_CLIP_MIN_MS);
  let nextStart = clamp(Math.round(start), 0, maxStart);
  let nextEnd = clamp(Math.round(end), nextStart + SONG_CLIP_MIN_MS, domain);
  if (nextEnd - nextStart > SONG_CLIP_MAX_MS) {
    if (moved === "start") nextEnd = nextStart + SONG_CLIP_MAX_MS;
    else nextStart = nextEnd - SONG_CLIP_MAX_MS;
  }
  return [nextStart, nextEnd];
}

/**
 * 初始片段：优先副歌开头，其次第一句歌词，时长取副歌长度或 15 秒，并按 3–30 秒约束收口。
 * 没有歌词的纯音乐仍可编辑，只是歌词区给一条说明。
 */
export function defaultClipRange(song: SongClipPreview): [number, number] {
  const domain = resolveClipDuration(song);
  const chorusStart = song.chorus?.startTime;
  const firstLine = song.lyrics[0]?.time;
  const rawStart =
    chorusStart !== undefined && Number.isFinite(chorusStart) && chorusStart >= 0
      ? chorusStart
      : (firstLine ?? 0);
  const start = clamp(Math.round(rawStart), 0, domain - SONG_CLIP_MIN_MS);
  const chorusEnd = song.chorus?.endTime;
  const rawEnd = chorusEnd !== undefined && chorusEnd > start ? chorusEnd : start + 15_000;
  // 起点是「副歌从哪开始」，超长时截终点而不是回推起点。
  return [...clampClipRange(start, rawEnd, domain, "start")];
}
