/**
 * 片段的音量包络（0–1）：起点淡入、终点淡出，避免爆音与突然掐断。
 * 正式播放与出题试听共用这一条，出题人听到的就是全房会听到的。
 */
export function clipFadeFactor(
  currentSeconds: number,
  startSeconds: number,
  endSeconds?: number
): number {
  if (endSeconds === undefined) return 1;
  const clipDuration = Math.max(0.1, endSeconds - startSeconds);
  const fadeDuration = Math.min(1, clipDuration / 2);
  const elapsed = currentSeconds - startSeconds;
  const remaining = endSeconds - currentSeconds;
  if (elapsed <= 0 || remaining <= 0) return 0;
  const fadeIn = Math.min(1, elapsed / fadeDuration);
  const fadeOut = Math.min(1, remaining / fadeDuration);
  return Math.min(fadeIn, fadeOut);
}

/** 音量设置乘上包络后的实际音量。 */
export const clipVolume = (
  volume: number,
  currentSeconds: number,
  startSeconds: number,
  endSeconds?: number
) => Math.max(0, Math.min(1, volume * clipFadeFactor(currentSeconds, startSeconds, endSeconds)));
