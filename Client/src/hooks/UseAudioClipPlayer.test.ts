import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import type { SonGuessrCommandMap } from "@/lib/SonGuessrWs";
import type { GameSendCommand } from "@/lib/GameWs";
import { notifyPreferencesApplied } from "@/lib/PreferenceBus";
import { SONG_VOLUME_KEY } from "@/lib/Storage";
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
      { initialProps: { audioUrl: undefined as string | undefined } }
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
      { initialProps: { audioUrl: undefined as string | undefined } }
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

  it("加载失败后点重试会重新拉取音频，并重新向服务端报告失败", async () => {
    const load = vi.spyOn(mockAudio, "load").mockImplementation(() => {});
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
      { initialProps: { audioUrl: undefined as string | undefined } }
    );

    result.current.audioRef.current = mockAudio;
    rerender({ audioUrl: "https://example.com/song.mp3" });
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      mockAudio.dispatchEvent(new Event("error"));
    });
    expect(result.current.audioStatus).toBe("error");
    expect(sendCommand).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.retryAudio();
    });

    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.audioStatus).toBe("loading");

    await act(async () => {
      mockAudio.dispatchEvent(new Event("error"));
    });
    expect(sendCommand).toHaveBeenCalledTimes(2);
  });

  describe("站内票据地址：上游地址过期后重新请求同一个地址", () => {
    const TICKET_URL = "https://api.example.com/api/songuessr/audio/1234/TICKET";

    const mountPlayer = (sendCommand: GameSendCommand<SonGuessrCommandMap>) => {
      const load = vi.spyOn(mockAudio, "load").mockImplementation(() => {});
      const hook = renderHook(
        ({ audioUrl, roundNumber }) =>
          useAudioClipPlayer({
            roomId: "test-room",
            phase: "playing",
            currentPhaseRoundNumber: roundNumber,
            currentAudioUrl: audioUrl,
            currentClipStartTime: 10_000,
            currentClipEndTime: 20_000,
            isPlayingPhase: true,
            sendCommand,
          }),
        { initialProps: { audioUrl: undefined as string | undefined, roundNumber: 1 } }
      );
      hook.result.current.audioRef.current = mockAudio;
      hook.rerender({ audioUrl: TICKET_URL, roundNumber: 1 });
      return { ...hook, load };
    };

    const fail = () => act(async () => void mockAudio.dispatchEvent(new Event("error")));

    it("服务端刷新成功后，地址没变也要重新请求同一个地址", async () => {
      const sendCommand = vi.fn().mockResolvedValue({ refreshed: true });
      const { load, result } = mountPlayer(sendCommand);
      expect(load).toHaveBeenCalledTimes(1);

      await fail();

      expect(sendCommand).toHaveBeenCalledWith("song.game.audioFailed", { roundNumber: 1 });
      // 站内地址在刷新前后是同一个：不主动重载就永远停在失败态。
      expect(load).toHaveBeenCalledTimes(2);
      expect(mockAudio.src).toBe(TICKET_URL);
      expect(result.current.audioStatus).toBe("loading");
    });

    it("服务端没有刷新（回合已换或无可刷新）时不重载", async () => {
      const sendCommand = vi.fn().mockResolvedValue({ ignored: true });
      const { load, result } = mountPlayer(sendCommand);

      await fail();

      expect(load).toHaveBeenCalledTimes(1);
      expect(result.current.audioStatus).toBe("error");
    });

    it("刷新结果回来之前换了回合，不为旧回合重载", async () => {
      let resolveAck!: (value: unknown) => void;
      const sendCommand = vi.fn().mockReturnValue(new Promise((resolve) => (resolveAck = resolve)));
      const { load, rerender } = mountPlayer(sendCommand);

      await fail();
      rerender({
        audioUrl: "https://api.example.com/api/songuessr/audio/1234/NEXT",
        roundNumber: 2,
      });
      expect(load).toHaveBeenCalledTimes(2);

      await act(async () => resolveAck({ refreshed: true }));

      expect(load).toHaveBeenCalledTimes(2);
    });

    it("连续失败时自动重载有上限，之后停在失败态等玩家手动重试", async () => {
      const sendCommand = vi.fn().mockResolvedValue({ refreshed: true });
      const { load, result } = mountPlayer(sendCommand);

      for (let attempt = 0; attempt < 6; attempt += 1) await fail();

      // 首次装载加上有限次自动重载，不会无限循环。
      expect(load.mock.calls.length).toBeGreaterThan(1);
      expect(load.mock.calls.length).toBeLessThanOrEqual(4);
      expect(result.current.audioStatus).toBe("error");

      // 手动重试仍然可用，且重新请求同一个地址。
      const before = load.mock.calls.length;
      await act(async () => result.current.retryAudio());
      expect(load).toHaveBeenCalledTimes(before + 1);
    });

    it("上报失败的命令被拒时不重载", async () => {
      const sendCommand = vi.fn().mockRejectedValue(new Error("RATE_LIMITED"));
      const { load, result } = mountPlayer(sendCommand);

      await fail();

      expect(load).toHaveBeenCalledTimes(1);
      expect(result.current.audioStatus).toBe("error");
    });
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
        useAudioClipPlayer({ roomId: "test-room", isPlayingPhase: false, sendCommand: vi.fn() })
      );

      expect(result.current.volume).toBe(expected);
      // 挂载后写回的是实际采用的音量：首访不会把 0 固化进存档。
      expect(window.localStorage.getItem("songuessr_volume")).toBe(String(expected));
    });
  });

  describe("片段包络与终点", () => {
    let frames: Map<number, FrameRequestCallback>;
    let nextFrame = 0;
    let pauseSpy: MockInstance;
    const flushFrame = () => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    };

    beforeEach(() => {
      vi.useFakeTimers();
      frames = new Map();
      nextFrame = 0;
      pauseSpy = vi.spyOn(mockAudio, "pause").mockImplementation(() => {});
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

    const mountPlayer = () => {
      const hook = renderHook(
        ({ url, startMs, endMs }: { url?: string; startMs: number; endMs: number }) =>
          useAudioClipPlayer({
            roomId: "test-room",
            phase: "playing",
            currentPhaseRoundNumber: 1,
            currentAudioUrl: url,
            currentClipStartTime: startMs,
            currentClipEndTime: endMs,
            isPlayingPhase: true,
            sendCommand: vi.fn().mockResolvedValue(undefined),
          }),
        {
          initialProps: {
            url: undefined as string | undefined,
            startMs: 10_000,
            endMs: 20_000,
          },
        }
      );
      hook.result.current.audioRef.current = mockAudio;
      return hook;
    };

    const loadAndPlay = async (
      hook: ReturnType<typeof mountPlayer>,
      props: { url: string; startMs: number; endMs: number }
    ) => {
      hook.rerender(props);
      await act(async () => {
        mockAudio.dispatchEvent(new Event("canplay"));
      });
      Object.defineProperty(mockAudio, "paused", { configurable: true, value: false });
      await act(async () => {
        mockAudio.dispatchEvent(new Event("play"));
      });
    };

    it("起播后音量从零沿淡入曲线上升", async () => {
      const hook = mountPlayer();
      await loadAndPlay(hook, {
        url: "https://example.com/song.mp3",
        startMs: 10_000,
        endMs: 20_000,
      });

      expect(mockAudio.currentTime).toBe(10);
      expect(mockAudio.volume).toBe(0);
      expect(frames.size).toBe(1);

      mockAudio.currentTime = 10.5;
      act(() => flushFrame());
      expect(mockAudio.volume).toBeCloseTo(0.65 * 0.5, 5);
      expect(frames.size).toBe(1);

      mockAudio.currentTime = 11;
      act(() => flushFrame());
      expect(mockAudio.volume).toBeCloseTo(0.65, 5);
    });

    it("临近终点音量沿淡出曲线下降", async () => {
      const hook = mountPlayer();
      await loadAndPlay(hook, {
        url: "https://example.com/song.mp3",
        startMs: 10_000,
        endMs: 20_000,
      });

      mockAudio.currentTime = 19.5;
      act(() => flushFrame());
      expect(mockAudio.volume).toBeCloseTo(0.65 * 0.5, 5);

      mockAudio.currentTime = 19.9;
      act(() => flushFrame());
      expect(mockAudio.volume).toBeCloseTo(0.65 * 0.1, 5);
    });

    it("片段中段保持设定音量", async () => {
      const hook = mountPlayer();
      await loadAndPlay(hook, {
        url: "https://example.com/song.mp3",
        startMs: 10_000,
        endMs: 20_000,
      });

      mockAudio.currentTime = 15;
      act(() => flushFrame());
      expect(mockAudio.volume).toBeCloseTo(0.65, 5);

      mockAudio.currentTime = 16;
      act(() => flushFrame());
      expect(mockAudio.volume).toBeCloseTo(0.65, 5);
    });

    it("播到终点时暂停并回到片段起点", async () => {
      const hook = mountPlayer();
      await loadAndPlay(hook, {
        url: "https://example.com/song.mp3",
        startMs: 10_000,
        endMs: 20_000,
      });
      mockAudio.currentTime = 19.8;
      act(() => flushFrame());
      expect(frames.size).toBe(1);

      mockAudio.currentTime = 20;
      await act(async () => {
        mockAudio.dispatchEvent(new Event("timeupdate"));
      });

      expect(pauseSpy).toHaveBeenCalled();
      expect(mockAudio.currentTime).toBe(10);
      expect(hook.result.current.audioPlaybackState).toBe("completed");
      expect(frames.size).toBe(0);
      // 停循环后音量回到设定值，不带包络。
      expect(mockAudio.volume).toBe(0.65);
    });

    it("切换片段范围后按新范围计算包络与终点", async () => {
      const hook = mountPlayer();
      await loadAndPlay(hook, {
        url: "https://example.com/song.mp3",
        startMs: 10_000,
        endMs: 20_000,
      });
      await loadAndPlay(hook, {
        url: "https://example.com/song.mp3",
        startMs: 12_000,
        endMs: 16_000,
      });

      expect(mockAudio.currentTime).toBe(12);
      expect(mockAudio.volume).toBe(0);

      mockAudio.currentTime = 12.5;
      act(() => flushFrame());
      // 新片段长 4s、淡入 1s：12.5s 处因子 0.5；按旧范围此处是满音量。
      expect(mockAudio.volume).toBeCloseTo(0.65 * 0.5, 5);

      mockAudio.currentTime = 16;
      await act(async () => {
        mockAudio.dispatchEvent(new Event("timeupdate"));
      });
      expect(hook.result.current.audioPlaybackState).toBe("completed");
      expect(mockAudio.currentTime).toBe(12);
    });

    it("卸载时停掉淡变循环并移除监听", async () => {
      const hook = mountPlayer();
      await loadAndPlay(hook, {
        url: "https://example.com/song.mp3",
        startMs: 10_000,
        endMs: 20_000,
      });
      expect(frames.size).toBe(1);

      hook.unmount();

      expect(frames.size).toBe(0);
      expect(pauseSpy).toHaveBeenCalled();
      // 监听已移除：再发事件不会重新起循环，也不会把播放头卷回起点。
      mockAudio.currentTime = 20.1;
      mockAudio.dispatchEvent(new Event("timeupdate"));
      mockAudio.dispatchEvent(new Event("play"));
      expect(frames.size).toBe(0);
      expect(mockAudio.currentTime).toBe(20.1);
    });

    it("播放中调低音量后新音量立即生效", async () => {
      const hook = mountPlayer();
      await loadAndPlay(hook, {
        url: "https://example.com/song.mp3",
        startMs: 10_000,
        endMs: 20_000,
      });
      mockAudio.currentTime = 15;
      act(() => flushFrame());
      expect(mockAudio.volume).toBeCloseTo(0.65, 5);

      act(() => hook.result.current.setVolume(0.2));
      expect(mockAudio.volume).toBe(0.2);
      act(() => flushFrame());
      expect(mockAudio.volume).toBeCloseTo(0.2, 5);
      expect(window.localStorage.getItem(SONG_VOLUME_KEY)).toBe("0.2");
    });

    it("云端偏好写回后播放中改用新音量", async () => {
      const hook = mountPlayer();
      await loadAndPlay(hook, {
        url: "https://example.com/song.mp3",
        startMs: 10_000,
        endMs: 20_000,
      });
      mockAudio.currentTime = 15;
      act(() => flushFrame());
      expect(mockAudio.volume).toBeCloseTo(0.65, 5);

      act(() => {
        window.localStorage.setItem(SONG_VOLUME_KEY, "0.3");
        notifyPreferencesApplied();
      });
      expect(hook.result.current.volume).toBe(0.3);
      expect(mockAudio.volume).toBe(0.3);
      act(() => flushFrame());
      expect(mockAudio.volume).toBeCloseTo(0.3, 5);
    });
  });
});
