import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { LyricLine } from "@applemusic-like-lyrics/core";
import type { SongLyricLine } from "@/types";

const players = vi.hoisted(() => [] as Array<{
  lines: LyricLine[]; time: number; playing: boolean; sourceUpdates: number; disposed: boolean; updates: number[];
}>);

vi.mock("@applemusic-like-lyrics/core", () => ({
  LyricPlayer: class {
    lines: LyricLine[] = [];
    time = 0;
    playing = false;
    disposed = false;
    sourceUpdates = 0;
    updates: number[] = [];
    currentLyricGroups = [];
    lyricGroupSize = new WeakMap();
    size = [0, 0];
    element = document.createElement("div");
    constructor() { players.push(this); }
    getElement() { return this.element; }
    setOverscanPx() {}
    setEnableScale() {}
    setEnableBlur() {}
    setAlignAnchor() {}
    setAlignPosition() {}
    setCurrentTime(time: number) { this.time = time; }
    setLyricLines(lines: LyricLine[], time: number) {
      this.lines = lines;
      this.time = time;
      this.sourceUpdates++;
    }
    getIsPlaying() { return this.playing; }
    pause() { this.playing = false; }
    resume() { this.playing = true; }
    calcLayout() { return Promise.resolve(); }
    update(delta = 0) { this.updates.push(delta); }
    dispose() { this.disposed = true; this.element.remove(); }
  },
}));

import { SongLyricScene } from "./SongLyricScene";
import { SongLyricPlayer } from "./SongLyricPlayer";

const lines: SongLyricLine[] = [
  { time: 35000, endTime: 39000, text: "夜空に浮かぶ星たち", translatedLyric: "浮现在夜空中的群星" },
  { time: 39000, endTime: 43000, text: "いつか届くはずの想い" },
];

beforeEach(() => {
  players.length = 0;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});

describe("歌词数据、媒体事件与组件生命周期", () => {
  it("空歌词显示纯音乐提示，后续加载有词曲目可正常初始化", () => {
    const { rerender } = render(<SongLyricPlayer lines={[]} />);
    expect(screen.getByText("当前歌曲为纯音乐或无歌词")).toBeInTheDocument();
    rerender(<SongLyricPlayer lines={lines} />);
    expect(screen.queryByText("当前歌曲为纯音乐或无歌词")).toBeNull();
    expect(screen.getByText(/浮现在夜空中的群星/)).toBeInTheDocument();
    expect(players.at(-1)!.lines[0].words[0]).toEqual({
      startTime: 35000, endTime: 39000, word: lines[0].text, romanWord: "",
    });
  });

  it("快照复制不重建歌词，但相同词数的逐字文本、时间与注音变化必须更新", () => {
    const source = [{ ...lines[0], translatedLyric: "", words: [
      { startTime: 35000, endTime: 39000, word: "夜空", romanWord: "yo zo ra" },
    ] }];
    const { rerender } = render(<SongLyricPlayer lines={source} />);
    const player = players.at(-1)!;
    rerender(<SongLyricPlayer lines={structuredClone(source)} audioStatus="ready" />);
    expect(player.sourceUpdates).toBe(1);
    const changed = [{ ...source[0], words: [
      { startTime: 35500, endTime: 39000, word: "星空", romanWord: "ho shi zo ra" },
    ] }];
    rerender(<SongLyricPlayer lines={changed} />);
    expect(player.lines[0].words[0]).toEqual(changed[0].words[0]);
    expect(player.sourceUpdates).toBe(2);
  });

  it("翻译优先屏蔽全部注音，无翻译时保留行级和逐字注音", () => {
    const source = [{ ...lines[0], romanLyric: "yo zo ra", words: [
      { startTime: 35000, endTime: 39000, word: "夜空", romanWord: "yo zo ra" },
    ] }];
    const { rerender } = render(<SongLyricPlayer lines={source} />);
    const player = players.at(-1)!;
    expect(player.lines[0].translatedLyric).toBe(lines[0].translatedLyric);
    expect(player.lines[0].romanLyric).toBe("");
    expect(player.lines[0].words[0].romanWord).toBe("");
    rerender(<SongLyricPlayer lines={[{ ...source[0], translatedLyric: "   " }]} />);
    expect(player.lines[0].romanLyric).toBe("yo zo ra");
    expect(player.lines[0].words[0].romanWord).toBe("yo zo ra");
  });

  it("前奏使用真实音频时间，暂停及结束事件不会先闪回首句", () => {
    const audio = document.createElement("audio");
    const audioRef = createRef<HTMLAudioElement>();
    audioRef.current = audio;
    Object.defineProperty(audio, "paused", { configurable: true, value: false });
    audio.currentTime = 34;
    const { rerender, unmount } = render(
      <SongLyricPlayer lines={lines} audioRef={audioRef} audioPlaybackState="playing" />,
    );
    const player = players.at(-1)!;
    expect(player.time).toBe(34000);
    expect(player.playing).toBe(true);
    act(() => { audio.currentTime = 42; audio.dispatchEvent(new Event("timeupdate")); });
    expect(player.time).toBe(42000);
    act(() => {
      Object.defineProperty(audio, "paused", { configurable: true, value: true });
      audio.dispatchEvent(new Event("pause"));
      audio.dispatchEvent(new Event("ended"));
    });
    expect(player.time).toBe(42000);
    expect(player.playing).toBe(false);
    rerender(<SongLyricPlayer lines={lines} audioRef={audioRef} audioPlaybackState="completed" />);
    expect(player.time).toBe(35000);
    expect(player.sourceUpdates).toBe(1);
    unmount();
    expect(player.disposed).toBe(true);
    act(() => { audio.currentTime = 36; audio.dispatchEvent(new Event("timeupdate")); });
    expect(player.time).toBe(35000);
  });

  it("新曲尚未就绪时停在该曲首句，不继承上一轮时间", () => {
    const audio = document.createElement("audio");
    const audioRef = createRef<HTMLAudioElement>();
    audioRef.current = audio;
    audio.currentTime = 42;
    const { rerender } = render(<SongLyricPlayer lines={lines} audioRef={audioRef} audioPlaybackState="completed" />);
    rerender(<SongLyricPlayer lines={[{ time: 90000, endTime: 95000, text: "下一轮歌词" }]}
      audioRef={audioRef} audioPlaybackState="idle" audioStatus="loading" />);
    expect(players.at(-1)!.time).toBe(90000);
    expect(players.at(-1)!.playing).toBe(false);
  });
});


describe("歌词动画调度", () => {
  let frames: Map<number, FrameRequestCallback>;
  let scenes: SongLyricScene[];
  let nextFrame: number;
  const flushFrame = (time: number) => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(time);
  };
  const createScene = () => {
    const scene = new SongLyricScene(document.createElement("div"));
    scenes.push(scene);
    return scene;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    frames = new Map();
    scenes = [];
    nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });
  afterEach(() => {
    for (const scene of scenes) scene.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("暂停仍推进动画，delta 使用实际更新间隔且不会重复调度", () => {
    const scene = createScene();
    scene.setSource(lines, null);
    scene.setPlayback("paused", "ready");
    scene.setPlayback("paused", "ready");
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(34);
    expect(frames.size).toBe(1);
    flushFrame(34);
    expect(frames.size).toBe(0);
    vi.advanceTimersByTime(34);
    flushFrame(68);
    expect(players.at(-1)!.updates.slice(-2)).toEqual([0, 34]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("媒体恢复立即取消低频等待，暂停和卸载清理两种调度及事件", () => {
    const scene = createScene();
    const audio = document.createElement("audio");
    scene.setSource(lines, audio);
    scene.setPlayback("playing", "ready");
    expect(vi.getTimerCount()).toBe(1);
    Object.defineProperty(audio, "paused", { configurable: true, value: false });
    audio.dispatchEvent(new Event("play"));
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(1);
    flushFrame(100);
    flushFrame(116);
    expect(players.at(-1)!.updates.slice(-2)).toEqual([0, 16]);
    Object.defineProperty(audio, "paused", { configurable: true, value: true });
    audio.dispatchEvent(new Event("pause"));
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    scene.dispose();
    const count = players.at(-1)!.updates.length;
    vi.advanceTimersByTime(1000);
    audio.dispatchEvent(new Event("play"));
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(players.at(-1)!.updates).toHaveLength(count);
  });

  it("无歌词不启动更新循环，从有词切换为空也取消待执行帧", () => {
    const scene = createScene();
    scene.setSource([], null);
    scene.setPlayback("idle", "ready");
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(0);
    scene.setSource(lines, null);
    vi.advanceTimersByTime(34);
    expect(frames.size).toBe(1);
    scene.setSource([], null);
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(0);
  });
});
