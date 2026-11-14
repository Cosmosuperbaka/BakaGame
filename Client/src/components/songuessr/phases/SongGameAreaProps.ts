import type { RefObject } from "react";
import type { SongRunCommand } from "@/components/songuessr/UseSongRoom";
import type {
  SongClipRange,
  SonGuessrPlayerView,
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
} from "@bakagame/shared";

export interface SongGameAreaProps {
  snapshot: SonGuessrRoomSnapshot;
  privateState: SonGuessrPrivateState;
  me?: SonGuessrPlayerView;
  isHost: boolean;
  guessDeadlineAt?: number | null;
  volume: number;
  onVolumeChange: (value: number) => void;
  audioStatus: "loading" | "ready" | "error";
  audioPlaybackState: "idle" | "playing" | "completed";
  onPlayAudio: () => void;
  onRetryAudio: () => void;
  onSelectSearchSong: (
    songId: string,
    mode: "submit" | "guess",
    extraId?: string,
    clip?: SongClipRange,
    /** 聚合检索给出的备用音源与会员标记，随出题请求回传给服务端做兜底。 */
    pick?: { sources?: string[]; requiresVip?: boolean }
  ) => Promise<void>;
  run: SongRunCommand;
  isPending?: (type: string) => boolean;
  audioRef?: RefObject<HTMLAudioElement | null>;
}
