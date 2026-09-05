import type { ConnectionRecord } from "../../domain/Model";
import type { ClientMessage } from "../../shared/Index";
import {
  type CommandHandler,
  type CommandResult,
  ownsCommand,
  unsupportedCommand,
} from "./CommandHandler";

export const TEST_COMMAND_TYPES = [
  "test.jumpToPhase",
  "test.setMyRole",
  "test.addBot",
  "test.removeBot",
] as const satisfies readonly ClientMessage["type"][];

interface TestCommandDependencies {
  jumpToPhase(
    connection: ConnectionRecord,
    phase: Extract<ClientMessage, { type: "test.jumpToPhase" }>["payload"]["phase"],
  ): CommandResult;
  setMyRole(
    connection: ConnectionRecord,
    role: Extract<ClientMessage, { type: "test.setMyRole" }>["payload"]["role"],
  ): CommandResult;
  addBot(connection: ConnectionRecord, count: number): CommandResult;
  removeBot(
    connection: ConnectionRecord,
    playerId: string | undefined,
    count: number,
  ): CommandResult;
}

export const createTestCommandHandler = (
  dependencies: TestCommandDependencies,
): CommandHandler => ({
  canHandle: (type) => ownsCommand(TEST_COMMAND_TYPES, type),
  execute: (connection, message) => {
    switch (message.type) {
      case "test.jumpToPhase":
        return dependencies.jumpToPhase(connection, message.payload.phase);
      case "test.setMyRole":
        return dependencies.setMyRole(connection, message.payload.role);
      case "test.addBot":
        return dependencies.addBot(connection, message.payload.count ?? 1);
      case "test.removeBot":
        return dependencies.removeBot(
          connection,
          message.payload.playerId,
          message.payload.count ?? 1,
        );
      default:
        return unsupportedCommand();
    }
  },
});
