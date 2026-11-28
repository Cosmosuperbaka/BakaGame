import { useCallback, useEffect, useRef, useState } from "react";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { createClipEnvelope } from "@/lib/ClipPlayback";
import type { SonGuessrCommandMap } from "@/lib/SonGuessrWs";
import type { GameSendCommand } from "@/lib/GameWs";
import { notifyPreferencesChanged, onPreferencesApplied } from "@/lib/PreferenceBus";
import { SONG_VOLUME_KEY } from "@/lib/Storage";

const DEFAULT_SONG_VOLUME = 0.65;

/**
 * 服务端刷新上游播放地址成功后，同一个播放地址最多自动重新请求几次。
 * 站内票据地址在刷新前后不变，播放器不会因为「地址变了」而重载，必须主动再请求一次；
 * 但刷新出来的新地址仍然失败时不能无限循环，超过后停在失败态，交给玩家手动重试。
 */
const MAX_AUTO_RELOADS = 2;

type ClipAudioStatus = "loading" | "ready" | "error";

/**
 * 片段起点那一段真的能播：没有在跳转，且数据够往下播。浏览器主动停下预载（网络空闲）时，
 * 手里有当前帧也算：它要等起播才接着拉，干等只会等到超时。
 * 这几个媒体事件只说明「当前位置」有数据：跳转没落地或只有一帧时就报就绪，
 * 歌词先亮、倒计时先走，声音却还没到。
 */
const playableAtClipStart = (audio: HTMLAudioElement) =>
  !audio.seeking &&
  (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA ||
    (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      audio.networkState === HTMLMediaElement.NETWORK_IDLE));

/** 缓冲区与片段边界的对齐容差（秒）：与片段内纠偏的容差同档。 */
const BUFFER_EDGE_TOLERANCE = 0.25;

/** `MediaError.MEDIA_ERR_NETWORK`：规范定值，单独写出是因为测试环境没有 `MediaError` 全局。 */
const MEDIA_ERR_NETWORK = 2;

/**
 * 整段片段都已在缓冲区里：之后再拉后续数据失败（例如上游地址到期）不影响这一题。
 * 没有终点时按整首算，时长未知就不算整段已缓冲。
 */
const clipFullyBuffered = (
  audio: HTMLAudioElement,
  startSeconds: number,
  endSeconds: number | undefined
) => {
  const end = endSeconds ?? audio.duration;
  if (!Number.isFinite(end)) return false;
  const { buffered } = audio;
  for (let index = 0; index < buffered.length; index += 1) {
    if (
      buffered.start(index) <= startSeconds + BUFFER_EDGE_TOLERANCE &&
      buffered.end(index) >= end - BUFFER_EDGE_TOLERANCE
    ) {
      return true;
    }
  }
  return false;
};

/** 只采用 0–1 之间的有效存档；缺失、空串、无法解析或越界时用默认音量。 */
function readSavedVolume(): number {
  try {
    const saved = window.localStorage.getItem(SONG_VOLUME_KEY);
    if (!saved) return DEFAULT_SONG_VOLUME;
    const value = Number(saved);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_SONG_VOLUME;
  } catch {
    // 浏览器禁用本地存储（隐身沙箱等）时读取会抛错。
    return DEFAULT_SONG_VOLUME;
  }
}

export interface AudioClipPlayerOptions {
  roomId: string;
  phase?: string;
  currentPhaseRoundNumber?: number;
  currentAudioUrl?: string;
  currentClipStartTime?: number;
  currentClipEndTime?: number;
  isPlayingPhase: boolean;
  sendCommand: GameSendCommand<SonGuessrCommandMap>;
  /** 播放地址还在路上（等自选音质的回执）：先停在加载态，什么都不加载。 */
  sourcePending?: boolean;
  /**
   * 当前地址放不出来时先问调用方：返回 true 表示它会换一个地址（自选音质回退到默认档），
   * 这次失败不进入失败态，也不当成默认地址失效去上报。`decode` 为真表示是格式解不了。
   */
  onSourceError?: (url: string, decode: boolean) => boolean;
}

/**
 * 同一段播放里换了地址（玩家换了音质）时，接着换之前的进度放：卸载旧地址前记下的位置与状态。
 * 段落按「房间、阶段、回合、片段起止」认，换回合或换阶段不算。
 */
interface PlaybackCarryOver {
  segmentKey: string;
  url: string;
  time: number;
  playing: boolean;
  completed: boolean;
}

export function useAudioClipPlayer({
  roomId,
  phase,
  currentPhaseRoundNumber,
  currentAudioUrl,
  currentClipStartTime,
  currentClipEndTime,
  isPlayingPhase,
  sendCommand,
  sourcePending = false,
  onSourceError,
}: AudioClipPlayerOptions) {
  const [volume, setVolumeState] = useState(readSavedVolume);

  // 登录后云端音量写回本地：已在播放的房间同步改用新音量。
  useEffect(() => {
    const reload = () => setVolumeState(readSavedVolume());
    return onPreferencesApplied(reload);
  }, []);

  const [audioPlaybackState, setAudioPlaybackState] = useState<"idle" | "playing" | "completed">(
    "idle"
  );
  const [audioRetryToken, setAudioRetryToken] = useState(0);

  // 一次装载 = 同一回合、同一地址、同一段起止、同一次重试。
  const sourceKey =
    currentPhaseRoundNumber === undefined || !currentAudioUrl || currentClipStartTime === undefined
      ? null
      : `${roomId}:${phase}:${currentPhaseRoundNumber}:${currentAudioUrl}`;
  const loadKey =
    sourceKey && `${sourceKey}:${currentClipStartTime}:${currentClipEndTime}:${audioRetryToken}`;
  // 段落 = 同一回合、同一段起止，不含地址：同一段里换地址只会是玩家换了音质，从换档前的进度接着放。
  const segmentKey =
    sourceKey &&
    `${roomId}:${phase}:${currentPhaseRoundNumber}:${currentClipStartTime}:${currentClipEndTime}`;
  const statusKey = segmentKey && `${segmentKey}:${audioRetryToken}`;
  // 状态记在「段落 + 重试」名下：换回合、换段或重试的那一帧，Effect 还没把状态重置成加载中，
  // 上一次的「就绪」不能冒充这一次，否则歌词会先于这一段音频露面。同一段里换音质不算换段，
  // 状态沿用，不闪回加载中。
  const [audioState, setAudioState] = useState<{ key: string | null; status: ClipAudioStatus }>({
    key: null,
    status: "loading",
  });
  const audioStatus: ClipAudioStatus = audioState.key === statusKey ? audioState.status : "loading";

  const audioRef = useRef<HTMLAudioElement>(null);
  const audioReadyKey = useRef<string | null>(null);
  const audioAutoPlayKey = useRef<string | null>(null);
  const loadedAudioUrlRef = useRef<string | null>(null);
  const handledRetryTokenRef = useRef(0);
  const audioFailureKey = useRef<string | null>(null);
  const autoReloads = useRef({ key: "", count: 0 });
  const sendCommandRef = useRef(sendCommand);
  const onSourceErrorRef = useRef(onSourceError);
  const volumeRef = useRef(volume);
  const playbackStateRef = useRef<"idle" | "playing" | "completed">("idle");
  const carryOverRef = useRef<PlaybackCarryOver | null>(null);

  useEffect(() => {
    sendCommandRef.current = sendCommand;
  }, [sendCommand]);

  useEffect(() => {
    onSourceErrorRef.current = onSourceError;
  }, [onSourceError]);

  useEffect(() => {
    playbackStateRef.current = audioPlaybackState;
  }, [audioPlaybackState]);

  useEffect(() => {
    volumeRef.current = volume;
    try {
      const value = String(volume);
      if (window.localStorage.getItem(SONG_VOLUME_KEY) !== value) {
        window.localStorage.setItem(SONG_VOLUME_KEY, value);
        notifyPreferencesChanged();
      }
    } catch {
      // 忽略沙箱本地存储异常
    }
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  const setVolume = useCallback((val: number) => {
    setVolumeState(Math.max(0, Math.min(1, val)));
  }, []);

  const retryAudio = useCallback(() => {
    setAudioRetryToken((t) => t + 1);
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (
      !audio ||
      !sourceKey ||
      !loadKey ||
      !segmentKey ||
      !statusKey ||
      currentPhaseRoundNumber === undefined ||
      !currentAudioUrl ||
      currentClipStartTime === undefined
    ) {
      if (audio) {
        audio.pause();
        loadedAudioUrlRef.current = null;
      }
      return;
    }
    const setAudioStatus = (status: ClipAudioStatus) => setAudioState({ key: statusKey, status });
    // 「已就绪」按段落记：同一段里换了音质不再重复上报，换段或手动重试照常上报。
    const readyKey = statusKey;
    // 自动重载的次数按「同一回合同一个地址」计：换回合或换地址重新数。
    if (autoReloads.current.key !== sourceKey) autoReloads.current = { key: sourceKey, count: 0 };
    const carried = carryOverRef.current;
    carryOverRef.current = null;
    const carryOver =
      carried && carried.segmentKey === segmentKey && carried.url !== currentAudioUrl
        ? carried
        : null;
    // 同一段里换音质：歌词与按钮维持原样，新地址就绪后接着放；从头装载才回到加载中。
    if (!carryOver) {
      setAudioStatus("loading");
      setAudioPlaybackState("idle");
    }
    audio.volume = volumeRef.current;
    const startSeconds = currentClipStartTime / 1_000;
    const endSeconds = currentClipEndTime !== undefined ? currentClipEndTime / 1_000 : undefined;
    const resumeSeconds =
      carryOver &&
      carryOver.time > startSeconds &&
      (endSeconds === undefined || carryOver.time < endSeconds)
        ? carryOver.time
        : undefined;

    const envelope = createClipEnvelope(
      () => audio,
      () => volumeRef.current,
      () => ({ startSeconds, endSeconds })
    );

    const startFadeLoop = () => {
      envelope.apply();
      envelope.start(() => {
        if (audio.paused || audio.ended) return false;
        envelope.apply();
        return true;
      });
    };

    const stopFadeLoop = () => {
      envelope.stop();
      audio.volume = volumeRef.current;
    };

    let resumePending = resumeSeconds !== undefined;
    const moveToStart = () => {
      // 换音质接着放：第一次定位到换档前的进度，之后的回绕照旧回到片段起点。
      const target = resumePending && resumeSeconds !== undefined ? resumeSeconds : startSeconds;
      if (Math.abs(audio.currentTime - target) > 0.15) audio.currentTime = target;
      audio.volume = envelope.volumeAt(target);
    };
    const stopAtEnd = () => {
      if (endSeconds !== undefined && audio.currentTime >= endSeconds) {
        stopFadeLoop();
        audio.pause();
        audio.currentTime = startSeconds;
        setAudioPlaybackState("completed");
      } else if (endSeconds !== undefined) {
        envelope.apply();
      }
    };
    const keepPlaybackInClip = () => {
      if (
        audio.currentTime < startSeconds - 0.25 ||
        (endSeconds !== undefined && audio.currentTime >= endSeconds)
      ) {
        audio.currentTime = startSeconds;
      }
    };
    let readyState = false;
    let disposed = false;
    const ready = () => {
      // 每次装载只就绪一次：弱网下播到一半卡住、缓冲回来会再报 canplay，不能因此把进度拽回起点
      // （换音质接着放时，也不能被拽回片段起点）。
      if (disposed || readyState) return;
      moveToStart();
      // 刚发起跳转或起点的数据还不够播：等 seeked / canplay 再来，期间保持加载中。
      if (!playableAtClipStart(audio)) return;
      readyState = true;
      setAudioStatus("ready");
      const state = useSonGuessrStore.getState();
      const currentPrivateState = state.privateState;
      const currentSnapshot = state.snapshot;
      const currentPlayer = currentSnapshot?.players.find(
        (player) => player.id === currentPrivateState?.playerId
      );
      if (
        isPlayingPhase &&
        currentPrivateState &&
        !(currentPrivateState.isSubmitter && !currentSnapshot?.testMode) &&
        currentPlayer?.membership === "active" &&
        audioReadyKey.current !== readyKey
      ) {
        audioReadyKey.current = readyKey;
        void Promise.resolve(
          sendCommandRef.current("song.game.audioReady", { roundNumber: currentPhaseRoundNumber })
        ).catch(() => {
          if (audioReadyKey.current === readyKey) audioReadyKey.current = null;
        });
      }

      // 加载完成后自动播放；浏览器禁止自动播放时保留小型播放按钮作为后备。
      // 换音质接着放时只在换档前正在放才继续放，放完了的停在「已放完」。
      if (audioAutoPlayKey.current !== loadKey) {
        audioAutoPlayKey.current = loadKey;
        moveToStart();
        resumePending = false;
        if (carryOver && !carryOver.playing) {
          if (carryOver.completed) setAudioPlaybackState("completed");
          return;
        }
        void Promise.resolve(audio.play()).catch(() => {
          if (!disposed) setAudioPlaybackState("idle");
        });
      }
    };
    const failed = () => {
      if (disposed) return;
      // 就绪之后的出错同样作数：拉后续数据失败或解码出错时元素已经停摆，不转失败态就一直停在
      // 「播放中」，既不上报刷新地址，也不给重试按钮。只有网络错误且整段片段已缓冲时例外：
      // 网络错误只是拉不到后面的数据，已缓冲的部分照常能播完这一题；解码错误会让播放管线
      // 停下，缓冲区再完整也播不了。
      if (
        readyState &&
        audio.error?.code === MEDIA_ERR_NETWORK &&
        clipFullyBuffered(audio, startSeconds, endSeconds)
      ) {
        return;
      }
      stopFadeLoop();
      // 自选音质那一档放不出来：调用方换回默认档，这次不算默认地址失效。
      // 3 = MEDIA_ERR_DECODE，4 = MEDIA_ERR_SRC_NOT_SUPPORTED（不依赖全局 MediaError，测试环境没有它）。
      const code = audio.error?.code;
      const decode = code === 3 || code === 4;
      if (onSourceErrorRef.current?.(currentAudioUrl, decode)) return;
      audio.pause();
      setAudioPlaybackState("idle");
      setAudioStatus("error");
      if (
        audioFailureKey.current !== loadKey &&
        isPlayingPhase &&
        currentPhaseRoundNumber !== undefined
      ) {
        audioFailureKey.current = loadKey;
        void Promise.resolve(
          sendCommandRef.current("song.game.audioFailed", { roundNumber: currentPhaseRoundNumber })
        ).then(
          (ack) => {
            // 服务端只换了保存的上游地址，快照里的站内地址不变：重新请求同一个地址才能拿到新的。
            // 回来之前换了回合、换了地址或已卸载（disposed）就不再为旧的这一次重载。
            if (disposed || ack?.refreshed !== true) return;
            if (autoReloads.current.count >= MAX_AUTO_RELOADS) return;
            autoReloads.current.count += 1;
            setAudioRetryToken((token) => token + 1);
          },
          () => {
            if (audioFailureKey.current === loadKey) audioFailureKey.current = null;
          }
        );
      }
    };
    const playing = () => {
      startFadeLoop();
      setAudioPlaybackState("playing");
    };
    const completed = () => {
      stopFadeLoop();
      audio.currentTime = startSeconds;
      setAudioPlaybackState("completed");
    };

    audio.addEventListener("loadedmetadata", moveToStart);
    audio.addEventListener("timeupdate", stopAtEnd);
    audio.addEventListener("play", keepPlaybackInClip);
    audio.addEventListener("play", playing);
    audio.addEventListener("pause", stopFadeLoop);
    audio.addEventListener("ended", completed);
    audio.addEventListener("canplay", ready);
    audio.addEventListener("canplaythrough", ready);
    audio.addEventListener("loadeddata", ready);
    audio.addEventListener("seeked", ready);
    audio.addEventListener("suspend", ready);
    audio.addEventListener("error", failed);
    // 失败后元素停在无可用源状态，src 没变就不会重新加载；重试必须强制重设 src 并 load()。
    if (handledRetryTokenRef.current !== audioRetryToken) {
      handledRetryTokenRef.current = audioRetryToken;
      loadedAudioUrlRef.current = null;
    }
    if (loadedAudioUrlRef.current !== currentAudioUrl) {
      loadedAudioUrlRef.current = currentAudioUrl;
      audio.src = currentAudioUrl;
      audio.load();
    }
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) moveToStart();
    if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) ready();
    // 片段起点迟迟不能播就转失败态，给玩家重试按钮；数据之后才到时 ready 仍会接手。
    const loadTimeout = window.setTimeout(() => {
      if (!disposed && !readyState) {
        // 自选的那一档迟迟放不起来（文件大、网慢）：先换回默认档，而不是停在失败态。
        if (onSourceErrorRef.current?.(currentAudioUrl, false)) return;
        setAudioStatus("error");
      }
    }, 15_000);
    return () => {
      disposed = true;
      window.clearTimeout(loadTimeout);
      // 记下卸载前的进度：下一次只换了地址（同一段换音质）就从这里接着放。
      if (readyState) {
        carryOverRef.current = {
          segmentKey,
          url: currentAudioUrl,
          time: audio.currentTime,
          playing: !audio.paused && !audio.ended,
          completed: playbackStateRef.current === "completed",
        };
      }
      stopFadeLoop();
      audio.pause();
      audio.removeEventListener("loadedmetadata", moveToStart);
      audio.removeEventListener("timeupdate", stopAtEnd);
      audio.removeEventListener("play", keepPlaybackInClip);
      audio.removeEventListener("play", playing);
      audio.removeEventListener("pause", stopFadeLoop);
      audio.removeEventListener("ended", completed);
      audio.removeEventListener("canplay", ready);
      audio.removeEventListener("canplaythrough", ready);
      audio.removeEventListener("loadeddata", ready);
      audio.removeEventListener("seeked", ready);
      audio.removeEventListener("suspend", ready);
      audio.removeEventListener("error", failed);
    };
  }, [
    audioRetryToken,
    currentAudioUrl,
    currentClipEndTime,
    currentClipStartTime,
    currentPhaseRoundNumber,
    isPlayingPhase,
    loadKey,
    segmentKey,
    sourceKey,
    statusKey,
  ]);

  useEffect(() => {
    const syncAudioOnActive = () => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.volume = volumeRef.current;
      if (audioPlaybackState === "completed" || audioPlaybackState === "idle") {
        audio.pause();
      }
    };
    document.addEventListener("visibilitychange", syncAudioOnActive);
    window.addEventListener("focus", syncAudioOnActive);
    return () => {
      document.removeEventListener("visibilitychange", syncAudioOnActive);
      window.removeEventListener("focus", syncAudioOnActive);
    };
  }, [audioPlaybackState, audioStatus]);

  const playAudio = useCallback(async () => {
    const audio = audioRef.current;
    if (
      !audio ||
      audioStatus !== "ready" ||
      audioPlaybackState === "playing" ||
      currentClipStartTime === undefined
    )
      return;
    const startSeconds = currentClipStartTime / 1_000;
    const endSeconds = currentClipEndTime !== undefined ? currentClipEndTime / 1_000 : undefined;
    if (
      audio.currentTime < startSeconds - 0.25 ||
      (endSeconds !== undefined && audio.currentTime >= endSeconds)
    ) {
      audio.currentTime = startSeconds;
    }
    if (Math.abs(audio.currentTime - startSeconds) < 0.15) {
      audio.volume = 0;
    } else {
      audio.volume = volumeRef.current;
    }
    try {
      await audio.play();
    } catch {
      setAudioPlaybackState("idle");
    }
  }, [audioPlaybackState, audioStatus, currentClipEndTime, currentClipStartTime]);

  // 地址还在路上：本回合的歌还没开始加载，读作「加载中」，而不是停在上一回合的状态。
  const waitingForSource = sourcePending && currentPhaseRoundNumber !== undefined;
  return {
    audioRef,
    volume,
    setVolume,
    audioStatus: waitingForSource ? ("loading" as const) : audioStatus,
    audioPlaybackState: waitingForSource ? ("idle" as const) : audioPlaybackState,
    playAudio,
    retryAudio,
  };
}
