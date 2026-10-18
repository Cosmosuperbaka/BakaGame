import type { RateLimitVerdict } from "../infrastructure/RateLimiter";

/**
 * HTTP 侧唯一的错误呈现口径：与全局 `onError`（`transport/App.ts`）产出的形状一致，
 * 客户端与自动化脚本只需要认一种结构，不用按路由分支。
 */
export interface HttpErrorBody {
  error: { code: string; message: string; traceId?: string };
}

export const httpError = (code: string, message: string, traceId?: string): HttpErrorBody => ({
  error: traceId ? { code, message, traceId } : { code, message },
});

/**
 * 取全局 `onRequest` 写入的追踪号：Elysia 的 `set.headers` 值允许数字，
 * 而信封里它只能是字符串或直接省略（独立挂载单条路由的测试没有这一层）。
 */
export const traceIdOf = (headers: Record<string, string | number | undefined>): string | undefined => {
  const raw = headers["x-trace-id"];
  return typeof raw === "string" ? raw : undefined;
};

/**
 * oRPC 前缀下的失败体：客户端把 `defined:false` 解成 `ORPCError`，所以 `/api/rpc/*` 只能认这个形状。
 * 它是全局信封在 RPC 传输层的等价写法——同样的 `code` 与 `message`，只是外层由 oRPC 协议规定。
 */
export interface RpcErrorBody {
  json: { defined: false; code: string; status: number; message: string };
}

export const rpcError = (code: string, status: number, message: string): RpcErrorBody => ({
  json: { defined: false, code, status, message },
});

/**
 * 限流呈现头：`X-RateLimit-*` 说明是哪个桶、还剩多少、什么时候恢复，`Retry-After` 只在被拒时给出。
 * 缺少这些头时，重试的调用方只能靠指数退避猜，猜小了继续撞墙、猜大了白等。
 */
export const rateLimitHeaders = (verdict: RateLimitVerdict): Record<string, string> => {
  const headers: Record<string, string> = {
    "x-ratelimit-limit": String(verdict.limit),
    "x-ratelimit-remaining": String(verdict.remaining),
    "x-ratelimit-reset": String(Math.ceil(verdict.resetAt / 1000)),
  };
  if (!verdict.allowed) headers["retry-after"] = String(Math.ceil(verdict.retryAfterMs / 1000));
  return headers;
};
