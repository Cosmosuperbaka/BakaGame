import type { ChatMessage, PlayerAccount, RoomVisibility } from "../../shared/Model";
import type { GameId } from "../../shared/Protocol";
import type { GameRecorder } from "../../domain/GameRecord";
import type { RandomSource } from "../../domain/Rules";
import type { TestRoomPolicy } from "../../domain/TestRooms";
import type { ConnectionRegistry } from "../ConnectionRegistry";
import type { LobbyFanout } from "../LobbyFanout";
import type { RoomIdReservations } from "./RoomIdReservations";

/**
 * 公共房间内核的类型底座。
 *
 * 内核是一组部件而不是基类：三款服务各自持有房间表、各自编排，内核只认识下面这几组
 * 通用字段。三款的玩家与房间记录以结构兼容的方式满足它们（不继承），玩法字段与通用字段
 * 留在同一个记录对象里，快照仍是整房落盘。
 */

/** 内核读写的座位字段。 */
export interface SeatCore {
  id: string;
  sessionToken: string;
  name: string;
  /** 三款取值的并集；内核只识别 "active"、"spectator"、"kicked" 三个字面量。 */
  membership: string;
  online: boolean;
  isBot?: boolean;
  isAgent?: boolean;
  joinedAt: number;
  /** 最近一次在线的时刻：入座、每次绑定、转离线时更新；离线席位清理以它起算。 */
  lastSeenAt: number;
  connectionId?: string;
  account?: PlayerAccount;
}

export interface RoomCore {
  id: string;
  /** 空串表示房主空缺（待选）：巡检每跳重试改选，任何真人上线当场接任。 */
  hostPlayerId: string;
  passwordHash?: string;
  chat: ChatMessage[];
  createdAt: number;
  lastActivityAt: number;
  emptySinceAt?: number;
  /** 房主离线时的重连截止：房主离线就必须带着它，否则视同宽限已过。 */
  hostReconnectDeadlineAt?: number;
  /**
   * 已为哪一次活动发过闲置预警（记的是当时的 `lastActivityAt`）。
   * 有新活动时 `lastActivityAt` 前移，两者不再相等，下一次闲置会重新预警；用布尔标记会一次用尽。
   */
  idleWarningFor?: number;
  /** 进程内运行时状态（在途锁、操作句柄）。快照编码一律丢弃这个键。 */
  runtime?: object;
}

/** 入房准入字段：卧底放在 settings 里，猜歌与 CEE 放在房间层，由 `RoomShape.admission` 取出。 */
export interface RoomAdmission {
  visibility: RoomVisibility;
  allowSpectators: boolean;
  allowAgents: boolean;
}

/** 每款玩法十几行：吸收「座位容器是 Record 还是 Map」「准入字段在房间层还是 settings 里」。 */
export interface RoomShape<TRoom extends RoomCore, TSeat extends SeatCore> {
  readonly game: GameId;
  seats(room: TRoom): Iterable<TSeat>;
  seat(room: TRoom, seatId: string): TSeat | undefined;
  addSeat(room: TRoom, seat: TSeat): void;
  dropSeat(room: TRoom, seatId: string): void;
  admission(room: TRoom): RoomAdmission;
  /** 协议事件名：前缀属线上契约，不统一。 */
  readonly events: {
    snapshot: string;
    privateState: string;
    closed: string;
    sessionReplaced: string;
  };
  /**
   * 顶号通知的载荷与关闭原因。
   * TODO(行为统一)：卧底与猜歌下发 `{ roomId }`、关闭原因 `session_replaced`；CEE 下发一句中文
   * `reason`、关闭原因带空格。客户端各自按现状解析，接入时各传现值；两端统一协议后删掉这两项。
   */
  sessionReplacedPayload(room: TRoom): unknown;
  readonly sessionReplacedCloseReason: string;
}

/** 玩法上下文的公共底座；每款在自己的 Context 里扩展它，只加数据与叶子工具。 */
export interface RoomContextBase<TRoom extends RoomCore, TSeat extends SeatCore> {
  readonly shape: RoomShape<TRoom, TSeat>;
  readonly rooms: Map<string, TRoom>;
  readonly reservations: RoomIdReservations;
  readonly connections: ConnectionRegistry;
  readonly now: () => number;
  readonly random: RandomSource;
  readonly testRooms: TestRoomPolicy;
  /** 已包过「测试房不记」的对局记录器。 */
  readonly recorder: GameRecorder;
  readonly lobby: LobbyFanout;
}
