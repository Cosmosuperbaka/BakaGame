import { clipVolume } from "@/lib/ClipFade";

export interface ClipEnvelope {
  /** 设置音量乘上片段包络，按给定播放头计算，不写回元素。 */
  volumeAt(currentSeconds: number): number;
  /** 按元素当前播放头立即写一次包络音量。 */
  apply(): void;
  /**
   * 起逐帧循环，帧体返回 false 时不再续排。终点判定与播放门槛留在调用方：
   * 正式播放在 timeupdate 里判终点，试听逐帧判，两种粒度在这里不统一。
   */
  start(onFrame: () => boolean): void;
  /** 只取消还没执行的帧；停播后音量写不写回、写多少由调用方决定。 */
  stop(): void;
}

/** 片段播放的音量包络循环：正式播放与出题试听共用，不依赖 React。 */
export function createClipEnvelope(
  getAudio: () => HTMLAudioElement | null,
  getVolume: () => number,
  getRange: () => { startSeconds: number; endSeconds?: number }
): ClipEnvelope {
  let frameId: number | null = null;
  const volumeAt = (currentSeconds: number) => {
    const { startSeconds, endSeconds } = getRange();
    return clipVolume(getVolume(), currentSeconds, startSeconds, endSeconds);
  };
  const apply = () => {
    const audio = getAudio();
    if (audio) audio.volume = volumeAt(audio.currentTime);
  };
  return {
    volumeAt,
    apply,
    start(onFrame) {
      if (frameId !== null) cancelAnimationFrame(frameId);
      const tick = () => {
        if (onFrame()) frameId = requestAnimationFrame(tick);
      };
      frameId = requestAnimationFrame(tick);
    },
    stop() {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
    },
  };
}
