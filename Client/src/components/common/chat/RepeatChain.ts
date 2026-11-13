import type { ChatMessage } from "@bakagame/shared";

/**
 * 复读链：聊天末尾连续几条相同文本的玩家消息（系统提示不算、也不打断）。
 * 返回每条消息在链里的序号；不足两条不算链，返回空表。
 */
export function trailingRepeatChain(messages: ChatMessage[]): Map<string, number> {
  const chain: string[] = [];
  let text: string | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.system) continue;
    if (text !== null && message.text !== text) break;
    text = message.text;
    chain.push(message.id);
  }
  if (chain.length < 2) return new Map();
  return new Map(chain.reverse().map((id, order) => [id, order]));
}
