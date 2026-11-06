import { useCallback, useEffect, useRef, useState } from "react";
import { clipVolume } from "@/lib/ClipFade";

export interface ClipPreviewAudioOptions {
  range: readonly [number, number];
  /** 猜歌播放音量：来自房间顶栏的同一份设置，这里不另存一份。 */
  volume: number;
}

/**
 * 片段编辑器的试听。音频只在选区内走：从起点起播、到终点停下回到起点；
 * 音量走与正式播放相同的「设置 × 淡入淡出包络」，顶栏调音量时试听中立即生效。
 */
export function useClipPreviewAudio({ range, volume }: ClipPreviewAudioOptions) {
  const [startTime, endTime] = range;
  const audioRef = useRef<HTMLAudioElement>(null);
  const volumeRef = useRef(volume);
  const rangeRef = useRef(range);
  const [playing, setPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(startTime);
  const [failed, setFailed] = useState(false);

  const applyVolume = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const [start, end] = rangeRef.current;
    audio.volume = clipVolume(volumeRef.current, audio.currentTime, start / 1_000, end / 1_000);
  }, []);

  const rewind = useCallback(() => {
    const audio = audioRef.current;
    const start = rangeRef.current[0];
    if (audio) audio.currentTime = start / 1_000;
    setCurrentTimeMs(start);
  }, []);

  const stopAtEnd = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || audio.currentTime * 1_000 < rangeRef.current[1]) return false;
    audio.pause();
    rewind();
    setPlaying(false);
    return true;
  }, [rewind]);

  useEffect(() => {
    volumeRef.current = volume;
    rangeRef.current = range;
    applyVolume();
  }, [applyVolume, range, volume]);

  // 选区移动后播放头落在外面时回到新起点。
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const ms = audio.currentTime * 1_000;
    if (ms < startTime || ms >= endTime) rewind();
  }, [endTime, rewind, startTime]);

  // timeupdate 约四次每秒，跟不上淡入淡出：包络与终点判定逐帧走。
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      applyVolume();
      if (!stopAtEnd()) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [applyVolume, playing, stopAtEnd]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => audio?.pause();
  }, []);

  const seek = useCallback(
    (ms: number) => {
      const target = Math.round(ms);
      const audio = audioRef.current;
      if (audio) audio.currentTime = target / 1_000;
      setCurrentTimeMs(target);
      applyVolume();
    },
    [applyVolume]
  );

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      setPlaying(false);
      return;
    }
    const [start, end] = rangeRef.current;
    const ms = audio.currentTime * 1_000;
    if (ms < start || ms >= end) rewind();
    // 起播前先落到包络上：等 play 事件再算会漏出一两帧满音量的爆音。
    applyVolume();
    try {
      await audio.play();
      setPlaying(true);
    } catch {
      setPlaying(false);
    }
  }, [applyVolume, rewind]);

  const onTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const ms = audio.currentTime * 1_000;
    if (ms < rangeRef.current[0] - 250) {
      rewind();
      return;
    }
    if (!stopAtEnd()) setCurrentTimeMs(ms);
  }, [rewind, stopAtEnd]);

  const onEnded = useCallback(() => {
    setPlaying(false);
    rewind();
  }, [rewind]);

  return {
    audioRef,
    playing,
    currentTimeMs,
    failed,
    seek,
    togglePlay,
    audioEvents: {
      onPlay: () => setPlaying(true),
      onPause: () => setPlaying(false),
      onTimeUpdate,
      onEnded,
      onError: () => setFailed(true),
    },
  };
}
