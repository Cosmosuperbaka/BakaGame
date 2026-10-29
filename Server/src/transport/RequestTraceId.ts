/** W3C `traceparent`：`版本-32位trace-id-16位parent-id-标志`，全零 trace-id 无效。 */
const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/;
/** Sentry `sentry-trace`：`32位trace-id-16位span-id`，采样位可省略。 */
const SENTRY_TRACE = /^([\da-f]{32})-[\da-f]{16}(?:-[01])?$/;
const ZERO_TRACE = "0".repeat(32);

const traceFrom = (value: string | null, pattern: RegExp): string | undefined => {
  const match = value?.trim().toLowerCase().match(pattern);
  return match && match[1] !== ZERO_TRACE ? match[1] : undefined;
};

/**
 * 一次 HTTP 请求的追踪号。优先级：调用方显式给的 `x-trace-id` / `x-request-id`，
 * 其次是上游已开的 W3C 或 Sentry trace（浏览器端 Sentry 会给同源请求带 `sentry-trace`），
 * 都没有才自造。沿用上游 trace-id 后，日志、OTLP span 与 Sentry 事件落在同一条 trace 上，
 * 而不是各自生成一个互不相识的号。
 */
export const resolveRequestTraceId = (headers: Headers): string =>
  headers.get("x-trace-id") ??
  headers.get("x-request-id") ??
  traceFrom(headers.get("traceparent"), TRACEPARENT) ??
  traceFrom(headers.get("sentry-trace"), SENTRY_TRACE) ??
  crypto.randomUUID();
