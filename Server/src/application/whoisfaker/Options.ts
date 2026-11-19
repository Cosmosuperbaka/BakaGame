import type { GameRecorder } from "../../domain/GameRecord";
import type { RandomSource } from "../../domain/Rules";
import type { TestRoomPolicy } from "../../domain/TestRooms";
import type { EventLogger } from "../../infrastructure/EventLogger";
import type { WordBankRepository } from "../../infrastructure/WordBankRepository";
import type { LobbyFanoutSchedule } from "../LobbyFanout";
import type { RoomPasswordGateOptions } from "../room/RoomPasswordGate";
import type { TimerSeam } from "../room/RoomTimers";

/** 服务构造选项：单独成文件，让上下文与子模块不必反向依赖服务门面。 */
export interface WhoIsFakerServiceOptions {
  now?: () => number;
  /** 缺省为 Bun 的 argon2；测试可注入以控制慢哈希期间的并发窗口，原样交给口令门。 */
  passwordHasher?: RoomPasswordGateOptions["hasher"];
  random?: RandomSource;
  /** 未配置数据库（本地开发、隔离测试）时为空：词对不落库。 */
  wordBankRepository?: WordBankRepository;
  eventLogger: EventLogger;
  /** 未配置数据库时为空：对局记录不落库。 */
  gameRecorder?: GameRecorder;
  /** 测试房策略；缺省关闭，只有组合根与测试夹具显式注入打开的策略时测试房才存在。 */
  testRooms?: TestRoomPolicy;
  /** 大厅合并窗的尾沿调度；缺省挂真实定时器，测试按注入时钟驱动。 */
  lobbyFanoutSchedule?: LobbyFanoutSchedule;
  /** 阶段定时器的挂载接缝；缺省挂真实定时器（不拖住进程退出），测试按注入时钟驱动。 */
  setTimer?: TimerSeam;
}
