import { Value } from '@sinclair/typebox/value';
import { CEEMessageSchemas, normalizeCEEEnvelope, type CEEClientMessage, type CEEClientWireMessage, type CEECommand } from '../shared/CEE';
import { AppError } from '../domain/Errors';
export { CEEClientMessageSchema } from '../shared/CEE';
export type { CEEClientWireMessage } from '../shared/CEE';

/** 独立解析入口供协议单测及原生 WS 失败分支诊断；成功 WS 帧由 Elysia 校验。 */
export function parseCEEMessage(input: unknown): CEEClientMessage {
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { throw new AppError('INVALID_MESSAGE', '消息必须为合法 JSON 字符串'); }
  }
  const type = (input as { type?: CEECommand } | null)?.type;
  if (!type || !Object.hasOwn(CEEMessageSchemas, type)) throw new AppError('UNKNOWN_MESSAGE_TYPE', '未知的角色游戏指令');
  if (!Value.Check(CEEMessageSchemas[type]!, input)) throw new AppError('INVALID_MESSAGE', '指令参数不合法');
  return normalizeCEEEnvelope(input as CEEClientWireMessage);
}
