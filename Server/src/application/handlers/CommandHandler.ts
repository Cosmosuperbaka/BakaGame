import { AppError } from "../../domain/Errors";
import type { ConnectionRecord } from "../../domain/Model";
import type { WhoIsFakerClientMessage } from "../../shared/Index";

export type CommandResult = unknown | Promise<unknown>;

export interface CommandHandler {
  canHandle(type: WhoIsFakerClientMessage["type"]): boolean;
  execute(connection: ConnectionRecord, message: WhoIsFakerClientMessage): CommandResult;
}

export const ownsCommand = (
  types: readonly WhoIsFakerClientMessage["type"][],
  type: WhoIsFakerClientMessage["type"],
): boolean => types.includes(type);

export const unsupportedCommand = (): never => {
  throw new AppError("UNSUPPORTED_COMMAND", "暂不支持的命令");
};
