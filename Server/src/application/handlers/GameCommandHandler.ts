import type { ConnectionRecord } from "../../domain/Model";
import type { ClientMessage } from "../../shared/Index";
import {
  type CommandHandler,
  type CommandResult,
  ownsCommand,
  unsupportedCommand,
} from "./CommandHandler";

type Message<TType extends ClientMessage["type"]> = Extract<
  ClientMessage,
  { type: TType }
>;

export const GAME_COMMAND_TYPES = [
  "game.assignQuestioner",
  "game.submitWords",
  "game.advancePhase",
  "game.submitDescription",
  "game.submitVote",
  "game.submitNightAction",
  "game.submitBlankGuess",
  "game.enterBlankGuess",
  "game.updateBlankGuessDraft",
  "game.reviewBlankGuess",
  "game.cancelVote",
  "game.cancelNightAction",
  "game.requestSupplement",
  "game.resolveDisconnect",
  "game.startPhaseTimer",
  "game.stopPhaseTimer",
] as const satisfies readonly ClientMessage["type"][];

interface GameCommandDependencies {
  assignQuestioner(connection: ConnectionRecord, playerId: string): CommandResult;
  submitWords(
    connection: ConnectionRecord,
    payload: Message<"game.submitWords">["payload"],
  ): CommandResult;
  advancePhase(connection: ConnectionRecord): CommandResult;
  submitDescription(connection: ConnectionRecord, text: string): CommandResult;
  submitVote(connection: ConnectionRecord, targetId: string): CommandResult;
  submitNightAction(connection: ConnectionRecord, targetId?: string | null): CommandResult;
  submitBlankGuess(
    connection: ConnectionRecord,
    words: [string, string],
  ): CommandResult;
  enterBlankGuess(connection: ConnectionRecord): CommandResult;
  updateBlankGuessDraft(
    connection: ConnectionRecord,
    words: [string, string],
  ): CommandResult;
  reviewBlankGuess(connection: ConnectionRecord, approve: boolean): CommandResult;
  cancelVote(connection: ConnectionRecord): CommandResult;
  cancelNightAction(connection: ConnectionRecord): CommandResult;
  requestSupplement(connection: ConnectionRecord, playerIds: string[]): CommandResult;
  resolveDisconnect(
    connection: ConnectionRecord,
    payload: Message<"game.resolveDisconnect">["payload"],
  ): CommandResult;
  startPhaseTimer(connection: ConnectionRecord, durationSeconds: number): CommandResult;
  stopPhaseTimer(connection: ConnectionRecord): CommandResult;
}

export const createGameCommandHandler = (
  dependencies: GameCommandDependencies,
): CommandHandler => ({
  canHandle: (type) => ownsCommand(GAME_COMMAND_TYPES, type),
  execute: (connection, message) => {
    switch (message.type) {
      case "game.assignQuestioner":
        return dependencies.assignQuestioner(connection, message.payload.playerId);
      case "game.submitWords":
        return dependencies.submitWords(connection, message.payload);
      case "game.advancePhase":
        return dependencies.advancePhase(connection);
      case "game.submitDescription":
        return dependencies.submitDescription(connection, message.payload.text);
      case "game.submitVote":
        return dependencies.submitVote(connection, message.payload.targetId);
      case "game.submitNightAction":
        return dependencies.submitNightAction(connection, message.payload.targetId);
      case "game.submitBlankGuess":
        return dependencies.submitBlankGuess(connection, message.payload.words);
      case "game.enterBlankGuess":
        return dependencies.enterBlankGuess(connection);
      case "game.updateBlankGuessDraft":
        return dependencies.updateBlankGuessDraft(connection, message.payload.words);
      case "game.reviewBlankGuess":
        return dependencies.reviewBlankGuess(connection, message.payload.approve);
      case "game.cancelVote":
        return dependencies.cancelVote(connection);
      case "game.cancelNightAction":
        return dependencies.cancelNightAction(connection);
      case "game.requestSupplement":
        return dependencies.requestSupplement(connection, message.payload.playerIds);
      case "game.resolveDisconnect":
        return dependencies.resolveDisconnect(connection, message.payload);
      case "game.startPhaseTimer":
        return dependencies.startPhaseTimer(connection, message.payload.durationSeconds);
      case "game.stopPhaseTimer":
        return dependencies.stopPhaseTimer(connection);
      default:
        return unsupportedCommand();
    }
  },
});
