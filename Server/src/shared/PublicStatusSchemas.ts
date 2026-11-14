import { Type as t } from "@sinclair/typebox";

/**
 * 公开状态页四个只读端点的响应契约：服务端路由的 response 与客户端的条目过滤共用这一份。
 * 领域类型仍以 Status.ts 的无 schema 接口为准——Values.ts 要把那些常量带进首屏，不能沾 typebox；
 * 路由处理器的返回类型会在编译期核对接口与 schema 的 Static 同形，两边不会各写各的。
 */

/**
 * 组件白名单逐字写成字面量联合：Elysia 要按字面量推断返回类型，
 * 由 PUBLIC_STATUS_COMPONENT_IDS map 出来的联合到这里会退化成 string，白名单就形同虚设。
 * Status.test.ts 用 PUBLIC_STATUS_COMPONENT_IDS 反向核对响应里的清单。
 */
const componentIdSchema = t.Union([
  t.Literal("frontend"),
  t.Literal("backend"),
  t.Literal("bangumi"),
  t.Literal("qqmusic"),
  t.Literal("netease"),
  t.Literal("qq"),
  t.Literal("rooms"),
  t.Literal("search"),
  t.Literal("dataset"),
  t.Literal("images"),
]);

const levelSchema = t.Union([
  t.Literal("operational"),
  t.Literal("degraded"),
  t.Literal("unknown"),
]);

export const PublicStatusComponentSchema = t.Object({
  id: componentIdSchema,
  level: levelSchema,
  latencyMs: t.Union([t.Number(), t.Null()]),
});

export const PublicStatusSnapshotSchema = t.Object({
  observedAt: t.Number(),
  level: levelSchema,
  version: t.String(),
  components: t.Array(PublicStatusComponentSchema),
});

export const PublicStatusHistoryEntrySchema = t.Object({
  id: componentIdSchema,
  uptime: t.Array(
    t.Object({
      days: t.Number(),
      ratio: t.Union([t.Number(), t.Null()]),
    })
  ),
  cells: t.Array(
    t.Object({
      day: t.String(),
      total: t.Number(),
      ratio: t.Union([t.Number(), t.Null()]),
      level: levelSchema,
      latencyMs: t.Union([t.Number(), t.Null()]),
    })
  ),
  latencyMs: t.Union([t.Number(), t.Null()]),
});

export const PublicStatusHistorySchema = t.Object({
  days: t.Number(),
  generatedAt: t.Number(),
  entries: t.Array(PublicStatusHistoryEntrySchema),
});

export const PublicStatusRealtimeEntrySchema = t.Object({
  id: componentIdSchema,
  uptime: t.Union([t.Number(), t.Null()]),
  cells: t.Array(
    t.Object({
      start: t.Number(),
      total: t.Number(),
      ratio: t.Union([t.Number(), t.Null()]),
      level: levelSchema,
      latencyMs: t.Union([t.Number(), t.Null()]),
    })
  ),
});

export const PublicStatusRealtimeSchema = t.Object({
  intervalMs: t.Number(),
  windowMs: t.Number(),
  generatedAt: t.Number(),
  entries: t.Array(PublicStatusRealtimeEntrySchema),
});

export const PublicStatusEventSchema = t.Object({
  id: t.Number(),
  kind: t.Union([t.Literal("incident"), t.Literal("maintenance")]),
  title: t.String(),
  body: t.String(),
  status: t.String(),
  components: t.Array(componentIdSchema),
  startedAt: t.Number(),
  plannedEndAt: t.Union([t.Number(), t.Null()]),
  resolvedAt: t.Union([t.Number(), t.Null()]),
  updatedAt: t.Number(),
});

export const PublicStatusEventsSchema = t.Object({
  generatedAt: t.Number(),
  events: t.Array(PublicStatusEventSchema),
});
