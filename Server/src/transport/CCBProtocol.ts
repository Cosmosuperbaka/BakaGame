import { Value } from '@sinclair/typebox/value';
import { CCBMessageSchemas, normalizeCCBEnvelope, type CCBClientMessage, type CCBClientWireMessage, type CCBCommand } from '../shared/CCB';
import { AppError } from '../domain/Errors';
export { CCBClientMessageSchema } from '../shared/CCB';
export type { CCBClientWireMessage } from '../shared/CCB';

/** 独立解析入口供协议单测及原生 WS 失败分支诊断；成功 WS 帧由 Elysia 校验。 */
export function parseCCBMessage(input: unknown): CCBClientMessage {
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { throw new AppError('INVALID_MESSAGE', '消息必须为合法 JSON 字符串'); }
  }
  const type = (input as { type?: CCBCommand } | null)?.type;
  if (!type || !Object.hasOwn(CCBMessageSchemas, type)) throw new AppError('UNKNOWN_MESSAGE_TYPE', '未知的角色游戏指令');
  if (!Value.Check(CCBMessageSchemas[type]!, input)) throw new AppError('INVALID_MESSAGE', '指令参数不合法');
  return normalizeCCBEnvelope(input as CCBClientWireMessage);
}
