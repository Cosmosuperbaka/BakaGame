import { Type as t } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { CCBPayloadSchemas, type CCBClientMessage, type CCBCommand } from '../shared/CCB';
import { AppError } from '../domain/Errors';

/**
 * 可选信封字段必须显式接纳 `null`。
 *
 * 前端 zustand store 里 `roomId` / `sessionToken` 这类「尚未加入房间」的初值就是 `null`，
 * 而 `t.Optional()` 只容忍字段「缺席」（`undefined`），JSON 序列化又会把 `undefined`
 * 直接抹掉、却把 `null` 原样发出——于是「带 null 的可选字段」在严格校验下被判非法。
 * 这类信封属于合法请求，放开 `null` 只影响「未提供」语义，不放松任何取值约束。
 */
const optionalEnvelopeString = (maxLength: number) =>
  t.Optional(t.Union([t.String({ maxLength }), t.Null()]));

/**
 * 信封 `roomId` 的上限必须容纳服务端内部的 `original:` 前缀形态。
 *
 * 业务房间号本身限 32 字符，但服务端会话记录用的是 `original:${roomId}`
 * （见 `CCBOriginalService` 的 `connection.roomId` 赋值）。前端把 sessionStorage
 * 或路由参数里的值原样回填到信封时可能带上该前缀，此时若按 32 截断，
 * 请求会在**解析阶段**被判非法——日志只剩 `WS raw`、错误包 id 不匹配，
 * 前端完全静默。这里放宽到覆盖前缀长度，取值约束仍由业务层承担。
 */
const ROOM_ID_PREFIX = "original:";
const ENVELOPE_ROOM_ID_MAX = ROOM_ID_PREFIX.length + 32;

const schemas = Object.fromEntries(Object.entries(CCBPayloadSchemas).map(([type, payload]) => [type,
  t.Object({ id: t.String({ minLength: 1, maxLength: 128 }), traceId: optionalEnvelopeString(128),
    type: t.Literal(type), roomId: optionalEnvelopeString(ENVELOPE_ROOM_ID_MAX),
    sessionToken: optionalEnvelopeString(128), payload }, { additionalProperties: false }),
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
