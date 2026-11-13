import { AppError } from "../../domain/Errors";
import type { ConnectionRecord } from "../../shared/Index";
import type { CommandAt } from "../room/CommandTable";
import { systemMessage, appendChat } from "../room/ChatLog";
import type { SonGuessrContext } from "./Context";
import type { SonGuessrPlayerRecord, SonGuessrRoomRecord } from "./Records";

/** 命令表交给处理函数的席位上下文：连接、房间与已确认的席位。 */
export type SongCommandAt = CommandAt<SonGuessrRoomRecord, SonGuessrPlayerRecord>;

/** 房间正在开局：自动与手动两种开局共用同一口径，设置、开局与入池开关都按它拦。 */
export const isRoomStarting = (room: SonGuessrRoomRecord): boolean =>
  room.runtime?.automaticRoundLoading === true || room.runtime?.manualRoundStarting === true;

export const getRoom = (ctx: SonGuessrContext, roomId: string) => {
  const room = ctx.rooms.get(roomId);
  if (!room) throw new AppError("ROOM_NOT_FOUND", "房间不存在");
  return room;
};

/** 连接当前所在的房间与席位：命令分发的身份确认与各子模块共用，错误码与文案只有这一份。 */
export const requireRoomPlayer = (ctx: SonGuessrContext, connection: ConnectionRecord) => {
  if (!connection.roomId || !connection.playerId) {
    throw new AppError("PLAYER_NOT_IN_ROOM", "当前连接尚未加入房间");
  }
  const room = getRoom(ctx, connection.roomId);
  const player = room.players[connection.playerId];
  if (!player || player.membership === "kicked")
    throw new AppError("PLAYER_NOT_FOUND", "玩家不存在");
  return { room, player };
};

export const activePlayers = (room: SonGuessrRoomRecord): SonGuessrPlayerRecord[] =>
  Object.values(room.players).filter((player) => player.membership === "active");

/** 测试房特权的唯一判定点：只认策略，房号对上而开关关闭时就是普通房。 */
export const isTestRoom = (ctx: SonGuessrContext, room: SonGuessrRoomRecord): boolean =>
  ctx.testRooms.isTestRoom(room.id);

export const canTestSubmitterGuess = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  playerId: string
): boolean =>
  Boolean(
    isTestRoom(ctx, room) &&
    room.currentRound?.submitterPlayerId === playerId &&
    room.players[playerId]?.membership === "active"
  );

export const appendSystemMessage = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  text: string
) => {
  appendChat(room, systemMessage({ id: ctx.ids.next("song_chat"), text, createdAt: ctx.now() }));
};
