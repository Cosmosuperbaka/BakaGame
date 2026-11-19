import { Type as t, type Static, type TSchema } from "@sinclair/typebox";

/**
 * 动态 Schema 列表的唯一静态边界。
 * TypeBox 0.34 / Elysia 1.4 的 Module.Import 按 tuple 递归推导 union，普通数组会变成 never。
 * 使用原生 Unsafe 承接同一 union 的 Static，保留其 Union Kind / anyOf 和运行时校验；
 * 不另写业务类型、不改成 Any，也不维护第二份命令清单。
 */
export function schemaUnion<T extends TSchema>(schemas: T[]) {
  const union = t.Union(schemas);
  return t.Unsafe<Static<typeof union>>(union);
}
