import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import type { SonGuessrCommandMap } from "@/lib/SonGuessrWs";
import type { GameSendCommand } from "@/lib/GameWs";
import { notifyPreferencesApplied } from "@/lib/PreferenceBus";
import { SONG_VOLUME_KEY } from "@/lib/Storage";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { playingSnapshot, songPrivate } from "@/stories/fixtures/SonGuessr";
import { useAudioClipPlayer } from "./UseAudioClipPlayer";

describe("useAudioClipPlayer", () => {
  let mockAudio: HTMLAudioElement;
  /** jsdom 没有媒体管线：就绪度、跳转与网络状态由用例按真实浏览器派发事件时的样子摆好。 */
  let media: { readyState: number; seeking: boolean; networkState: number };
  let playSpy: MockInstance;

  beforeEach(() => {
    mockAudio = document.createElement("audio");
    media = {
      readyState: HTMLMediaElement.HAVE_NOTHING,
      seeking: false,
      networkState: HTMLMediaElement.NETWORK_LOADING,
    };
    for (const key of ["readyState", "seeking", "networkState"] as const) {
      Object.defineProperty(mockAudio, key, { configurable: true, get: () => media[key] });
    }
    playSpy = vi.spyOn(mockAudio, "play").mockResolvedValue(undefined);
    vi.spyOn(mockAudio, "pause").mockImplementation(() => {});
  });

  /** 浏览器派发 canplay 时，当前位置的数据已经够往下播。 */
  const canPlay = () => {
    media.readyState = HTMLMediaElement.HAVE_FUTURE_DATA;
    mockAudio.dispatchEvent(new Event("canplay"));
  };

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
      canPlay();
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
      canPlay();
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
        canPlay();
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

    it("恢复播放的当下先写一次包络音量，不等下一帧", async () => {
      const hook = mountPlayer();
      await loadAndPlay(hook, {
        url: "https://example.com/song.mp3",
        startMs: 10_000,
        endMs: 20_000,
      });

      // 在片段中段恢复播放：恢复那一刻就该是中段音量，不能带着旧值先响一帧。
      mockAudio.currentTime = 15;
      mockAudio.volume = 0;
      await act(async () => {
        mockAudio.dispatchEvent(new Event("play"));
      });
      expect(mockAudio.volume).toBeCloseTo(0.65, 5);
    });

    it("暂停后淡变循环自己停下，不再改音量也不再续排", async () => {
      const hook = mountPlayer();
      await loadAndPlay(hook, {
        url: "https://example.com/song.mp3",
        startMs: 10_000,
        endMs: 20_000,
      });

      Object.defineProperty(mockAudio, "paused", { configurable: true, value: true });
      mockAudio.currentTime = 15;
      mockAudio.volume = 0.123;
      act(() => flushFrame());
      expect(mockAudio.volume).toBe(0.123);
      expect(frames.size).toBe(0);
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

  describe("就绪以片段起点能播为准", () => {
    const initialStore = useSonGuessrStore.getState();

    beforeEach(() => {
      // 本人是在场的猜歌玩家：就绪时要向服务端报 audioReady。
      useSonGuessrStore.setState({ snapshot: playingSnapshot(), privateState: songPrivate() });
    });

    afterEach(() => {
      useSonGuessrStore.setState(initialStore, true);
    });

    const mountPlayer = (sendCommand = vi.fn().mockResolvedValue(undefined)) => {
      vi.spyOn(mockAudio, "load").mockImplementation(() => {});
      // 逐帧记下每次渲染看到的状态：Effect 补上之前的那一帧也算数。
      const seen: { roundNumber: number; status: string }[] = [];
      const hook = renderHook(
        ({ audioUrl, roundNumber }) => {
          const player = useAudioClipPlayer({
            roomId: "test-room",
            phase: "playing",
            currentPhaseRoundNumber: roundNumber,
            currentAudioUrl: audioUrl,
            currentClipStartTime: 60_000,
            currentClipEndTime: 75_000,
            isPlayingPhase: true,
            sendCommand,
          });
          seen.push({ roundNumber, status: player.audioStatus });
          return player;
        },
        { initialProps: { audioUrl: undefined as string | undefined, roundNumber: 1 } }
      );
      hook.result.current.audioRef.current = mockAudio;
      hook.rerender({ audioUrl: "https://example.com/round-1.mp3", roundNumber: 1 });
      return { ...hook, seen, sendCommand };
    };

    const fire = (type: string) => act(async () => void mockAudio.dispatchEvent(new Event(type)));
    const audioReadyCalls = (sendCommand: ReturnType<typeof vi.fn>) =>
      sendCommand.mock.calls.filter(([type]) => type === "song.game.audioReady");

    it("只拿到文件开头、片段起点还在跳转时保持加载中，不报就绪也不起播", async () => {
      const { result, sendCommand } = mountPlayer();

      // 弱网常见：开头那一帧到了（loadeddata），跳到 60 秒的那一段还在路上。
      media.readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
      await fire("loadeddata");
      expect(mockAudio.currentTime).toBe(60);
      media.seeking = true;
      media.readyState = HTMLMediaElement.HAVE_FUTURE_DATA;
      await fire("canplay");

      expect(result.current.audioStatus).toBe("loading");
      expect(audioReadyCalls(sendCommand)).toHaveLength(0);
      expect(playSpy).not.toHaveBeenCalled();

      // 跳转落地且数据够播：这时才算就绪，报一次就绪并自动起播。
      media.seeking = false;
      await fire("seeked");

      expect(result.current.audioStatus).toBe("ready");
      expect(audioReadyCalls(sendCommand)).toEqual([["song.game.audioReady", { roundNumber: 1 }]]);
      expect(playSpy).toHaveBeenCalledTimes(1);
    });

    it("只有当前帧且浏览器仍在拉数据时不算就绪", async () => {
      const { result } = mountPlayer();

      media.readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
      await fire("loadeddata");

      expect(result.current.audioStatus).toBe("loading");
    });

    it("浏览器停下预载等起播时，有当前帧就算就绪", async () => {
      const { result } = mountPlayer();

      media.readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
      media.networkState = HTMLMediaElement.NETWORK_IDLE;
      await fire("suspend");

      expect(result.current.audioStatus).toBe("ready");
    });

    it("播到一半卡顿、缓冲回来再报 canplay 时不拽回片段起点", async () => {
      const { result, sendCommand } = mountPlayer();
      await act(async () => canPlay());
      expect(result.current.audioStatus).toBe("ready");

      mockAudio.currentTime = 66;
      await act(async () => canPlay());
      await fire("canplaythrough");

      expect(mockAudio.currentTime).toBe(66);
      expect(playSpy).toHaveBeenCalledTimes(1);
      expect(audioReadyCalls(sendCommand)).toHaveLength(1);
    });

    it("换回合的第一帧不沿用上一回合的就绪", async () => {
      const { rerender, seen } = mountPlayer();
      await act(async () => canPlay());
      expect(seen.at(-1)).toEqual({ roundNumber: 1, status: "ready" });

      media.readyState = HTMLMediaElement.HAVE_METADATA;
      rerender({ audioUrl: "https://example.com/round-2.mp3", roundNumber: 2 });

      const secondRound = seen.filter((entry) => entry.roundNumber === 2);
      expect(secondRound.length).toBeGreaterThan(0);
      expect(secondRound.every((entry) => entry.status === "loading")).toBe(true);
    });

    it("片段起点 15 秒仍不能播就转失败态，数据之后才到也照样接回就绪", async () => {
      vi.useFakeTimers();
      try {
        const { result } = mountPlayer();
        // 开头那一帧早就到了：旧判定按 HAVE_CURRENT_DATA 放过，会一直卡在加载中。
        media.readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
        await fire("loadeddata");

        await act(async () => void vi.advanceTimersByTime(15_000));
        expect(result.current.audioStatus).toBe("error");

        await act(async () => canPlay());
        expect(result.current.audioStatus).toBe("ready");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("起播之后出错", () => {
    const initialStore = useSonGuessrStore.getState();

    beforeEach(() => {
      useSonGuessrStore.setState({ snapshot: playingSnapshot(), privateState: songPrivate() });
    });

    afterEach(() => {
      useSonGuessrStore.setState(initialStore, true);
    });

    /** 假的缓冲区：每段是 [起, 止]（秒）。 */
    const setBuffered = (ranges: [number, number][]) => {
      Object.defineProperty(mockAudio, "buffered", {
        configurable: true,
        value: {
          length: ranges.length,
          start: (index: number) => ranges[index][0],
          end: (index: number) => ranges[index][1],
        },
      });
    };

    const startPlaying = async (sendCommand: GameSendCommand<SonGuessrCommandMap>) => {
      // 与真实浏览器一致：重新 load() 会把就绪度清回零。
      const load = vi.spyOn(mockAudio, "load").mockImplementation(() => {
        media.readyState = HTMLMediaElement.HAVE_NOTHING;
      });
      const pause = vi.spyOn(mockAudio, "pause").mockImplementation(() => {});
      const hook = renderHook(
        ({ audioUrl }) =>
          useAudioClipPlayer({
            roomId: "test-room",
            phase: "playing",
            currentPhaseRoundNumber: 1,
            currentAudioUrl: audioUrl,
            currentClipStartTime: 60_000,
            currentClipEndTime: 75_000,
            isPlayingPhase: true,
            sendCommand,
          }),
        { initialProps: { audioUrl: undefined as string | undefined } }
      );
      hook.result.current.audioRef.current = mockAudio;
      hook.rerender({ audioUrl: "https://example.com/song.mp3" });
      await act(async () => canPlay());
      Object.defineProperty(mockAudio, "paused", { configurable: true, value: false });
      await act(async () => void mockAudio.dispatchEvent(new Event("play")));
      expect(hook.result.current.audioPlaybackState).toBe("playing");
      pause.mockClear();
      return { ...hook, load, pause };
    };

    /** 按 `MediaError` 的规范码报错：2 是网络错误，3 是解码错误。 */
    const fail = (code = 2) =>
      act(async () => {
        Object.defineProperty(mockAudio, "error", { configurable: true, value: { code } });
        mockAudio.dispatchEvent(new Event("error"));
      });
    const failedReports = (sendCommand: ReturnType<typeof vi.fn>) =>
      sendCommand.mock.calls.filter(([type]) => type === "song.game.audioFailed");

    it("片段还没缓冲完就出错：停下、转失败态并上报刷新，给出重试", async () => {
      const sendCommand = vi.fn().mockResolvedValue(undefined);
      const { result, pause } = await startPlaying(sendCommand);
      setBuffered([[58, 66]]);
      mockAudio.currentTime = 66;

      await fail();

      expect(pause).toHaveBeenCalled();
      expect(result.current.audioStatus).toBe("error");
      expect(result.current.audioPlaybackState).toBe("idle");
      expect(failedReports(sendCommand)).toEqual([["song.game.audioFailed", { roundNumber: 1 }]]);
    });

    it("服务端刷新了地址时自动重新请求，重新就绪后照常起播", async () => {
      const sendCommand = vi.fn().mockResolvedValue({ refreshed: true });
      const { result, load } = await startPlaying(sendCommand);
      setBuffered([[58, 66]]);
      expect(load).toHaveBeenCalledTimes(1);

      await fail();

      expect(load).toHaveBeenCalledTimes(2);
      expect(result.current.audioStatus).toBe("loading");
      await act(async () => canPlay());
      expect(result.current.audioStatus).toBe("ready");
      expect(playSpy).toHaveBeenCalledTimes(2);
    });

    it("整段片段已缓冲时，之后的预载失败不打断这一题", async () => {
      const sendCommand = vi.fn().mockResolvedValue({ refreshed: true });
      const { result, load, pause } = await startPlaying(sendCommand);
      // 片段 60–75 秒整段都在缓冲区里，浏览器接着预载后面时上游地址到期。
      setBuffered([[0, 80]]);

      await fail();

      expect(pause).not.toHaveBeenCalled();
      expect(result.current.audioStatus).toBe("ready");
      expect(result.current.audioPlaybackState).toBe("playing");
      expect(failedReports(sendCommand)).toHaveLength(0);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("整段已缓冲但解码出错时照样转失败态：播放管线停了，缓冲区再完整也播不了", async () => {
      const sendCommand = vi.fn().mockResolvedValue(undefined);
      const { result, pause } = await startPlaying(sendCommand);
      setBuffered([[0, 80]]);

      await fail(3);

      expect(pause).toHaveBeenCalled();
      expect(result.current.audioStatus).toBe("error");
      expect(result.current.audioPlaybackState).toBe("idle");
      expect(failedReports(sendCommand)).toEqual([["song.game.audioFailed", { roundNumber: 1 }]]);
    });
  });
});

describe("useAudioClipPlayer · 自选音质", () => {
  const DEFAULT_URL = "/api/songuessr/audio/1234/ticket";
  const LOSSLESS_URL = `${DEFAULT_URL}?q=lossless`;
  let audio: HTMLAudioElement;
  let playSpy: MockInstance;
  /** jsdom 没有媒体管线：就绪度由用例摆好；换地址重新 load() 时像真实浏览器一样回到 HAVE_NOTHING。 */
  let media: { readyState: number; seeking: boolean; networkState: number };

  beforeEach(() => {
    audio = document.createElement("audio");
    media = {
      readyState: HTMLMediaElement.HAVE_NOTHING,
      seeking: false,
      networkState: HTMLMediaElement.NETWORK_LOADING,
    };
    for (const key of ["readyState", "seeking", "networkState"] as const) {
      Object.defineProperty(audio, key, { configurable: true, get: () => media[key] });
    }
    vi.spyOn(audio, "load").mockImplementation(() => {
      media.readyState = HTMLMediaElement.HAVE_NOTHING;
    });
    playSpy = vi.spyOn(audio, "play").mockResolvedValue(undefined);
    vi.spyOn(audio, "pause").mockImplementation(() => {});
  });

  /** 浏览器派发 canplay 时，当前位置的数据已经够往下播。 */
  const canPlay = () => {
    media.readyState = HTMLMediaElement.HAVE_FUTURE_DATA;
    audio.dispatchEvent(new Event("canplay"));
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  type Props = {
    url?: string;
    pending?: boolean;
    onSourceError?: (url: string, decode: boolean) => boolean;
  };

  const mount = (sendCommand = vi.fn().mockResolvedValue(undefined)) => {
    const hook = renderHook(
      ({ url, pending, onSourceError }: Props) =>
        useAudioClipPlayer({
          roomId: "1234",
          phase: "playing",
          currentPhaseRoundNumber: 1,
          currentAudioUrl: url,
          currentClipStartTime: 10_000,
          currentClipEndTime: 30_000,
          isPlayingPhase: true,
          sendCommand: sendCommand as unknown as GameSendCommand<SonGuessrCommandMap>,
          sourcePending: pending,
          onSourceError,
        }),
      { initialProps: {} as Props }
    );
    hook.result.current.audioRef.current = audio;
    return { ...hook, sendCommand };
  };

  const startPlaying = async () => {
    await act(async () => {
      canPlay();
    });
    Object.defineProperty(audio, "paused", { configurable: true, value: false });
    await act(async () => {
      audio.dispatchEvent(new Event("play"));
    });
  };

  it("地址还在路上时读作加载中，什么都不加载", () => {
    const { result, rerender } = mount();
    rerender({ pending: true });
    expect(result.current.audioStatus).toBe("loading");
    expect(result.current.audioPlaybackState).toBe("idle");
    expect(audio.getAttribute("src")).toBeNull();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("换上的那一档放不出来时交给调用方回退：不进失败态，也不上报默认地址失效", async () => {
    const onSourceError = vi.fn(() => true);
    const { result, rerender, sendCommand } = mount();
    rerender({ url: LOSSLESS_URL, onSourceError });
    await act(async () => {
      audio.dispatchEvent(new Event("error"));
    });
    expect(onSourceError).toHaveBeenCalledWith(LOSSLESS_URL, false);
    expect(result.current.audioStatus).toBe("loading");
    expect(sendCommand).not.toHaveBeenCalledWith("song.game.audioFailed", expect.anything());

    // 调用方不接手（默认地址本身坏了）时照旧进失败态并上报。
    onSourceError.mockReturnValue(false);
    rerender({ url: DEFAULT_URL, onSourceError });
    await act(async () => {
      audio.dispatchEvent(new Event("error"));
    });
    expect(result.current.audioStatus).toBe("error");
    expect(sendCommand).toHaveBeenCalledWith("song.game.audioFailed", { roundNumber: 1 });
  });

  it("同一段里换了地址就从换档前的进度接着放，状态不回到加载中", async () => {
    const { result, rerender } = mount();
    rerender({ url: DEFAULT_URL });
    await startPlaying();
    expect(audio.currentTime).toBe(10);
    expect(playSpy).toHaveBeenCalledTimes(1);

    audio.currentTime = 17.5;
    rerender({ url: LOSSLESS_URL });
    expect(audio.getAttribute("src")).toBe(LOSSLESS_URL);
    expect(result.current.audioStatus).toBe("ready");
    expect(result.current.audioPlaybackState).toBe("playing");

    audio.currentTime = 0;
    await act(async () => {
      canPlay();
    });
    expect(audio.currentTime).toBe(17.5);
    expect(playSpy).toHaveBeenCalledTimes(2);

    // 之后再报 canplay（缓冲回来）也不把进度拽回片段起点。
    audio.currentTime = 19;
    await act(async () => {
      canPlay();
    });
    expect(audio.currentTime).toBe(19);
  });

  it("换档前已经停下的不会自己放起来", async () => {
    const { rerender } = mount();
    rerender({ url: DEFAULT_URL });
    await startPlaying();
    Object.defineProperty(audio, "paused", { configurable: true, value: true });
    audio.currentTime = 12;

    rerender({ url: LOSSLESS_URL });
    await act(async () => {
      canPlay();
    });
    expect(audio.currentTime).toBe(12);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });
});
