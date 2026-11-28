import { useCallback, useEffect, useState } from "react";
import type {
  SonGuessrAudioQualityAck,
  SongAudioQuality,
  SongAudioQualityPreference,
} from "@bakagame/shared";
import type { GameSendCommand } from "@/lib/GameWs";
import { onPreferencesApplied } from "@/lib/PreferenceBus";
import type { SonGuessrCommandMap } from "@/lib/SonGuessrWs";
import {
  canDecodeFormat,
  canDecodeQuality,
  readSavedAudioQuality,
  saveAudioQuality,
} from "@/lib/SongAudioQuality";

/** 等服务端回执的上限：超时就先用默认档开播，不让一档音质拖住整回合。 */
export const AUDIO_QUALITY_ACK_TIMEOUT_MS = 6_000;

/**
 * 本回合音质的状态，给音量条上的选单读：
 * - `default`：用的是装题时取好的默认档（选了「自动」，或现在没有在放的歌）；
 * - `resolving`：正在向服务端要选中的那一档；
 * - `ready`：拿到了，`actual` 是实际档位（上游可能降档）；
 * - `fallback`：这一档本回合用不上，正在放默认档。`unavailable` 是这首歌在本房拿不到，
 *   `unsupported` 是这台设备解不了，`failed` 是请求失败、超时或那一档放不出来。
 */
export type SongAudioQualityState =
  | { kind: "default" }
  | { kind: "resolving"; requested: SongAudioQuality }
  | { kind: "ready"; requested: SongAudioQuality; actual: SongAudioQuality; format?: string }
  | {
      kind: "fallback";
      requested: SongAudioQuality;
      reason: "unavailable" | "unsupported" | "failed";
    };

type Resolution =
  | { key: string; kind: "ready"; url: string; actual: SongAudioQuality; format?: string }
  | { key: string; kind: "fallback"; reason: "unavailable" | "unsupported" | "failed" };

export interface SongAudioQualityOptions {
  roomId: string;
  /** 现在该放的那一段属于第几回合；猜题与结算同一回合，共用同一档。 */
  roundNumber?: number;
  /** 快照里的站内播放地址（默认档）。没有就是现在没有歌要放。 */
  ticketUrl?: string;
  sendCommand: GameSendCommand<SonGuessrCommandMap>;
}

/**
 * 玩家自选的播放音质：记住偏好（随云同步），每回合按偏好向服务端要那一档的站内地址，
 * 交给播放器的是「现在该加载的地址」。
 *
 * - 回合开头还没有任何地址时，等回执再加载（`pending`），免得先下一遍默认档再换；回执超时、
 *   失败或这首歌没有这一档，都回到默认档，不让播放卡住。
 * - 回合中途换档时，新档到手之前继续放当前那一档，不停下来。
 * - 这一档放不出来（`reportSourceError`）就回到默认档；格式解不了的档本次打开页面内不再请求。
 */
export function useSongAudioQuality({
  roomId,
  roundNumber,
  ticketUrl,
  sendCommand,
}: SongAudioQualityOptions) {
  const [preference, setPreferenceState] = useState(readSavedAudioQuality);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [unsupported, setUnsupported] = useState<ReadonlySet<SongAudioQuality>>(() => new Set());
  const [holdover, setHoldover] = useState<{ roundKey: string; url: string } | null>(null);

  // 登录后云端偏好写回本地：已在房间里的页面同步改用新偏好。
  useEffect(() => onPreferencesApplied(() => setPreferenceState(readSavedAudioQuality())), []);

  const roundKey =
    ticketUrl && roundNumber !== undefined ? `${roomId}:${roundNumber}:${ticketUrl}` : null;
  const requested = preference === "auto" ? undefined : preference;
  const deviceUnsupported =
    requested !== undefined && (unsupported.has(requested) || !canDecodeQuality(requested));
  const requestKey =
    roundKey && requested && !deviceUnsupported ? `${roundKey}:${requested}` : null;
  const result = resolution && resolution.key === requestKey ? resolution : undefined;

  useEffect(() => {
    if (!requestKey || !requested || roundNumber === undefined) return;
    let settled = false;
    const settle = (next: Resolution) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      setResolution(next);
    };
    const timer = window.setTimeout(
      () => settle({ key: requestKey, kind: "fallback", reason: "failed" }),
      AUDIO_QUALITY_ACK_TIMEOUT_MS
    );
    Promise.resolve(
      sendCommand("song.game.audioQuality", { roundNumber, quality: requested })
    ).then(
      (ack: SonGuessrAudioQualityAck | undefined) => {
        if (!ack?.audioUrl || !ack.quality) {
          settle({ key: requestKey, kind: "fallback", reason: "unavailable" });
          return;
        }
        if (!canDecodeFormat(ack.quality, ack.format)) {
          if (settled) return;
          settle({ key: requestKey, kind: "fallback", reason: "unsupported" });
          setUnsupported((current) => new Set(current).add(requested));
          return;
        }
        settle({
          key: requestKey,
          kind: "ready",
          url: ack.audioUrl,
          actual: ack.quality,
          ...(ack.format ? { format: ack.format } : {}),
        });
      },
      () => settle({ key: requestKey, kind: "fallback", reason: "failed" })
    );
    return () => {
      settled = true;
      window.clearTimeout(timer);
    };
  }, [requestKey, requested, roundNumber, sendCommand]);

  let audioUrl: string | undefined = ticketUrl;
  let pending = false;
  let state: SongAudioQualityState = { kind: "default" };
  if (requested && roundKey) {
    if (deviceUnsupported) {
      state = { kind: "fallback", requested, reason: "unsupported" };
    } else if (!result) {
      state = { kind: "resolving", requested };
      // 回合中途换档：新档到手之前接着放手上这一档；回合开头没有可放的就等回执。
      audioUrl = holdover?.roundKey === roundKey ? holdover.url : undefined;
      pending = audioUrl === undefined;
    } else if (result.kind === "ready") {
      state = { kind: "ready", requested, actual: result.actual, format: result.format };
      audioUrl = result.url;
    } else {
      state = { kind: "fallback", requested, reason: result.reason };
    }
  }

  const setPreference = useCallback(
    (value: SongAudioQualityPreference) => {
      if (roundKey && audioUrl) setHoldover({ roundKey, url: audioUrl });
      saveAudioQuality(value);
      setPreferenceState(value);
    },
    [audioUrl, roundKey]
  );

  /**
   * 播放器报告某个地址放不出来。是本回合换上的那一档就回到默认档并返回 true，
   * 播放器据此不把它当成默认地址失效去上报；`decode` 为真时这一档本次打开页面内不再请求。
   */
  const reportSourceError = useCallback(
    (url: string, decode = false): boolean => {
      if (!requestKey || !requested || result?.kind !== "ready" || result.url !== url) {
        return false;
      }
      setResolution({ key: requestKey, kind: "fallback", reason: "failed" });
      if (decode) setUnsupported((current) => new Set(current).add(requested));
      return true;
    },
    [requestKey, requested, result]
  );

  return { preference, setPreference, state, audioUrl, pending, reportSourceError };
}
