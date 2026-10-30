import type { RandomSource } from "../../domain/Rules";
import type {
  BangumiMusicTrack,
  BangumiSubjectDetails,
  ConnectionRecord,
  SongDetails,
  SongLyricClip,
} from "../../shared/Index";
import type { ConnectionRegistry } from "../ConnectionRegistry";
import type { McpSeatRegistry } from "../McpSeatRegistry";
import type { SonGuessrServiceOptions } from "../SonGuessrService";
import type {
  SonGuessrPlayerRecord,
  SonGuessrRoomRecord,
  SonGuessrRoundPlayerState,
} from "./Records";

/**
 * SonGuessrService 拆出的子系统自由函数所需的成员面。
 *
 * 这些成员在 SonGuessrService 上去掉 `private` 以满足本接口，属包内 internal 约定：
 * 只允许 `Server/src/application/songuessr/` 下的自由函数通过 service 参数访问，
 * 不视作对外公开 API；状态字段的所有权仍在 SonGuessrService，自由函数只借用。
 */
export interface SonGuessrServiceInternals {
  readonly rooms: Map<string, SonGuessrRoomRecord>;
  readonly connections: ConnectionRegistry;
  readonly options: SonGuessrServiceOptions;
  readonly now: () => number;
  readonly random: RandomSource;
  /** MCP 座位配对与控制器：进程内状态，重启即失效。 */
  readonly mcpSeats: McpSeatRegistry;
  /** 每个房间在等号的请求；租约归还或池子变化时唤醒。 */
  readonly musicPoolWaiters: Map<string, Set<() => void>>;
  nextMusicRefreshSweepAt: number;
  musicRefreshSweepInFlight: boolean;

  requireRoomPlayer(connection: ConnectionRecord): {
    room: SonGuessrRoomRecord;
    player: SonGuessrPlayerRecord;
  };
  parsePlaylistId(value: string): string;
  installRound(
    room: SonGuessrRoomRecord,
    song: SongDetails,
    submitterPlayerId: string,
    anime?: BangumiSubjectDetails,
    animeTrack?: BangumiMusicTrack,
    recentSongWindow?: number,
    lyricClipOverride?: SongLyricClip
  ): number;
  ensureRoundPlayerState(
    room: SonGuessrRoomRecord,
    player: SonGuessrPlayerRecord
  ): SonGuessrRoundPlayerState | undefined;
  submitterCandidates(room: SonGuessrRoomRecord): SonGuessrPlayerRecord[];
  canTestSubmitterGuess(room: SonGuessrRoomRecord, playerId: string): boolean;
  activePlayers(room: SonGuessrRoomRecord): SonGuessrPlayerRecord[];
  touch(room: SonGuessrRoomRecord): void;
  publishRoom(room: SonGuessrRoomRecord, targetConnection?: ConnectionRecord): void;
  publishLobby(): void;
  log(type: string, roomId?: string, playerId?: string, payload?: unknown): void;
  isTestRoom(room: SonGuessrRoomRecord): boolean;
}
