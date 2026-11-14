import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClipEnvelope } from "./ClipPlayback";

describe("createClipEnvelope", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame = 0;
  const flushFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  };

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mount = () => {
    const audio = document.createElement("audio");
    let volume = 0.5;
    let range: { startSeconds: number; endSeconds?: number } = { startSeconds: 10, endSeconds: 20 };
    const envelope = createClipEnvelope(
      () => audio,
      () => volume,
      () => range
    );
    return {
      audio,
      envelope,
      setVolume: (value: number) => {
        volume = value;
      },
      setRange: (value: { startSeconds: number; endSeconds?: number }) => {
        range = value;
      },
    };
  };

  it("volumeAt 按包络计算且不写回元素", () => {
    const { audio, envelope } = mount();
    audio.volume = 1;

    expect(envelope.volumeAt(10)).toBe(0);
    expect(envelope.volumeAt(10.5)).toBeCloseTo(0.25, 5);
    expect(envelope.volumeAt(15)).toBeCloseTo(0.5, 5);
    expect(envelope.volumeAt(19.5)).toBeCloseTo(0.25, 5);
    expect(envelope.volumeAt(20)).toBe(0);
    expect(audio.volume).toBe(1);
  });

  it("apply 按元素当前播放头写回包络音量", () => {
    const { audio, envelope } = mount();
    audio.currentTime = 10.5;
    envelope.apply();
    expect(audio.volume).toBeCloseTo(0.25, 5);

    audio.currentTime = 15;
    envelope.apply();
    expect(audio.volume).toBeCloseTo(0.5, 5);
  });

  it("start 逐帧执行帧体并续排，返回 false 后停下", () => {
    const { envelope } = mount();
    let calls = 0;
    envelope.start(() => {
      calls += 1;
      return calls < 2;
    });
    expect(frames.size).toBe(1);

    flushFrame();
    expect(calls).toBe(1);
    expect(frames.size).toBe(1);

    flushFrame();
    expect(calls).toBe(2);
    expect(frames.size).toBe(0);
  });

  it("重复 start 先取消上一帧，不会叠出两条循环", () => {
    const { envelope } = mount();
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    envelope.start(first);
    envelope.start(second);
    expect(frames.size).toBe(1);

    flushFrame();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(1);
  });

  it("stop 取消未跑的帧，之后还能重新 start", () => {
    const { envelope } = mount();
    const body = vi.fn(() => true);
    envelope.start(body);
    envelope.stop();
    expect(frames.size).toBe(0);

    flushFrame();
    expect(body).not.toHaveBeenCalled();

    envelope.start(body);
    flushFrame();
    expect(body).toHaveBeenCalledTimes(1);
  });

  it("音量与范围逐帧实时取，改了下帧就按新值算", () => {
    const { audio, envelope, setVolume, setRange } = mount();
    envelope.start(() => {
      envelope.apply();
      return true;
    });

    audio.currentTime = 15;
    flushFrame();
    expect(audio.volume).toBeCloseTo(0.5, 5);

    setVolume(0.8);
    flushFrame();
    expect(audio.volume).toBeCloseTo(0.8, 5);

    setRange({ startSeconds: 14, endSeconds: 16 });
    audio.currentTime = 14.5;
    flushFrame();
    expect(audio.volume).toBeCloseTo(0.8 * 0.5, 5);
  });

  it("元素还没挂载时 apply 不写不抛，帧体照常跑", () => {
    let audio: HTMLAudioElement | null = null;
    const envelope = createClipEnvelope(
      () => audio,
      () => 0.5,
      () => ({ startSeconds: 10, endSeconds: 20 })
    );
    expect(() => envelope.apply()).not.toThrow();

    const body = vi.fn(() => true);
    envelope.start(body);
    flushFrame();
    expect(body).toHaveBeenCalledTimes(1);

    audio = document.createElement("audio");
    audio.currentTime = 15;
    envelope.apply();
    expect(audio.volume).toBeCloseTo(0.5, 5);
  });
});
