/**
 * 共享源码（Server/src/shared）的外部依赖里，必须在打包阶段按 Client 根解析的包。
 * vite.config.ts 的 resolve.dedupe 与 check-shared-dependencies.mjs 共用这一份，
 * 门禁不再从配置文本里用正则抠列表。
 */
export const SHARED_DEDUPE = ["@sinclair/typebox", "@orpc/contract", "zod"];
