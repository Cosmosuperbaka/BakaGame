import type { ConnectionRecord } from "../../shared/Model";
import { createEvent, type EventPacket } from "../../transport/Packets";

/**
 * 一次发布的帧来源。由玩法在每次发布时构造一份：公共快照只构造一次，
 * 按观看者取投影（多数玩法恒返回同一份）；私有帧按座位构造。
 */
export interface RoomFrames<TSeat> {
  readonly snapshotEvent: string;
  readonly privateEvent: string;
  /**
   * 这位观看者看到的公共快照投影。返回 `undefined` 表示这条连接不收公共帧
   * （CEE 只给在座的连接发）。投影必须在本次发布内复用同一个对象，扇出才不会逐连接构造。
   */
  snapshotFor(seat: TSeat | undefined): unknown;
  privateFor(seat: TSeat): unknown;
}

const deliver = (
  connection: ConnectionRecord,
  packet: EventPacket,
  mode: "state" | "calibration"
): void => {
  if (mode === "state") connection.send(packet);
  else connection.sendStateSyncCalibration?.(packet);
};

/**
 * 快照扇出：每条连接先收公共帧、再收自己的私有帧。
 *
 * 热路径：循环里不新建闭包；同一份投影的公共帧只封一次包，连续的观看者共用同一个帧对象
 * （传输层按载荷对象缓存补丁，共用对象正是它期望的形态），只有私有帧逐连接构造。
 * 校准与正常发布共用同一个 `frames`，两条路径的口径不可能分叉。
 */
export const publishRoomState = <TSeat>(
  targets: readonly ConnectionRecord[],
  seatOf: (connection: ConnectionRecord) => TSeat | undefined,
  frames: RoomFrames<TSeat>,
  mode: "state" | "calibration"
): void => {
  let projected: unknown;
  let packet: EventPacket | undefined;
  for (const connection of targets) {
    const seat = seatOf(connection);
    const snapshot = frames.snapshotFor(seat);
    if (snapshot === undefined) continue;
    if (!packet || snapshot !== projected) {
      projected = snapshot;
      packet = createEvent(frames.snapshotEvent, snapshot);
    }
    deliver(connection, packet, mode);
    if (seat !== undefined)
      deliver(connection, createEvent(frames.privateEvent, frames.privateFor(seat)), mode);
  }
};
