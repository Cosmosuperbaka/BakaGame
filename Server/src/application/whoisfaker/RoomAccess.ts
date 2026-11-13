import { AppError } from "../../domain/Errors";
import { normalizeName } from "../../domain/Rules";
import type {
  ConnectionRecord,
  GameRound,
  WhoIsFakerPhase,
  WhoIsFakerPlayerRecord,
  WhoIsFakerRoomRecord,
} from "../../shared/Index";
import type { CommandSeat } from "../room/CommandTable";
import type { WhoIsFakerContext } from "./Context";

/** 命令处理函数拿到的座位上下文：连接、房间与发起人，由命令分发器解析并通过守卫。 */
export type WhoIsFakerSeatAt = CommandSeat<WhoIsFakerRoomRecord, WhoIsFakerPlayerRecord>;

/** 房间当前阶段：没有回合就是等待。 */
export const phaseOf = (room: WhoIsFakerRoomRecord): WhoIsFakerPhase =>
  room.round?.phase ?? "waiting";

/** 回合进行中：已开局且尚未进入结算。结算阶段与等待阶段一样，允许改设置与换阵营。 */
export const isRoundActive = (room: WhoIsFakerRoomRecord): boolean =>
  Boolean(room.round && room.round.phase !== "gameOver");

export const requireRound = (room: WhoIsFakerRoomRecord): GameRound => {
  if (!room.round) {
    throw new AppError("ROUND_NOT_STARTED", "当前房间尚未开始游戏");
  }

  return room.round;
};

export const ensureHost = (room: WhoIsFakerRoomRecord, playerId: string): void => {
  if (room.hostPlayerId !== playerId) {
    throw new AppError("FORBIDDEN", "只有房主可以执行该操作");
  }
};

export const ensureQuestioner = (round: GameRound, playerId: string): void => {
  if (round.questionerPlayerId !== playerId) {
    throw new AppError("FORBIDDEN", "只有出题人可以执行该操作");
  }
};

export const ensureUniqueName = (
  room: WhoIsFakerRoomRecord,
  name: string,
  exceptPlayerId?: string
): void => {
  const normalized = normalizeName(name);

  if (
    Object.values(room.players).some(
      (player) => player.id !== exceptPlayerId && player.name === normalized
    )
  ) {
    throw new AppError("NAME_CONFLICT", "该用户名已在房间中");
  }
};

export const getRoom = (ctx: WhoIsFakerContext, roomId: string): WhoIsFakerRoomRecord => {
  const room = ctx.rooms.get(roomId);

  if (!room) {
    throw new AppError("ROOM_NOT_FOUND", "房间不存在");
  }

  return room;
};

/** 连接当前绑定的房间与座位；命令分发器用它解析座位。 */
export const requireRoomPlayer = (ctx: WhoIsFakerContext, connection: ConnectionRecord) => {
  if (!connection.roomId || !connection.playerId) {
    throw new AppError("PLAYER_NOT_IN_ROOM", "当前连接尚未加入房间");
  }

  const room = getRoom(ctx, connection.roomId);
  const player = room.players[connection.playerId];

  if (!player) {
    throw new AppError("PLAYER_NOT_FOUND", "房间内不存在当前玩家");
  }

  return { room, player };
};
