import type { ConnectionRecord } from "../../domain/model";
import type { ClientMessage } from "../../transport/protocol";
import {
  type CommandHandler,
  type CommandResult,
  ownsCommand,
  unsupportedCommand,
} from "./command-handler";

export const PLAYER_COMMAND_TYPES = [
  "player.rename",
  "player.setSpectator",
  "player.setReady",
] as const satisfies readonly ClientMessage["type"][];

interface PlayerCommandDependencies {
  rename(connection: ConnectionRecord, name: string): CommandResult;
  setSpectator(connection: ConnectionRecord, spectator: boolean): CommandResult;
  setReady(connection: ConnectionRecord, ready: boolean): CommandResult;
}

export const createPlayerCommandHandler = (
  dependencies: PlayerCommandDependencies,
): CommandHandler => ({
  canHandle: (type) => ownsCommand(PLAYER_COMMAND_TYPES, type),
  execute: (connection, message) => {
    switch (message.type) {
      case "player.rename":
        return dependencies.rename(connection, message.payload.name);
      case "player.setSpectator":
        return dependencies.setSpectator(connection, message.payload.spectator);
      case "player.setReady":
        return dependencies.setReady(connection, message.payload.ready);
      default:
        return unsupportedCommand();
    }
  },
});
