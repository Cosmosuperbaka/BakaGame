import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { createRef, forwardRef } from "react";
import type { SongLyricLine } from "@/types";

const capturedProps: Array<{ currentTime?: number; playing?: boolean }> = [];

vi.mock("@applemusic-like-lyrics/react", () => {
  return {
    LyricPlayer: forwardRef(function MockLyricPlayer(
      props: { currentTime?: number; playing?: boolean },
      ref,
    ) {
      void ref;
      capturedProps.push({ currentTime: props.currentTime, playing: props.playing });
      return <div data-testid="mock-lyric-player" data-current-time={props.currentTime} />;
    }),
  };
});

import { SongLyricPlayer } from "./SongLyricPlayer";

describe("SongLyricPlayer 时间轴与前奏缓冲精确对齐", () => {
  it("音频在首句前 1 秒前奏缓冲播放时，currentTime 如实反映 34000 而非错误锁定在 35000", () => {
    capturedProps.length = 0;
    const lines: SongLyricLine[] = [
      { time: 35000, endTime: 40000, text: "副歌第一句" },
      { time: 40000, endTime: 45000, text: "副歌第二句" },
    ];

    const mockAudio = document.createElement("audio");
    mockAudio.currentTime = 34; // 34.000s，比首句 35.000s 提前 1 秒缓冲
    Object.defineProperty(mockAudio, "paused", { value: false, writable: true });
    Object.defineProperty(mockAudio, "ended", { value: false, writable: true });

    const audioRef = createRef<HTMLAudioElement | null>();
    audioRef.current = mockAudio;

    render(
      <SongLyricPlayer
        lines={lines}
        audioRef={audioRef}
        audioPlaybackState="playing"
        audioStatus="ready"
      />,
    );

    const latest = capturedProps.at(-1);
    expect(latest).toBeDefined();
    // 关键断言：时间轴如实下发 34000，第一句歌词不会提前 1 秒播放
    expect(latest?.currentTime).toBe(34000);
    expect(latest?.playing).toBe(true);
  });

  it("音频未播放或暂停时，时间轴安全锚定在首句时间 35000 且 playing 为 false 避免塌陷", () => {
    capturedProps.length = 0;
    const lines: SongLyricLine[] = [
      { time: 35000, endTime: 40000, text: "副歌第一句" },
      { time: 40000, endTime: 45000, text: "副歌第二句" },
    ];

    const mockAudio = document.createElement("audio");
    mockAudio.currentTime = 0;
    Object.defineProperty(mockAudio, "paused", { value: true, writable: true });

    const audioRef = createRef<HTMLAudioElement | null>();
    audioRef.current = mockAudio;

    render(
      <SongLyricPlayer
        lines={lines}
        audioRef={audioRef}
        audioPlaybackState="idle"
        audioStatus="ready"
      />,
    );

    const latest = capturedProps.at(-1);
    expect(latest).toBeDefined();
    expect(latest?.currentTime).toBe(35000);
    expect(latest?.playing).toBe(false);
  });

  it("切歌瞬间音频时间异常滞留在 0 秒（远早于首句 3 秒以上）时，安全回退到首句时间", () => {
    capturedProps.length = 0;
    const lines: SongLyricLine[] = [
      { time: 35000, endTime: 40000, text: "副歌第一句" },
    ];

    const mockAudio = document.createElement("audio");
    mockAudio.currentTime = 0; // 0 秒，比首句 35 秒早了 35 秒，显然尚未 seek 到选区
    Object.defineProperty(mockAudio, "paused", { value: false, writable: true });
    Object.defineProperty(mockAudio, "ended", { value: false, writable: true });

    const audioRef = createRef<HTMLAudioElement | null>();
    audioRef.current = mockAudio;

    render(
      <SongLyricPlayer
        lines={lines}
        audioRef={audioRef}
        audioPlaybackState="playing"
        audioStatus="ready"
      />,
    );

    const latest = capturedProps.at(-1);
    expect(latest).toBeDefined();
    // 尚未 seek 好时安全锚定在首句，不闪烁到歌曲开头
    expect(latest?.currentTime).toBe(35000);
  });
});
