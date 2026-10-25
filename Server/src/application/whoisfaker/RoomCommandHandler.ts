import type { ConnectionRecord, WhoIsFakerClientMessage } from "../../shared/Index";
import { unsupportedCommand } from "../../domain/Errors";
import { type CommandHandler, type CommandResult, ownsCommand } from "./CommandHandler";

type Message<TType extends WhoIsFakerClientMessage["type"]> = Extract<
  WhoIsFakerClientMessage,
  { type: TType }
>;

export const ROOM_COMMAND_TYPES = [
  "lobby.subscribeRooms",
  "room.create",
  "room.join",
  "room.reconnect",
  "room.leave",
  "room.requestSync",
  "room.updateSettings",
  "room.kick",
  "room.transferHost",
  "chat.send",
  // 由 WhoIsFakerService.execute 在进入处理器前拦截；列在这里是为了让命令表与传输层键集保持一一对应。
  "mcp.claim",
  "mcp.release",
  "mcp.focus",
] as const satisfies readonly WhoIsFakerClientMessage["type"][];

interface RoomCommandDependencies {
  subscribeRooms(connection: ConnectionRecord): CommandResult;
  create(connection: ConnectionRecord, message: Message<"room.create">): CommandResult;
  join(connection: ConnectionRecord, message: Message<"room.join">): CommandResult;
  reconnect(connection: ConnectionRecord, message: Message<"room.reconnect">): CommandResult;
  leave(connection: ConnectionRecord): CommandResult;
  requestSync(connection: ConnectionRecord): CommandResult;
  updateSettings(
    connection: ConnectionRecord,
    payload: Message<"room.updateSettings">["payload"]
  ): CommandResult;
  kick(connection: ConnectionRecord, playerId: string): CommandResult;
  transferHost(connection: ConnectionRecord, playerId: string): CommandResult;
  sendChat(connection: ConnectionRecord, text: string): CommandResult;
}

export const createRoomCommandHandler = (
  dependencies: RoomCommandDependencies
): CommandHandler => ({
  canHandle: (type) => ownsCommand(ROOM_COMMAND_TYPES, type),
  execute: (connection, message) => {
    switch (message.type) {
      case "lobby.subscribeRooms":
        return dependencies.subscribeRooms(connection);
      case "room.create":
        return dependencies.create(connection, message);
      case "room.join":
        return dependencies.join(connection, message);
      case "room.reconnect":
        return dependencies.reconnect(connection, message);
      case "room.leave":
        return dependencies.leave(connection);
      case "room.requestSync":
        return dependencies.requestSync(connection);
      case "room.updateSettings":
        return dependencies.updateSettings(connection, message.payload);
      case "room.kick":
        return dependencies.kick(connection, message.payload.playerId);
      case "room.transferHost":
        return dependencies.transferHost(connection, message.payload.playerId);
      case "chat.send":
        return dependencies.sendChat(connection, message.payload.text);
      default:
        return unsupportedCommand();
    }
  },
});
