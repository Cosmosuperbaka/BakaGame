import type { GameRecorder } from "../../domain/GameRecord";
import type { TestRoomPolicy } from "../../domain/TestRooms";
import type { RandomSource } from "../../domain/Rules";
import type { EventLogger } from "../../infrastructure/EventLogger";
import type { BangumiDataProvider } from "../../infrastructure/LocalBangumiProvider";
import type { MusicProvider } from "../../infrastructure/music/NeteaseMusicProvider";
import type { LobbyFanoutSchedule } from "../LobbyFanout";
import type { RoomPasswordGateOptions } from "../room/RoomPasswordGate";

export interface SonGuessrServiceOptions {
  musicProvider: MusicProvider;
  bangumiProvider?: BangumiDataProvider;
  now?: () => number;
  random?: RandomSource;
  eventLogger?: EventLogger;
  /** QQ 凭证主动续期间隔；缺省 6 小时，测试用短间隔覆盖。 */
  musicSessionRefreshIntervalMs?: number;
  /** 未配置数据库时为空：对局记录不落库。 */
  gameRecorder?: GameRecorder;
  /** 测试房策略；缺省关闭，只有组合根与测试夹具显式注入打开的策略时测试房才存在。 */
  testRooms?: TestRoomPolicy;
  /** 大厅合并窗的尾沿调度；缺省挂真实定时器，测试按注入时钟驱动。 */
  lobbyFanoutSchedule?: LobbyFanoutSchedule;
  /** 口令摘要器；只供测试把「建房算摘要」那段 await 停在手里，缺省用运行时的慢哈希。 */
  passwordHasher?: RoomPasswordGateOptions["hasher"];
}
