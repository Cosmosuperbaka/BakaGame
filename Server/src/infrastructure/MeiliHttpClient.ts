import { Agent, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { MeilisearchApiError, type MeilisearchErrorResponse } from "meilisearch";

/** 响应体大小上限：超出说明对端异常，直接中止比撑爆线程内存安全。 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Meilisearch SDK 的自定义 HTTP 客户端。
 *
 * 背景：SDK 默认走全局 fetch，而 fetch 会把请求头与请求体分两次写入 socket，
 * 在容器网络路径上触发 TCP Nagle + delayed-ACK 组合罚时。这里改用 node:http +
 * keep-alive 连接池：headers 与 body 通过一次 `request.end(body)` 写完，消除该罚时。
 *
 * 契约（对齐 SDK fetch 路径的行为）：
 * - 成功时 resolve 解析后的 JSON（空响应体为 undefined）；
 * - 非 2xx 时抛 MeilisearchApiError（SDK 官方 remarks 要求自定义客户端自行处理 API 错误）；
 *   该错误会被 SDK 包装为 MeilisearchRequestError（cause 指向本错误），
 *   调用侧识别务必使用 isMeiliApiError()，不要直接 instanceof；
 * - 请求级失败向上抛，交由 SDK 统一包装；abort 时原样 reject signal.reason，
 *   以保留 SDK 对超时的判别（内部超时标记为 Symbol，Object.is 匹配）。
 *
 * 注意：SDK 已将 httpClient 配置标记为 deprecated，升级 SDK 大版本前需复查替代机制。
 */
export async function meiliHttpClient(...args: Parameters<typeof fetch>): Promise<unknown> {
  const [input, init] = args;
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  );
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
        let size = 0;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          size += Buffer.byteLength(chunk);
          if (size > MAX_RESPONSE_BYTES) {
            reject(new Error("Meilisearch 响应体过大"));
            request.destroy();
            return;
          }
          data += chunk;
        });
        // 事件回调里抛错不会进入 Promise 链，会变成线程级未捕获异常，
        // 所以所有失败都必须在这里转成 reject。
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("Meilisearch 响应被中断")));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          const ok = status >= 200 && status < 300;
          let parsed: unknown;
          if (data !== "") {
            try {
              parsed = JSON.parse(data) as unknown;
            } catch (error) {
              // 反向代理或实例重启途中常返回 HTML 或纯文本错误页。
              if (ok) {
                reject(new Error("Meilisearch 返回了非 JSON 响应", { cause: error }));
              } else {
                reject(
                  new MeilisearchApiError(toErrorResponse(url, response), {
                    message: `HTTP ${status}：${data.slice(0, 200)}`,
                    code: "non_json_response",
                    type: "system",
                    link: "",
                  })
                );
              }
              return;
            }
          }
          if (!ok) {
            reject(
              new MeilisearchApiError(
                toErrorResponse(url, response),
                parsed as MeilisearchErrorResponse
              )
            );
            return;
          }
          resolve(parsed);
        });
      }
    );
    request.on("error", (error) => {
      if (!aborted) reject(error);
    });

    const signal = init?.signal;
    if (signal != null) {
      const onAbort = () => {
        aborted = true;
        // SDK 依据 Object.is(error, timeoutSymbol) 判别超时，signal.reason 必须
        // 原样抛出；先结算再销毁，销毁引发的 error 由 aborted 守卫屏蔽。
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- reason 可能是 SDK 写入的超时 Symbol，包成 Error 会丢掉判别依据
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
  new Headers(headers).forEach((value, key) => {
    plain[key] = value;
  });
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
