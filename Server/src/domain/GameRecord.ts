/**
 * 对局记录端口：三款游戏在「一轮结算」时各交一份记录，由基础设施异步落库、滚动保留 7 天。
 *
 * 记录只服务后台复盘与统计（回放系统暂缓），因此写入失败只记日志，绝不影响对局本身。
 */
export type RecordedGame = "faker" | "song" | "ccb";

export const RECORDED_GAMES: readonly RecordedGame[] = ["faker", "song", "ccb"];

export interface GameRecordPlayer {
  playerId: string;
  /** 登录玩家的账号 ID；游客为空。 */
  userId: string | null;
  name: string;
  /** 本轮得分（增量），不是房间累计分。 */
  score: number;
}

/** 关键事件：`at` 为毫秒时间戳，`type` 按游戏自定，其余字段只放复盘需要的最小信息。 */
export interface GameRecordEvent {
  at: number;
  type: string;
  [field: string]: unknown;
}

export interface GameRoundRecord {
  game: RecordedGame;
  roomId: string;
  roundNumber: number;
  startedAt: number;
  endedAt: number;
  players: GameRecordPlayer[];
  summary: Record<string, unknown>;
  timeline: GameRecordEvent[];
}

export interface GameRecorder {
  record(round: GameRoundRecord): void;
}

/** 未配置数据库或隔离测试时使用：丢弃记录。 */
export const NOOP_GAME_RECORDER: GameRecorder = { record() {} };
