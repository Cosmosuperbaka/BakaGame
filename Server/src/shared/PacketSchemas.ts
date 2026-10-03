import { Type as t } from "@sinclair/typebox";
const strict = { additionalProperties: false } as const;
const traceId = t.Optional(t.String({ maxLength: 128 }));
/** 只约束传输信封；事件/ACK 业务载荷仍由各游戏共享模型约束，不虚称完全 E2E 类型安全。 */
export const ServerMessageSchema = t.Union([
  t.Object({ type: t.Literal("ack"), id: t.String(), traceId, requestType: t.String(), payload: t.Optional(t.Unknown()) }, strict),
  t.Object({ type: t.Literal("error"), id: t.String(), traceId,
    error: t.Object({ code: t.String(), message: t.String(), details: t.Optional(t.Unknown()) }, strict) }, strict),
  t.Object({ type: t.Literal("event"), event: t.String(), payload: t.Unknown() }, strict),
]);
