import { useCallback, useEffect, useRef, useState } from "react";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";

const SONG_VOLUME_KEY = "songuessr_volume";

export interface AudioClipPlayerOptions {
  roomId: string;
  phase?: string;
  currentPhaseRoundNumber?: number;
  currentAudioUrl?: string;
  currentClipStartTime?: number;
  currentClipEndTime?: number;
  isPlayingPhase: boolean;
  sendCommand: (type: string, payload?: Record<string, unknown>) => Promise<unknown>;
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
  const [volume, setVolumeState] = useState(() => {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        const saved = Number(window.localStorage.getItem(SONG_VOLUME_KEY));
        return Number.isFinite(saved) ? Math.max(0, Math.min(1, saved)) : 0.65;
      }
    } catch {
      // 忽略 SSR 或浏览器隐身沙箱异常
    }
    return 0.65;
  });

  const [audioStatus, setAudioStatus] = useState<"loading" | "ready" | "error">("loading");
  const [audioPlaybackState, setAudioPlaybackState] = useState<"idle" | "playing" | "completed">("idle");
  const [audioRetryToken, setAudioRetryToken] = useState(0);

  const audioRef = useRef<HTMLAudioElement>(null);
  const audioReadyKey = useRef<string | null>(null);
  const audioAutoPlayKey = useRef<string | null>(null);
  const loadedAudioUrlRef = useRef<string | null>(null);
  const audioFailureKey = useRef<string | null>(null);
  const sendCommandRef = useRef(sendCommand);
  const volumeRef = useRef(volume);

  useEffect(() => {
    sendCommandRef.current = sendCommand;
  }, [sendCommand]);

  useEffect(() => {
    volumeRef.current = volume;
    try {
      window.localStorage.setItem(SONG_VOLUME_KEY, String(volume));
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
    const loadKey = `${roomId}:${phase}:${currentPhaseRoundNumber}:${currentAudioUrl}:${currentClipStartTime}:${currentClipEndTime}:${audioRetryToken}`;
    setAudioStatus("loading");
    setAudioPlaybackState("idle");
    audio.volume = volumeRef.current;
    const startSeconds = currentClipStartTime / 1_000;
    const endSeconds = currentClipEndTime !== undefined ? currentClipEndTime / 1_000 : undefined;

    const computeFadeFactor = (currentTime: number): number => {
      if (endSeconds === undefined) return 1;
      const clipDuration = Math.max(0.1, endSeconds - startSeconds);
      const fadeDuration = Math.min(1.0, clipDuration / 2);

      const elapsed = currentTime - startSeconds;
      const remaining = endSeconds - currentTime;

      if (elapsed <= 0 || remaining <= 0) return 0;

      const fadeIn = Math.max(0, Math.min(1, elapsed / fadeDuration));
      const fadeOut = Math.max(0, Math.min(1, remaining / fadeDuration));

      return Math.min(fadeIn, fadeOut);
    };

    let fadeRafId: number | null = null;
    const updateAudioFade = () => {
      if (!audio.paused && !audio.ended) {
        const factor = computeFadeFactor(audio.currentTime);
        audio.volume = Math.max(0, Math.min(1, volumeRef.current * factor));
        fadeRafId = requestAnimationFrame(updateAudioFade);
      }
    };

    const startFadeLoop = () => {
      if (fadeRafId !== null) cancelAnimationFrame(fadeRafId);
      const factor = computeFadeFactor(audio.currentTime);
      audio.volume = Math.max(0, Math.min(1, volumeRef.current * factor));
      fadeRafId = requestAnimationFrame(updateAudioFade);
    };

    const stopFadeLoop = () => {
      if (fadeRafId !== null) {
        cancelAnimationFrame(fadeRafId);
        fadeRafId = null;
      }
      audio.volume = volumeRef.current;
    };

    const moveToStart = () => {
      if (Math.abs(audio.currentTime - startSeconds) > 0.15) audio.currentTime = startSeconds;
      audio.volume = Math.max(0, Math.min(1, volumeRef.current * computeFadeFactor(startSeconds)));
    };
    const stopAtEnd = () => {
      if (endSeconds !== undefined && audio.currentTime >= endSeconds) {
        stopFadeLoop();
        audio.pause();
        audio.currentTime = startSeconds;
        setAudioPlaybackState("completed");
      } else if (endSeconds !== undefined) {
        const factor = computeFadeFactor(audio.currentTime);
        audio.volume = Math.max(0, Math.min(1, volumeRef.current * factor));
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
        (player) => player.id === currentPrivateState?.playerId,
      );
      if (
        isPlayingPhase &&
        currentPrivateState &&
        !(currentPrivateState.isSubmitter && !currentSnapshot?.testMode) &&
        currentPlayer?.membership === "active" &&
        audioReadyKey.current !== loadKey
      ) {
        audioReadyKey.current = loadKey;
        void Promise.resolve(sendCommandRef.current("song.game.audioReady", { roundNumber: currentPhaseRoundNumber })).catch(() => {
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
      if (audioFailureKey.current !== loadKey && isPlayingPhase && currentPhaseRoundNumber !== undefined) {
        audioFailureKey.current = loadKey;
        void Promise.resolve(sendCommandRef.current("song.game.audioFailed", { roundNumber: currentPhaseRoundNumber })).catch(() => {
          if (audioFailureKey.current === loadKey) audioFailureKey.current = null;
        });
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
    ) return;
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
