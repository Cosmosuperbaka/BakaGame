import { HTTP_JSON_TIMEOUT_MS } from "@/config/Constants";
import { resolveServerUrl } from "@/lib/ServerEndpoint";

/** 非 2xx 应答：带状态码，调用方按需区分。 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export interface FetchJsonOptions {
  /** 报错文案里的接口名：`${label}返回 HTTP 503`。 */
  label: string;
  /** 总超时（含读响应体），后端挂起时不会让调用方永远等下去。 */
  timeoutMs?: number;
  /** 调用方的取消信号，与超时任一触发即中止。 */
  signal?: AbortSignal;
  /** 透传给 `fetch` 的其余选项（缓存策略、请求头）。 */
  init?: Omit<RequestInit, "signal">;
  /** 响应头到达时的毫秒数（从发出请求算起），只在 2xx 时回调。 */
  onRoundTrip?: (milliseconds: number) => void;
}

/**
 * 站点自己的 HTTP JSON 接口（不在 oRPC 契约里的原生路由）统一从这里取：
 * 带超时与取消，非 2xx 抛 `HttpError`，成功返回未经校验的 JSON，形状交给各调用方按自己的容忍度解析。
 */
export const fetchJson = async (path: string, options: FetchJsonOptions): Promise<unknown> => {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? HTTP_JSON_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const startedAt = performance.now();
  const response = await fetch(resolveServerUrl(path), { ...options.init, signal });
  if (!response.ok) {
    throw new HttpError(response.status, `${options.label}返回 HTTP ${response.status}`);
  }
  options.onRoundTrip?.(Math.max(0, Math.round(performance.now() - startedAt)));
  return response.json() as Promise<unknown>;
};
