import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClipPreviewAudio } from "./UseClipPreviewAudio";

const setup = () =>
  renderHook(({ range }) => useClipPreviewAudio({ range, volume: 0.5 }), {
    initialProps: { range: [1_000, 5_000] as readonly [number, number] },
  });

it("音频元素晚于 hook 挂载才出现时，卸载仍会停掉播放", () => {
  const audio = document.createElement("audio");
  const pause = vi.spyOn(audio, "pause").mockImplementation(() => {});
  const { result, rerender, unmount } = setup();
  // 挂载时还没有元素；之后元素才渲染出来
  result.current.audioRef.current = audio;
  rerender({ range: [1_000, 5_000] });
  pause.mockClear();
  unmount();
  expect(pause).toHaveBeenCalled();
});

it("重新开始加载（换了音源）时，失败提示复位", () => {
  const { result } = setup();
  act(() => result.current.audioEvents.onError());
  expect(result.current.failed).toBe(true);
  act(() => result.current.audioEvents.onLoadStart());
  expect(result.current.failed).toBe(false);
});

describe("试听包络与终点", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame = 0;
  const flushFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const mountPreview = (range: readonly [number, number] = [1_000, 5_000], volume = 0.5) => {
    const audio = document.createElement("audio");
    vi.spyOn(audio, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(audio, "pause").mockImplementation(() => {});
    const hook = renderHook(({ range, volume }) => useClipPreviewAudio({ range, volume }), {
      initialProps: { range, volume },
    });
    hook.result.current.audioRef.current = audio;
    return { ...hook, audio, pause };
  };

  const startPlaying = async (hook: ReturnType<typeof mountPreview>) => {
    await act(async () => {
      await hook.result.current.togglePlay();
    });
  };

  it("起播后音量从零沿淡入曲线上升", async () => {
    const hook = mountPreview();
    await startPlaying(hook);

    expect(hook.result.current.playing).toBe(true);
    expect(hook.audio.currentTime).toBe(1);
    expect(hook.audio.volume).toBe(0);
    expect(frames.size).toBe(1);

    hook.audio.currentTime = 1.5;
    act(() => flushFrame());
    expect(hook.audio.volume).toBeCloseTo(0.25, 5);
    expect(frames.size).toBe(1);

    hook.audio.currentTime = 2;
    act(() => flushFrame());
    expect(hook.audio.volume).toBeCloseTo(0.5, 5);
  });

  it("临近终点音量沿淡出曲线下降", async () => {
    const hook = mountPreview();
    await startPlaying(hook);

    hook.audio.currentTime = 4.5;
    act(() => flushFrame());
    expect(hook.audio.volume).toBeCloseTo(0.25, 5);

    hook.audio.currentTime = 4.9;
    act(() => flushFrame());
    expect(hook.audio.volume).toBeCloseTo(0.05, 5);
  });

  it("片段中段保持设定音量", async () => {
    const hook = mountPreview();
    await startPlaying(hook);

    hook.audio.currentTime = 3;
    act(() => flushFrame());
    expect(hook.audio.volume).toBeCloseTo(0.5, 5);

    hook.audio.currentTime = 2.5;
    act(() => flushFrame());
    expect(hook.audio.volume).toBeCloseTo(0.5, 5);
  });

  it("逐帧判到终点即暂停并回到片段起点", async () => {
    const hook = mountPreview();
    await startPlaying(hook);
    hook.audio.currentTime = 4.9;
    act(() => flushFrame());
    expect(hook.result.current.playing).toBe(true);

    // 不发 timeupdate：终点由帧循环自己判到。
    hook.audio.currentTime = 5;
    act(() => flushFrame());

    expect(hook.pause).toHaveBeenCalled();
    expect(hook.audio.currentTime).toBe(1);
    expect(hook.result.current.playing).toBe(false);
    expect(hook.result.current.currentTimeMs).toBe(1_000);
    expect(frames.size).toBe(0);
    expect(hook.audio.volume).toBe(0);
  });

  it("切换片段范围后按新范围计算包络与终点", async () => {
    const hook = mountPreview();
    await startPlaying(hook);
    hook.audio.currentTime = 3;
    act(() => flushFrame());

    hook.rerender({ range: [2_000, 6_000], volume: 0.5 });
    hook.audio.currentTime = 2.5;
    act(() => flushFrame());
    // 新片段长 4s、淡入 1s：2.5s 处因子 0.5；按旧范围此处是满音量。
    expect(hook.audio.volume).toBeCloseTo(0.25, 5);

    hook.audio.currentTime = 6;
    act(() => flushFrame());
    expect(hook.pause).toHaveBeenCalled();
    expect(hook.audio.currentTime).toBe(2);
    expect(hook.result.current.playing).toBe(false);
  });

  it("选区移动后播放头落在外面时回到新起点", async () => {
    const hook = mountPreview();
    await startPlaying(hook);
    hook.audio.currentTime = 1.5;

    hook.rerender({ range: [2_000, 6_000], volume: 0.5 });

    expect(hook.audio.currentTime).toBe(2);
    expect(hook.result.current.currentTimeMs).toBe(2_000);
  });

  it("卸载时停掉逐帧循环并停播", async () => {
    const hook = mountPreview();
    await startPlaying(hook);
    expect(frames.size).toBe(1);

    hook.unmount();

    expect(frames.size).toBe(0);
    expect(hook.pause).toHaveBeenCalled();
  });

  it("调音量后试听中的新音量立即生效", async () => {
    const hook = mountPreview();
    await startPlaying(hook);
    hook.audio.currentTime = 3;
    act(() => flushFrame());
    expect(hook.audio.volume).toBeCloseTo(0.5, 5);

    hook.rerender({ range: [1_000, 5_000], volume: 0.8 });
    expect(hook.audio.volume).toBeCloseTo(0.8, 5);
    act(() => flushFrame());
    expect(hook.audio.volume).toBeCloseTo(0.8, 5);
  });
});
