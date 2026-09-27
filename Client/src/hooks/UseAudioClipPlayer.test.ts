import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useAudioClipPlayer } from "./UseAudioClipPlayer";

describe("useAudioClipPlayer", () => {
  let mockAudio: HTMLAudioElement;

  beforeEach(() => {
    mockAudio = document.createElement("audio");
    vi.spyOn(mockAudio, "play").mockResolvedValue(undefined);
    vi.spyOn(mockAudio, "pause").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("初始状态为 loading，就绪后音量由0平滑渐入", async () => {
    const sendCommand = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ audioUrl }) =>
        useAudioClipPlayer({
          roomId: "test-room",
          phase: "playing",
          currentPhaseRoundNumber: 1,
          currentAudioUrl: audioUrl,
          currentClipStartTime: 10_000,
          currentClipEndTime: 20_000,
          isPlayingPhase: true,
          sendCommand,
        }),
      { initialProps: { audioUrl: undefined as string | undefined } },
    );

    result.current.audioRef.current = mockAudio;
    rerender({ audioUrl: "https://example.com/song.mp3" });

    expect(result.current.audioPlaybackState).toBe("idle");
    expect(result.current.audioStatus).toBe("loading");

    // 模拟 canplay 触发就绪
    await act(async () => {
      mockAudio.dispatchEvent(new Event("canplay"));
    });

    expect(result.current.audioStatus).toBe("ready");
    // 起点 10.0s 时音量由于首秒渐入因子被前置为 0
    expect(mockAudio.volume).toBe(0);
  });

  it("播放接近尾声时（剩余不足1秒）音量逐渐衰减渐出并触发完成", async () => {
    const sendCommand = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ audioUrl }) =>
        useAudioClipPlayer({
          roomId: "test-room",
          phase: "playing",
          currentPhaseRoundNumber: 1,
          currentAudioUrl: audioUrl,
          currentClipStartTime: 10_000,
          currentClipEndTime: 20_000,
          isPlayingPhase: true,
          sendCommand,
        }),
      { initialProps: { audioUrl: undefined as string | undefined } },
    );

    result.current.audioRef.current = mockAudio;
    rerender({ audioUrl: "https://example.com/song.mp3" });

    await act(async () => {
      mockAudio.dispatchEvent(new Event("canplay"));
      mockAudio.currentTime = 19.5; // 剩余 0.5s，进入渐出区间
      mockAudio.dispatchEvent(new Event("timeupdate"));
    });

    // 渐出区间因子为 0.5，因此音量为设定的 50%
    expect(mockAudio.volume).toBeCloseTo(result.current.volume * 0.5, 2);

    // 播放越过终点 20.0s 触发暂停并标记 completed
    await act(async () => {
      mockAudio.currentTime = 20.1;
      mockAudio.dispatchEvent(new Event("timeupdate"));
    });

    expect(result.current.audioPlaybackState).toBe("completed");
  });

  describe("初始音量", () => {
    it.each([
      { label: "没有存档时用默认 65%", saved: null, expected: 0.65 },
      { label: "存档为空串时用默认 65%", saved: "", expected: 0.65 },
      { label: "存档无法解析时用默认 65%", saved: "响亮", expected: 0.65 },
      { label: "存档超出 0–1 时用默认 65%", saved: "1.5", expected: 0.65 },
      { label: "存档 0.3 时沿用", saved: "0.3", expected: 0.3 },
      { label: "存档 0 时尊重玩家的静音选择", saved: "0", expected: 0 },
    ])("$label", ({ saved, expected }) => {
      if (saved !== null) window.localStorage.setItem("songuessr_volume", saved);
      const { result } = renderHook(() =>
        useAudioClipPlayer({ roomId: "test-room", isPlayingPhase: false, sendCommand: vi.fn() }),
      );

      expect(result.current.volume).toBe(expected);
      // 挂载后写回的是实际采用的音量：首访不会把 0 固化进存档。
      expect(window.localStorage.getItem("songuessr_volume")).toBe(String(expected));
    });
  });
});
