import type {
  ConnectionRecord,
  WhoIsFakerClientMessage,
  WhoIsFakerCommand,
} from "../../shared/Index";

/**
 * 处理器返回值：transport 一律 await 之后原样序列化进 ack 包（见 `transport/App.ts` 的 `createAck`）。
 *
 * 旧写法是 `unknown | Promise<unknown>`，而 union 里只要出现 unknown 就整体塌成 unknown，
 * 类型上没有任何约束，却让人误以为有 —— 载荷必须是可以 JSON 序列化的对象，就把它写出来。
 */
export type CommandResult =
  Record<string, unknown> | void | Promise<Record<string, unknown> | void>;

export interface CommandHandler {
  canHandle(type: WhoIsFakerCommand): boolean;
  execute(connection: ConnectionRecord, message: WhoIsFakerClientMessage): CommandResult;
}

export const ownsCommand = (
  types: readonly WhoIsFakerCommand[],
  type: WhoIsFakerCommand
): boolean => types.includes(type);
