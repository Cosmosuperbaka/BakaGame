import type { GameRecorder } from "../../domain/GameRecord";
import { AppError } from "../../domain/Errors";
import { safeEqualToken } from "../../domain/Rules";
import type { ConnectionRecord } from "../../shared/Model";
import { createEvent } from "../../transport/Packets";
import type { ConnectionRegistry } from "../ConnectionRegistry";
import { tabSeatId } from "../TabSeat";
import { healHostOnAttach, startHostGrace } from "./HostPolicy";
import type { RoomAdmission, RoomCore, RoomShape, SeatCore } from "./RoomCore";

/**
 * 座位与连接的绑定：找座位、回座准入、绑定与顶号、转离线、解散通知。
 *
 * 席位变更只走 `ConnectionRegistry.attach/detach`：直接给连接的 `roomId/playerId` 赋值
 * 会绕开「房间与玩家成对改」的约定，留下换了房间还挂着旧玩家的中间态。
 */

export interface SeatBindingContext<TRoom extends RoomCore, TSeat extends SeatCore> {
  shape: RoomShape<TRoom, TSeat>;
  connections: ConnectionRegistry;
  now: () => number;
}

export interface TabSeatContext<TRoom extends RoomCore, TSeat extends SeatCore> {
  shape: RoomShape<TRoom, TSeat>;
  connections: ConnectionRegistry;
  rooms: ReadonlyMap<string, TRoom>;
}

const isPresent = (seat: SeatCore): boolean => seat.online && seat.membership !== "kicked";

/** 令牌（常量时间比较，跳过被踢的记录）优先，其次这张标签页在本房的座位（同样跳过被踢）。 */
export const findSeat = <TRoom extends RoomCore, TSeat extends SeatCore>(
  ctx: SeatBindingContext<TRoom, TSeat>,
  room: TRoom,
  connection: ConnectionRecord,
  sessionToken?: string | null
): TSeat | undefined => {
  if (sessionToken) {
    for (const seat of ctx.shape.seats(room)) {
      if (seat.membership !== "kicked" && safeEqualToken(seat.sessionToken, sessionToken))
        return seat;
    }
  }
  const tabId = tabSeatId(connection, ctx.shape.game, room.id);
  const seat = tabId ? ctx.shape.seat(room, tabId) : undefined;
  return seat && seat.membership !== "kicked" ? seat : undefined;
};

/** 回座准入：被踢的记录不能回来；人类的座位只属于人类的标签页，Agent 连接不得接手。 */
export const assertSeatResumable = (seat: SeatCore, connection: ConnectionRecord): void => {
  if (seat.membership === "kicked") throw new AppError("PLAYER_KICKED", "该玩家已被移出房间");
  if (connection.isAgent === true && seat.isAgent !== true)
    throw new AppError("AGENT_SEAT_FORBIDDEN", "Agent 不能接手人类座位");
};

/** 入房的 Agent 准入：握手声明的 Agent 与正被 Agent 接管的标签页两条都看。 */
export const assertAgentAdmission = (
  connection: ConnectionRecord,
  admission: RoomAdmission
): void => {
  if (admission.allowAgents) return;
  if (connection.isAgent === true || connection.agentDriven?.() === true)
    throw new AppError("AGENTS_NOT_ALLOWED", "房主已禁止 Agent 进入");
};

/**
 * 顶掉占着座位的旧连接：通知、解绑、关闭各自兜底。
 * 旧连接多半已经死了（客户端断网才会重连），任何一步抛错都不能把新连接挡在门外。
 */
const replacePrevious = <TRoom extends RoomCore, TSeat extends SeatCore>(
  ctx: SeatBindingContext<TRoom, TSeat>,
  room: TRoom,
  previous: ConnectionRecord
): void => {
  try {
    (previous.sendPacket ?? previous.send)(
      createEvent(ctx.shape.events.sessionReplaced, ctx.shape.sessionReplacedPayload(room))
    );
  } catch {
    /* 发不出去就不发，接管照常 */
  }
  try {
    ctx.connections.detach(previous);
  } catch {
    /* 解绑失败只影响旧连接的索引；新绑定随后会覆盖玩家索引 */
  }
  try {
    previous.close(4001, ctx.shape.sessionReplacedCloseReason);
  } catch {
    /* 已经关掉的连接不需要再关一次 */
  }
};

/**
 * 把连接绑到座位。前提：连接空闲，或本来就绑在这个座位上（旧席位由调用方先按玩法规则处理）。
 * 旧连接按顶号处理；随后标在线、写连接与账号、刷新 lastSeenAt、清空房计时、重置差量基线、
 * 登记绑定，最后在房主空缺或宽限已过时当场改选。
 */
export const bindSeat = <TRoom extends RoomCore, TSeat extends SeatCore>(
  ctx: SeatBindingContext<TRoom, TSeat>,
  room: TRoom,
  seat: TSeat,
  connection: ConnectionRecord
): { becameHost: boolean } => {
  const boundElsewhere =
    (connection.roomId !== undefined || connection.playerId !== undefined) &&
    (connection.roomId !== room.id || connection.playerId !== seat.id);
  // 连接还挂着别的座位就直接绑：那个座位会留下「在线却没有连接」的影子，房间永远不空。
  if (boundElsewhere) throw new AppError("SESSION_INVALID", "连接状态已经变化，请重新加入");

  const previous = ctx.connections.findConnectionByPlayer(room.id, seat.id);
  if (previous && previous.id !== connection.id) replacePrevious(ctx, room, previous);

  const now = ctx.now();
  seat.online = true;
  seat.connectionId = connection.id;
  seat.account = connection.account;
  seat.lastSeenAt = now;
  room.emptySinceAt = undefined;
  connection.resetStateSync?.();
  ctx.connections.attach(connection, room.id, seat.id);
  return { becameHost: healHostOnAttach(room, ctx.shape.seats(room), seat, now) };
};

/**
 * 座位转为离线保留：标离线、解绑仍挂着的连接、清 connectionId、lastSeenAt = now；
 * 全员离线且不豁免则起空房计时；本人是房主则开始重连宽限。
 * 返回「是否房主、是否全员离线」供玩法决定局内后果。
 */
export const markSeatOffline = <TRoom extends RoomCore, TSeat extends SeatCore>(
  ctx: SeatBindingContext<TRoom, TSeat>,
  room: TRoom,
  seat: TSeat,
  options: { emptyRoomExempt: boolean }
): { wasHost: boolean; roomEmpty: boolean } => {
  const now = ctx.now();
  const wasHost = room.hostPlayerId === seat.id;
  const bound = ctx.connections.findConnectionByPlayer(room.id, seat.id);
  if (bound) ctx.connections.detach(bound);
  seat.online = false;
  seat.connectionId = undefined;
  seat.lastSeenAt = now;
  let roomEmpty = true;
  for (const member of ctx.shape.seats(room)) {
    if (isPresent(member)) {
      roomEmpty = false;
      break;
    }
  }
  if (roomEmpty && !options.emptyRoomExempt) room.emptySinceAt ??= now;
  if (wasHost) startHostGrace(room, now);
  return { wasHost, roomEmpty };
};

/**
 * 关房的公共部分：对局记录收尾 → 逐连接发关闭事件、解绑、重置差量基线 → 清本房定时器。
 * 删房与玩法旁表由调用方在同一个函数里紧接着做（`dissolveRoom` → 清旁表 → 删房 → 大厅）。
 */
export const dissolveRoom = <TRoom extends RoomCore, TSeat extends SeatCore>(
  ctx: SeatBindingContext<TRoom, TSeat> & {
    recorder: GameRecorder;
    timers?: { clear(roomId: string): void };
  },
  room: TRoom,
  closedPayload: unknown
): void => {
  ctx.recorder.finishRoom({
    game: ctx.shape.game,
    roomId: room.id,
    roomCreatedAt: room.createdAt,
    endedAt: ctx.now(),
  });
  const closed = createEvent(ctx.shape.events.closed, closedPayload);
  for (const connection of ctx.connections.getRoomConnections(room.id)) {
    try {
      (connection.sendPacket ?? connection.send)(closed);
    } catch {
      /* 发不出去的连接照样解绑，不能让一条死连接挡住其余人的收尾 */
    }
    ctx.connections.detach(connection);
    connection.resetStateSync?.();
  }
  ctx.timers?.clear(room.id);
};

/**
 * 这张标签页要交给 Agent：它坐着的每个房间都必须开着 MCP，否则同房玩家的知情就被绕过了。
 * `forbids` 是玩法附加条件（CEE 的反作弊房一律不开放）。
 */
export const assertTabAgentsAllowed = <TRoom extends RoomCore, TSeat extends SeatCore>(
  ctx: TabSeatContext<TRoom, TSeat>,
  tabKey: string,
  forbids?: (room: TRoom) => boolean
): void => {
  for (const roomId of ctx.connections.roomIdsOfTab(tabKey)) {
    const room = ctx.rooms.get(roomId);
    if (!room || !ctx.shape.admission(room).allowAgents || forbids?.(room))
      throw new AppError("AGENTS_NOT_ALLOWED", "本房间未开启 MCP 接入");
  }
};

/** 这张标签页坐着的房间：接管开始或结束时逐个重新发布，同房玩家立刻看到 MCP 徽标变化。 */
export const roomsOfTab = <TRoom extends RoomCore, TSeat extends SeatCore>(
  ctx: TabSeatContext<TRoom, TSeat>,
  tabKey: string
): TRoom[] => {
  const rooms: TRoom[] = [];
  for (const roomId of ctx.connections.roomIdsOfTab(tabKey)) {
    const room = ctx.rooms.get(roomId);
    if (room) rooms.push(room);
  }
  return rooms;
};
