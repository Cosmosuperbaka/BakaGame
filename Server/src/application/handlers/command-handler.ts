import { AppError } from "../../domain/errors";
import type { ConnectionRecord } from "../../domain/model";
import type { ClientMessage } from "../../transport/protocol";

export type CommandResult = unknown | Promise<unknown>;

export interface CommandHandler {
  canHandle(type: ClientMessage["type"]): boolean;
  execute(connection: ConnectionRecord, message: ClientMessage): CommandResult;
}

export const ownsCommand = (
  types: readonly ClientMessage["type"][],
  type: ClientMessage["type"],
): boolean => types.includes(type);

export const unsupportedCommand = (): never => {
  throw new AppError("UNSUPPORTED_COMMAND", "暂不支持的命令");
};
