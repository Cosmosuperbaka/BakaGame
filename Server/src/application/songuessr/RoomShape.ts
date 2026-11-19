import type { RoomShape } from "../room/RoomCore";
import type { SonGuessrPlayerRecord, SonGuessrRoomRecord } from "./Records";

/**
 * 猜歌房间在公共房间内核里的形状：座位是 `players` 记录，准入字段在房间层与 `settings` 里。
 * 事件名的 `song.` 前缀属线上契约，顶号载荷与关闭原因保持猜歌的现值。
 */
export const SONG_ROOM_SHAPE: RoomShape<SonGuessrRoomRecord, SonGuessrPlayerRecord> = {
  game: "song",
  seats: (room) => Object.values(room.players),
  seat: (room, seatId) => room.players[seatId],
  addSeat: (room, seat) => {
    room.players[seat.id] = seat;
  },
  dropSeat: (room, seatId) => {
    delete room.players[seatId];
  },
  admission: (room) => ({
    visibility: room.visibility,
    allowSpectators: room.allowSpectators,
    allowAgents: room.settings.allowAgents === true,
  }),
  events: {
    snapshot: "song.room.snapshot",
    privateState: "song.game.privateState",
    closed: "song.room.closed",
    sessionReplaced: "song.session.replaced",
  },
  sessionReplacedPayload: (room) => ({ roomId: room.id }),
  sessionReplacedCloseReason: "session_replaced",
};
