/**
 * 对局记录端口：一款游戏的一个房间从创建到销毁记为一局，局内每次结算上交一个回合，
 * 房间销毁时收尾。由基础设施异步落库，记录永久保留。
 *
 * 记录只服务后台复盘与统计（回放系统暂缓），因此写入失败只记日志，绝不影响对局本身。
 */
export type RecordedGame = "faker" | "song" | "cee";

export const RECORDED_GAMES: readonly RecordedGame[] = ["faker", "song", "cee"];

export interface GameRecordPlayer {
  playerId: string;
  /** 登录玩家的账号 ID；游客为空。 */
  userId: string | null;
  name: string;
  /** 本回合得分（增量），不是房间累计分。 */
  score: number;
}

/** 关键事件：`at` 为毫秒时间戳，`type` 按游戏自定，其余字段只放复盘需要的最小信息。 */
export interface GameRecordEvent {
  at: number;
  type: string;
  [field: string]: unknown;
}

/** 一局里的一个回合：摘要与关键事件时间线都按回合提交。 */
export interface GameRoundRecord {
  game: RecordedGame;
  roomId: string;
  /**
   * 房间创建时刻。房间号会复用，同一房间号的不同生命周期靠它区分；
   * 同时它也是一局的开局时间。
   */
  roomCreatedAt: number;
  /** 房间内的回合序号，从 1 开始。 */
  roundNumber: number;
  startedAt: number;
  endedAt: number;
  players: GameRecordPlayer[];
  summary: Record<string, unknown>;
  timeline: GameRecordEvent[];
}

/** 房间生命周期结束：把这一局从「进行中」收尾到「已销毁」。 */
export interface GameRoomEnd {
  game: RecordedGame;
  roomId: string;
  roomCreatedAt: number;
  endedAt: number;
}

export interface GameRecorder {
  record(round: GameRoundRecord): void;
  finishRoom(room: GameRoomEnd): void;
}

/** 未配置数据库或隔离测试时使用：丢弃记录。 */
export const NOOP_GAME_RECORDER: GameRecorder = { record() {}, finishRoom() {} };
