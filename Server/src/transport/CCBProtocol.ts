import { Type as t } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { CCBPayloadSchemas, type CCBClientMessage, type CCBCommand } from '../shared/CCB';
import { AppError } from '../domain/Errors';

const schemas = Object.fromEntries(Object.entries(CCBPayloadSchemas).map(([type, payload]) => [type,
  t.Object({ id: t.String({ minLength: 1, maxLength: 128 }), traceId: t.Optional(t.String({ maxLength: 128 })),
    type: t.Literal(type), roomId: t.Optional(t.String({ maxLength: 32 })),
    sessionToken: t.Optional(t.String({ maxLength: 128 })), payload }, { additionalProperties: false }),
]));
export function parseCCBMessage(input: unknown): CCBClientMessage {
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { throw new AppError('INVALID_MESSAGE', '消息必须为合法 JSON 字符串'); }
  }
  const type = (input as { type?: CCBCommand } | null)?.type;
  if (!type || !Object.hasOwn(schemas, type)) throw new AppError('UNKNOWN_MESSAGE_TYPE', '未知的角色游戏指令');
  if (!Value.Check(schemas[type]!, input)) throw new AppError('INVALID_MESSAGE', '指令参数不合法');
  return input as CCBClientMessage;
}
