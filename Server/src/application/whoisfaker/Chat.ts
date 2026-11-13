import type { ChatChannel, WhoIsFakerPlayerRecord, WhoIsFakerRoomRecord } from "../../shared/Index";
import { acceptChatText, appendChat } from "../room/ChatLog";
import type { WhoIsFakerContext } from "./Context";
import { isGhostChatActive, spectatorReadsGhostChat, type WhoIsFakerSeatAt } from "./RoomAccess";
import { publishRoom } from "./RoomPublish";

const chatChannelOf = (
  room: WhoIsFakerRoomRecord,
  player: WhoIsFakerPlayerRecord
): { channel: ChatChannel; ghostRole?: "dead" | "spectator" } => {
  if (!isGhostChatActive(room)) return { channel: "main" };
  // 读不到亡者频道的旁观者不往里写：否则他发的话自己都看不见，也等不到回复。
  const isSpectator =
    player.membership === "spectator" &&
    room.round?.questionerPlayerId !== player.id &&
    spectatorReadsGhostChat(room);
  const isDead = room.round?.assignments[player.id]?.alive === false;
  if (isSpectator || isDead) {
    return { channel: "ghost", ghostRole: isSpectator ? "spectator" : "dead" };
  }
  return { channel: "main" };
};

export const sendChat = async (ctx: WhoIsFakerContext, at: WhoIsFakerSeatAt, text: string) => {
  // 聊天区在任意阶段都开放，所以不受 round.phase 限制。
  const { room, seat: player, connection } = at;
  ctx.chatLimiter.consume(connection.id);
  const normalized = acceptChatText(text, {
    maxLength: undefined,
    emptyError: { code: "INVALID_CHAT", message: "聊天内容不能为空" },
  });

  const { channel, ghostRole } = chatChannelOf(room, player);

  appendChat(room, {
    id: ctx.createId("chat"),
    playerId: player.id,
    playerName: player.name,
    text: normalized,
    createdAt: ctx.now(),
    system: false,
    channel,
    ghostRole,
  });
  ctx.touch(room);

  await ctx.log({
    type: "chat.sent",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
    payload: {
      text: normalized,
      channel,
      ghostRole,
    },
  });

  publishRoom(ctx, room);
  return { sent: true };
};
