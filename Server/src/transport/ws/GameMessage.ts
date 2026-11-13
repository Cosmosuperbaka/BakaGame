import type { GameMessage } from "../GameEndpoints";
import { connectionIdOf, type GameSocketLike } from "./ConnectionRecord";
import type { CommandDeduplicator } from "./Dedup";

export interface GameSocketHandlers<TMessage extends GameMessage> {
  /** 只用于错误日志前缀，便于把异常定位到具体游戏。 */
  serviceName: string;
  execute: (connectionId: string, message: TMessage) => Promise<unknown>;
}

/**
 * 三个游戏共用的消息处理：解析 → 幂等执行 → ACK/错误封包。
 *
 * 只在「解析器、服务、日志前缀」上不同（Agents/Spec.md「平台与多游戏平等架构 · 传输对称」要求
 * 网关对称消费各游戏解析器），其余部分单点实现，避免三份拷贝在后续改动中各自漂移。
 */
/** 成功帧已通过 Elysia body 校验，业务层不重复枚举 Value.Errors。 */
export const handleGameMessage = async <TMessage extends GameMessage>(
  ws: GameSocketLike,
  parsed: TMessage,
  dedup: CommandDeduplicator,
  { serviceName, execute }: GameSocketHandlers<TMessage>
): Promise<void> => {
  const connectionId = connectionIdOf(ws);
  if (!connectionId) return;
  await dedup.run({
    ws,
    connectionId,
    parsed,
    startTime: performance.now(),
    execute: () => execute(connectionId, parsed),
    serviceName,
  });
};
