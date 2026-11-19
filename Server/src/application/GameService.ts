import type { AdminRoomControl } from "../domain/AdminRoom";
import type { ConnectionRecord } from "../shared/Model";
import type { RoomSnapshotService } from "./RoomSnapshots";

/**
 * 三款游戏门面对外的公共形状：传输层与组合根按这个名字对等地取用三款服务。
 *
 * 只是给三款今天已经各自实现的同一组方法起名，不是基类，也不带任何实现。
 * 不放进来的两样是有意的：可排队写入的排空只有拥有队列的服务才暴露，资源关闭只有持有
 * 资源的服务才有；给另外两款补空方法等于造等价 API（见 Server/docs/Engineering §3）。
 */
export interface GameService<TMessage> extends AdminRoomControl, RoomSnapshotService {
  registerConnection(connection: ConnectionRecord): void;
  unregisterConnection(connectionId: string): Promise<void>;
  execute(connectionId: string, message: TMessage): Promise<unknown>;
  runHousekeeping(): Promise<void>;
  notifyShutdown(): void;
  /** 公共子集：某款多给的计数字段保留在它自己的返回类型里。 */
  getHealthSnapshot(): { roomCount: number; connectionCount: number; onlinePlayerCount: number };
  assertTabAgentsAllowed(tabKey: string): void;
  publishTabRooms(tabKey: string): void;
}
