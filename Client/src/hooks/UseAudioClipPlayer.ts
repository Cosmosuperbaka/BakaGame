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
}: AudioClipPlayerOptions) {
  const [volume, setVolumeState] = useState(readSavedVolume);

  // 登录后云端音量写回本地：已在播放的房间同步改用新音量。
  useEffect(() => {
    const reload = () => setVolumeState(readSavedVolume());
    return onPreferencesApplied(reload);
  }, []);

  const [audioStatus, setAudioStatus] = useState<"loading" | "ready" | "error">("loading");
  const [audioPlaybackState, setAudioPlaybackState] = useState<"idle" | "playing" | "completed">(
    "idle"
  );
  const [audioRetryToken, setAudioRetryToken] = useState(0);

  const audioRef = useRef<HTMLAudioElement>(null);
  const audioReadyKey = useRef<string | null>(null);
  const audioAutoPlayKey = useRef<string | null>(null);
  const loadedAudioUrlRef = useRef<string | null>(null);
  const handledRetryTokenRef = useRef(0);
  const audioFailureKey = useRef<string | null>(null);
  const autoReloads = useRef({ key: "", count: 0 });
  const sendCommandRef = useRef(sendCommand);
  const volumeRef = useRef(volume);

  useEffect(() => {
    sendCommandRef.current = sendCommand;
  }, [sendCommand]);

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
    const sourceKey = `${roomId}:${phase}:${currentPhaseRoundNumber}:${currentAudioUrl}`;
    const loadKey = `${sourceKey}:${currentClipStartTime}:${currentClipEndTime}:${audioRetryToken}`;
    // 自动重载的次数按「同一回合同一个地址」计：换回合或换地址重新数。
    if (autoReloads.current.key !== sourceKey) autoReloads.current = { key: sourceKey, count: 0 };
    setAudioStatus("loading");
    setAudioPlaybackState("idle");
    audio.volume = volumeRef.current;
    const startSeconds = currentClipStartTime / 1_000;
    const endSeconds = currentClipEndTime !== undefined ? currentClipEndTime / 1_000 : undefined;

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

    const moveToStart = () => {
      if (Math.abs(audio.currentTime - startSeconds) > 0.15) audio.currentTime = startSeconds;
      audio.volume = envelope.volumeAt(startSeconds);
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
      if (disposed) return;
      moveToStart();
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
        audioReadyKey.current !== loadKey
      ) {
        audioReadyKey.current = loadKey;
        void Promise.resolve(
          sendCommandRef.current("song.game.audioReady", { roundNumber: currentPhaseRoundNumber })
        ).catch(() => {
          if (audioReadyKey.current === loadKey) audioReadyKey.current = null;
        });
      }

      // 加载完成后自动播放；浏览器禁止自动播放时保留小型播放按钮作为后备。
      if (audioAutoPlayKey.current !== loadKey) {
        audioAutoPlayKey.current = loadKey;
        moveToStart();
        void Promise.resolve(audio.play()).catch(() => {
          if (!disposed) setAudioPlaybackState("idle");
        });
      }
    };
    const failed = () => {
      if (disposed || readyState) return;
      stopFadeLoop();
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
    const loadTimeout = window.setTimeout(() => {
      if (!disposed && !readyState && audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        setAudioStatus("error");
      }
    }, 15_000);
    return () => {
      disposed = true;
      window.clearTimeout(loadTimeout);
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
      audio.removeEventListener("error", failed);
    };
  }, [
    audioRetryToken,
    currentAudioUrl,
    currentClipEndTime,
    currentClipStartTime,
    currentPhaseRoundNumber,
    isPlayingPhase,
    roomId,
    phase,
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

  return {
    audioRef,
    volume,
    setVolume,
    audioStatus,
    audioPlaybackState,
    playAudio,
    retryAudio,
  };
}
