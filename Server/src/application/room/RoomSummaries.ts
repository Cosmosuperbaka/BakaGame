import type { AdminRoomView } from "../../domain/AdminRoom";
import { AppError } from "../../domain/Errors";
import type { RecordedGame } from "../../domain/GameRecord";
import type { RoomVisibility } from "../../shared/Model";
import type { RoomCore, SeatCore } from "./RoomCore";

/** 在线人数：在线且未被移出的座位。大厅摘要、健康快照与空房判定共用这一个口径。 */
export const countOnline = (seats: Iterable<SeatCore>): number => {
  let count = 0;
  for (const seat of seats) if (seat.online && seat.membership !== "kicked") count += 1;
  return count;
};

/** 后台房间视图：成员映射三款逐字段相同，被移出的记录不列出；令牌、身份与对局秘密不进视图。 */
export const adminRoomView = (
  room: RoomCore,
  seats: Iterable<SeatCore>,
  facts: {
    game: RecordedGame;
    name: string;
    phase: string;
    visibility: RoomVisibility;
    /** 不进大厅的房间（测试房、猜歌单人房），后台照样列出。 */
    hidden: boolean;
    roundNumber: number;
  }
): AdminRoomView => {
  const players: AdminRoomView["players"] = [];
  for (const seat of seats) {
    if (seat.membership === "kicked") continue;
    players.push({
      id: seat.id,
      name: seat.name,
      online: seat.online,
      membership: seat.membership,
      host: seat.id === room.hostPlayerId,
      bot: seat.isBot === true,
      userId: seat.account?.userId ?? null,
    });
  }
  return {
    game: facts.game,
    roomId: room.id,
    name: facts.name,
    phase: facts.phase,
    visibility: facts.visibility,
    hasPassword: Boolean(room.passwordHash),
    hidden: facts.hidden,
    roundNumber: facts.roundNumber,
    createdAt: room.createdAt,
    lastActiveAt: room.lastActivityAt,
    players,
  };
};

/** 后台操作的目标房间；不存在时与三款同一个码。 */
export const requireAdminRoom = <TRoom>(
  rooms: ReadonlyMap<string, TRoom>,
  roomId: string
): TRoom => {
  const room = rooms.get(roomId);
  if (!room) throw new AppError("ROOM_NOT_FOUND", "房间不存在或已关闭");
  return room;
};
