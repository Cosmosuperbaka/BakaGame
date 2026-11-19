import type { RoomShape } from "../room/RoomCore";
import type { WhoIsFakerPlayerRecord, WhoIsFakerRoomRecord } from "../../shared/Index";

/**
 * 卧底在房间内核里的形状：座位放在 Record 里，准入字段在 `settings` 内。
 * 事件名前缀与顶号载荷属线上契约，按现状保留。
 */
export const whoIsFakerShape: RoomShape<WhoIsFakerRoomRecord, WhoIsFakerPlayerRecord> = {
  game: "faker",
  seats: (room) => Object.values(room.players),
  seat: (room, seatId) => room.players[seatId],
  addSeat: (room, seat) => {
    room.players[seat.id] = seat;
  },
  dropSeat: (room, seatId) => {
    delete room.players[seatId];
  },
  admission: (room) => ({
    visibility: room.settings.visibility,
    allowSpectators: room.settings.allowSpectators,
    allowAgents: room.settings.allowAgents === true,
  }),
  events: {
    snapshot: "room.snapshot",
    privateState: "game.privateState",
    closed: "room.closed",
    sessionReplaced: "session.replaced",
  },
  sessionReplacedPayload: (room) => ({ roomId: room.id }),
  sessionReplacedCloseReason: "session_replaced",
};
