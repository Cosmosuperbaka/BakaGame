/**
 * JSON 纯数据的窄化守卫：`shared/` 是两端共用的最底层，
 * 只放与协议无关的原始值判定，供服务端各层与客户端经 `@bakagame/shared` 复用。
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
