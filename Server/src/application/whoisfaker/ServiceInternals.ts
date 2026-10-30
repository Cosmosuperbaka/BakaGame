import type {
  ConnectionRecord,
  GameRound,
  WhoIsFakerPlayerRecord,
  WhoIsFakerRoomRecord,
  WhoIsFakerRoomSnapshot,
} from "../../shared/Index";
import type { RandomSource } from "../../domain/Rules";
import type { LogEntry } from "../../infrastructure/EventLogger";
import type { ConnectionRegistry } from "../ConnectionRegistry";
import type { LobbyFanout } from "../LobbyFanout";
import type { McpSeatRegistry } from "../McpSeatRegistry";
import type { WhoIsFakerServiceOptions } from "../WhoIsFakerService";

/**
 * WhoIsFakerService 拆出的子系统自由函数所需的成员面。
 *
 * 这些成员在 WhoIsFakerService 上去掉 `private` 以满足本接口，属包内 internal 约定：
 * 只允许 `Server/src/application/whoisfaker/` 下的自由函数通过 service 参数访问，
 * 不视作对外公开 API；状态字段的所有权仍在 WhoIsFakerService，自由函数只借用。
 */
export interface WhoIsFakerServiceInternals {
  readonly rooms: Map<string, WhoIsFakerRoomRecord>;
  readonly connectionRegistry: ConnectionRegistry;
  /** MCP 座位配对与控制器：进程内状态，重启即失效。 */
  readonly mcpSeats: McpSeatRegistry;
  /** 大厅列表的唯一出口：合并窗内的多次变更并为一次全量下发，订阅者单独取当前列表。 */
  readonly lobbyFanout: LobbyFanout;
  readonly options: WhoIsFakerServiceOptions;
  readonly now: () => number;
  readonly random: RandomSource;
  readonly phaseTimerTimeoutByRoomId: Map<string, ReturnType<typeof setTimeout>>;
  readonly publishedPhaseKeyByRoomId: Map<string, string>;
  readonly gameOverAdvanceAllowedAtByRoomId: Map<string, number>;
  /** 对局记录用的开局时间，按回合 ID 索引；结算或删房时移除。 */
  readonly roundStartedAtById: Map<string, number>;

  requireRoomPlayer(connection: ConnectionRecord): {
    room: WhoIsFakerRoomRecord;
    player: WhoIsFakerPlayerRecord;
  };
  requireRound(room: WhoIsFakerRoomRecord): GameRound;
  ensureHost(room: WhoIsFakerRoomRecord, playerId: string): void;
  ensureQuestioner(round: GameRound, playerId: string): void;
  isRoundActive(room: WhoIsFakerRoomRecord): boolean;
  getPhaseNoticeKey(snapshot: WhoIsFakerRoomSnapshot): string;
  describePhaseChange(snapshot: WhoIsFakerRoomSnapshot, room: WhoIsFakerRoomRecord): string;
  getConnectionByPlayer(playerId: string): ConnectionRecord | undefined;
  reassignHost(room: WhoIsFakerRoomRecord): void;
  createPlayer(name: string, isBot: boolean, isAgent?: boolean): WhoIsFakerPlayerRecord;
  createId(prefix: string): string;
  appendSystemMessage(room: WhoIsFakerRoomRecord, text: string): void;
  touchRoom(room: WhoIsFakerRoomRecord): void;
  log(entry: LogEntry): Promise<void>;
  closeRoom(room: WhoIsFakerRoomRecord, reason: string): Promise<void>;
  completeSupplementIfReady(room: WhoIsFakerRoomRecord): boolean;
  maybeAbortRoundAfterRosterChange(room: WhoIsFakerRoomRecord): Promise<void>;
}
