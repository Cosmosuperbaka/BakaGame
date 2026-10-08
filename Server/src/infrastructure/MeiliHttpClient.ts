import { Agent, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { MeilisearchApiError, type MeilisearchErrorResponse } from "meilisearch";

/**
 * Meilisearch SDK 的自定义 HTTP 客户端。
 *
 * 背景：SDK 默认走全局 fetch，而 fetch 会把请求头与请求体分两次写入 socket，
 * 在容器网络路径上触发 TCP Nagle + delayed-ACK 组合罚时（实测每次请求约 40ms，
 * Bun 与 Node 的 fetch 均复现；node:http 单次写入则无罚时）。
 * 这里改用 node:http + keep-alive 连接池：headers 与 body 通过一次
 * `request.end(body)` 写完，实测把容器内每次搜索从 ~45ms 降到 ~2-4ms。
 *
 * 契约（对齐 SDK fetch 路径的行为）：
 * - 成功时 resolve 解析后的 JSON（空响应体为 undefined）；
 * - 非 2xx 时抛 MeilisearchApiError（SDK 官方 remarks 要求自定义客户端自行处理 API 错误）；
 *   该错误会被 SDK 包装为 MeilisearchRequestError（cause 指向本错误），
 *   调用侧识别务必使用 isMeiliApiError()，不要直接 instanceof；
 * - 请求级失败向上抛，交由 SDK 统一包装；abort 时原样 reject signal.reason，
 *   以保留 SDK 对超时的判别（内部超时标记为 Symbol，Object.is 匹配）。
 *
 * 注意：SDK 将 httpClient 配置标记为 deprecated（meilisearch-js#1824），
 * 升级 SDK 大版本前需按该 issue 复查替代机制。
 */
export async function meiliHttpClient(...args: Parameters<typeof fetch>): Promise<unknown> {
  const [input, init] = args;
  const url = new URL(String(input));
  const payload = typeof init?.body === "string" ? init.body : undefined;
  const headers = toPlainHeaders(init?.headers);
  if (payload !== undefined) headers["content-length"] = String(Buffer.byteLength(payload));

  return new Promise<unknown>((resolve, reject) => {
    let aborted = false;
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        host: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: url.pathname + url.search,
        method: init?.method ?? "GET",
        agent: url.protocol === "https:" ? keepAliveHttps : keepAliveHttp,
        headers,
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { data += chunk; });
        response.on("end", () => {
          const parsed = data === "" ? undefined : (JSON.parse(data) as unknown);
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new MeilisearchApiError(toErrorResponse(url, response), parsed as MeilisearchErrorResponse));
            return;
          }
          resolve(parsed);
        });
      },
    );
    request.on("error", (error) => { if (!aborted) reject(error); });

    const signal = init?.signal;
    if (signal != null) {
      const onAbort = () => {
        aborted = true;
        // SDK 依据 Object.is(error, timeoutSymbol) 判别超时。必须先以
        // signal.reason 结算再销毁请求：部分运行时（bun）的 destroy 会同步
        // 触发 error 事件，顺序颠倒会把超时标记覆盖成普通 socket 错误。
        reject(signal.reason ?? new Error("The operation was aborted"));
        request.destroy();
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      request.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    request.end(payload);
  });
}

/**
 * 判定错误是否为指定 code 的 Meilisearch API 错误。
 *
 * 自定义 httpClient 抛出的 MeilisearchApiError 会被 SDK 包装为
 * MeilisearchRequestError（cause 指向原错误）；而这里沿 cause 链逐层查找，
 * 同时兼容默认 fetch 路径（错误未被包装）的形态。
 */
export function isMeiliApiError(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current != null; depth += 1) {
    if (current instanceof MeilisearchApiError && current.cause?.code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const keepAliveHttp = new Agent({ keepAlive: true, maxSockets: 16 });
const keepAliveHttps = new Agent({ keepAlive: true, maxSockets: 16 });

function toPlainHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const plain: Record<string, string> = {};
  if (headers === undefined) return plain;
  new Headers(headers).forEach((value, key) => { plain[key] = value; });
  return plain;
}

/** 构造 MeilisearchApiError 需要的最小 Response 形状（该错误仅读取 status/statusText）。 */
function toErrorResponse(url: URL, response: IncomingMessage): Response {
  return {
    url: url.toString(),
    status: response.statusCode ?? 0,
    statusText: response.statusMessage ?? "",
  } as unknown as Response;
}
