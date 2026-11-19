import type { ChatMessage } from "../../shared/Index";
import { createEvent } from "../../transport/Packets";
import { acceptChatText, appendChat } from "../room/ChatLog";
import type { SonGuessrContext } from "./Context";
import type { SonGuessrRoomRecord } from "./Records";
import type { SongCommandAt } from "./RoomAccess";

/** 与协议里单条聊天的长度上限一致，服务层再截一次，不依赖入口校验。 */
const SONG_CHAT_TEXT_MAX_LENGTH = 200;

export function sendChat(ctx: SonGuessrContext, at: SongCommandAt, rawText: string) {
  const { connection, room, seat: player } = at;
  ctx.chatLimiter.consume(connection.id);
  const text = acceptChatText(rawText, {
    maxLength: SONG_CHAT_TEXT_MAX_LENGTH,
    emptyError: { code: "INVALID_MESSAGE", message: "消息不能为空" },
  });
  const message: ChatMessage = {
    id: ctx.ids.next("song_chat"),
    playerId: player.id,
    playerName: player.name,
    text,
    createdAt: ctx.now(),
    system: false,
  };
  appendChat(room, message);
  ctx.touch(room);
  // 只走增量事件，不再为一条聊天广播整套房间快照：
  // N 人房间刷 M 条消息会从 O(N×M) 次全量序列化降到 O(N) 次小事件。
  broadcastRoomEvent(ctx, room, "song.chat.message", { message });
  return { sent: true };
}

/** 向房间内所有连接下发一条非状态事件（差量同步通道之外的独立事件）。 */
export function broadcastRoomEvent(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  name: string,
  payload: unknown
) {
  for (const connection of ctx.connections.getRoomConnections(room.id)) {
    connection.send(createEvent(name, payload));
  }
}
