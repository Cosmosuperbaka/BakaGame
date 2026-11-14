import { createEvent } from "../../transport/Packets";
import type {
  ConnectionRecord,
  WhoIsFakerRoomRecord,
  WhoIsFakerRoomSnapshot,
} from "../../shared/Index";
import { publishRoomState } from "../room/RoomPublisher";
import type { WhoIsFakerContext } from "./Context";
import { describePhaseChange, getPhaseNoticeKey } from "./PhaseNotice";
import { whoIsFakerShape } from "./RoomShape";
import { buildPrivateState, buildRoomSnapshot, createRoomSnapshotViewSelector } from "./RoomViews";

/**
 * 快照扇出：正常发布与校准共用同一份帧来源，两条路径的口径不会分叉。
 * 公共快照按「能否看幽灵频道」只有两种投影，内核对同一投影只封一次包。
 */
const fanOutRoom = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  targets: readonly ConnectionRecord[],
  snapshot: WhoIsFakerRoomSnapshot,
  mode: "state" | "calibration"
) => {
  publishRoomState(
    targets,
    (connection) => (connection.playerId ? room.players[connection.playerId] : undefined),
    {
      snapshotEvent: whoIsFakerShape.events.snapshot,
      privateEvent: whoIsFakerShape.events.privateState,
      snapshotFor: createRoomSnapshotViewSelector(room, snapshot),
      privateFor: (player) => buildPrivateState(ctx, room, player, snapshot),
    },
    mode
  );
};

export const publishRoom = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  targetConnection?: ConnectionRecord
) => {
  // 每次状态变化都同时推送公共快照与当前连接的私有视图。
  const snapshot = buildRoomSnapshot(ctx, room);

  if (!targetConnection) {
    const phaseKey = getPhaseNoticeKey(snapshot);
    const previousPhaseKey = ctx.publishedPhaseKeyByRoomId.get(room.id);
    if (previousPhaseKey !== undefined && previousPhaseKey !== phaseKey) {
      ctx.appendSystemMessage(room, describePhaseChange(snapshot, room));
      snapshot.chat = room.chat;
    }
    ctx.publishedPhaseKeyByRoomId.set(room.id, phaseKey);
  }

  fanOutRoom(
    ctx,
    room,
    targetConnection ? [targetConnection] : ctx.connectionRegistry.getRoomConnections(room.id),
    snapshot,
    "state"
  );
};

export const publishRoomCalibration = (ctx: WhoIsFakerContext, room: WhoIsFakerRoomRecord) => {
  fanOutRoom(
    ctx,
    room,
    ctx.connectionRegistry.getRoomConnections(room.id),
    buildRoomSnapshot(ctx, room),
    "calibration"
  );
};

export const publishLobby = (ctx: WhoIsFakerContext) => {
  ctx.lobbyFanout.request();
};

export const broadcastRoomEvent = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  event: string,
  payload: unknown
) => {
  ctx.connectionRegistry.broadcastToRoom(room.id, createEvent(event, payload));
};
