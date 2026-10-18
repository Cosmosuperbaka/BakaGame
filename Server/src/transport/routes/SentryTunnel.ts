import { Elysia } from "elysia";
import { ThreeTierRateLimiter } from "../../infrastructure/RateLimiter";
import type { EventLogger } from "../../infrastructure/EventLogger";
import { httpError, rateLimitHeaders, traceIdOf, type HttpErrorBody } from "../HttpErrorEnvelope";
import { resolveClientIp } from "../ClientIp";

export const MAX_ENVELOPE_BYTES = 256 * 1024; // 256KB

const SENTRY_INGEST_REGEX =
  /^[a-z0-9-]+\.(ingest\.sentry\.io|ingest\.us\.sentry\.io|ingest\.de\.sentry\.io)$/i;

/**
 * 隧道限流用的就是通用三层桶（单客户端 / 回源 peer / 全局），口径与打点、账号入口一致：
 * 单客户端桶按真实客户端 IP 分（ESA 托管转换写入的标头），否则同一 ESA 节点后面
 * 的所有玩家会共享一个桶，按用户计的上报预算就退化成按节点计；peer 桶只封顶
 * 「伪造标头自造新桶」这一条滥用路径，因此给到单客户端预算的十倍。
 * 仍按用途导出这个名字，调用方不必知道通用类的存在。
 */
export const SentryTunnelRateLimiter = ThreeTierRateLimiter;
export type SentryTunnelRateLimiter = ThreeTierRateLimiter;

export interface SentryTunnelOptions {
  allowedProjectIds?: string[];
  allowedHosts?: string[];
  sentryDsn?: string;
  fetcher?: typeof fetch;
  rateLimiter?: SentryTunnelRateLimiter;
  logger?: Pick<EventLogger, "error" | "warn" | "info">;
}

const isHostAllowed = (hostname: string, allowedHosts: Set<string>): boolean => {
  const lower = hostname.toLowerCase();
  if (allowedHosts.has(lower)) {
    return true;
  }
  return SENTRY_INGEST_REGEX.test(lower);
};

/**
 * 隧道校验链的一处失败：状态码与错误码由具体环节决定，出口处统一包成全局错误信封。
 */
type TunnelFailure = { status: number; code: string; message: string };

/** 校验环节的产出：要么拿到下一步需要的值，要么带着失败直接出口。 */
type TunnelStep<T> = { value: T } | { failure: TunnelFailure };

const tunnelFailure = (status: number, code: string, message: string): TunnelFailure => ({
  status,
  code,
  message,
});

const rejectStep = (status: number, code: string, message: string): TunnelStep<never> => ({
  failure: tunnelFailure(status, code, message),
});

const isRejected = <T>(step: TunnelStep<T>): step is { failure: TunnelFailure } =>
  "failure" in step;

// DSN 的项目路径只允许单段 ID，其他形态一律视为非法路径。
const DSN_PROJECT_PATH_PATTERN = /^\/([0-9a-zA-Z_-]+)$/;

const ENVELOPE_HEADER_SEPARATOR = 10; // "\n" 的字节值，信封首行与正文在此分隔

export type SentryTunnelPolicy = {
  allowedProjects: Set<string>;
  allowedHosts: Set<string>;
};

// Bun、Node 与 undici 对上游连接失败使用完全不同的文案与 errno 编号。
// 只识别 Node 的旧文案会把真实的网络抖动误判为内部故障，向下游返回 500
// 并触发错误告警，因此这里必须收口全部运行时的失败签名。
const UPSTREAM_NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "CONNECTIONREFUSED",
  "CONNECTIONRESET",
  "CONNECTIONCLOSED",
  "FAILEDTOOPENSOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const UPSTREAM_NETWORK_MESSAGE_PATTERN =
  /fetch failed|network|dns|econnrefused|econnreset|etimedout|eai_again|enotfound|epipe|und_err|unable to connect|connection (?:refused|reset|closed)|failed to open socket|socket (?:hang up|closed|connection was closed)|the connection was closed/i;

const readErrorField = (value: unknown, key: "name" | "message" | "code"): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
};

// 上游失败常被逐层包装（fetch → socket），必须下钻 cause 链才能识别真实病因。
const walkErrorChain = (error: unknown): unknown[] => {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    chain.push(current);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
};

const isUpstreamTimeout = (error: unknown): boolean =>
  walkErrorChain(error).some((item) => {
    const name = readErrorField(item, "name");
    return name === "AbortError" || name === "TimeoutError";
  });

const isUpstreamNetworkFailure = (error: unknown): boolean =>
  walkErrorChain(error).some((item) => {
    if (item instanceof TypeError) return true;
    const code = readErrorField(item, "code");
    if (code && UPSTREAM_NETWORK_ERROR_CODES.has(code.toUpperCase())) return true;
    const name = readErrorField(item, "name") ?? "";
    const message = readErrorField(item, "message") ?? "";
    return UPSTREAM_NETWORK_MESSAGE_PATTERN.test(`${name} ${message}`);
  });

/**
 * 上游异常的归类：超时与网络失败只算降级（warn），其余才是内部故障（error）。
 * 归类结果同时决定回给客户端的状态码与响应体。
 */
const classifyTunnelError = (error: unknown): TunnelFailure => {
  if (isUpstreamTimeout(error))
    return tunnelFailure(504, "UPSTREAM_TIMEOUT", "Sentry upstream timeout");
  if (isUpstreamNetworkFailure(error))
    return tunnelFailure(502, "UPSTREAM_UNAVAILABLE", "Sentry upstream unavailable");
  return tunnelFailure(500, "INTERNAL_ERROR", "Internal Sentry tunnel error");
};

const reportTunnelError = (
  logger: SentryTunnelOptions["logger"],
  error: unknown,
  failure: TunnelFailure
): void => {
  if (failure.status === 504) {
    logger?.warn("Sentry tunnel upstream timeout", {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (failure.status === 502) {
    logger?.warn("Sentry tunnel upstream unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  logger?.error("Internal Sentry tunnel error", {
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
};

/**
 * 上游状态码不透给浏览器：403 / 404 / 413 会把「这个 DSN 有没有被吊销、项目存不存在」
 * 这类 Sentry 侧的内部结论白送给任意匿名调用方。只保留调用方确实要据此决策的两类信号——
 * 429（该退避）与 5xx（上游不可用），其余统一折叠成 502。
 */
const upstreamFailure = (response: Response): TunnelFailure => {
  if (response.status === 429)
    return tunnelFailure(429, "UPSTREAM_RATE_LIMITED", "Sentry upstream rate limited");
  if (response.status >= 500)
    return tunnelFailure(502, "UPSTREAM_UNAVAILABLE", "Sentry upstream unavailable");
  return tunnelFailure(502, "UPSTREAM_REJECTED", "Sentry upstream rejected the envelope");
};

/**
 * 上游的退避指令要转达：Sentry SDK 靠 `Retry-After` 与 `X-Sentry-Rate-Limits` 决定何时重试，
 * 收不到就按自己的节奏反复撞墙。上游没给 `Retry-After` 时退回本地窗口的剩余时间——
 * §12.7 的口径是「任何 429 一律带 Retry-After」，不能因为上游省略就发空头。
 * 值封顶两分钟，避免上游给个荒谬数字把前端钉死；其它状态码带同名头没有意义（例如 413），只认 429。
 */
const upstreamBackoffHeaders = (
  response: Response,
  fallbackRetryAfterMs: number
): Record<string, string> => {
  if (response.status !== 429) return {};
  const declared = Number(response.headers.get("retry-after"));
  const seconds =
    Number.isFinite(declared) && declared > 0
      ? Math.ceil(declared)
      : Math.ceil(fallbackRetryAfterMs / 1000);
  const headers: Record<string, string> = {
    "retry-after": String(Math.min(Math.max(seconds, 1), 120)),
  };
  const sentryLimits = response.headers.get("x-sentry-rate-limits");
  if (sentryLimits) headers["x-sentry-rate-limits"] = sentryLimits.slice(0, 256);
  return headers;
};

/** 按上游字节流累积信封，超限即刻取消读取，不再继续缓存。 */
const collectEnvelopeChunks = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunks: Uint8Array[]
): Promise<number | null> => {
  let byteLength = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return byteLength;
    byteLength += chunk.value.byteLength;
    if (byteLength > MAX_ENVELOPE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
};

const concatEnvelopeChunks = (
  chunks: Uint8Array[],
  byteLength: number
): Uint8Array<ArrayBuffer> => {
  const rawEnvelope = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    rawEnvelope.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return rawEnvelope;
};

/** 读取请求体为信封原始字节；首行的换行位置由调用方解析。 */
const readEnvelopePayload = async (
  request: Request
): Promise<TunnelStep<Uint8Array<ArrayBuffer>>> => {
  const chunks: Uint8Array[] = [];
  const reader = request.body?.getReader();
  let byteLength = 0;
  if (reader) {
    try {
      const collected = await collectEnvelopeChunks(reader, chunks);
      if (collected === null) return rejectStep(413, "PAYLOAD_TOO_LARGE", "Payload Too Large");
      byteLength = collected;
    } finally {
      reader.releaseLock();
    }
  }

  const rawEnvelope = concatEnvelopeChunks(chunks, byteLength);
  if (rawEnvelope.byteLength === 0)
    return rejectStep(400, "INVALID_ENVELOPE", "Empty envelope payload");
  return { value: rawEnvelope };
};

/** 解码信封首行；非法 UTF-8 与「合法但为空」是两种不同的 400，必须区分。 */
const decodeEnvelopeHeaderLine = (rawEnvelope: Uint8Array): { text: string } | null => {
  const newline = rawEnvelope.indexOf(ENVELOPE_HEADER_SEPARATOR);
  try {
    const headerText = new TextDecoder("utf-8", { fatal: true }).decode(
      rawEnvelope.subarray(0, newline >= 0 ? newline : rawEnvelope.length)
    );
    return { text: headerText };
  } catch {
    return null;
  }
};

const isPlainEnvelopeHeader = (parsed: unknown): parsed is { dsn?: string } =>
  typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);

/** 从信封首行取出 DSN 字符串，任一环节不合规则按原状态码回绝。 */
const readDsnFromEnvelope = (rawEnvelope: Uint8Array): TunnelStep<string> => {
  const headerLine = decodeEnvelopeHeaderLine(rawEnvelope);
  if (!headerLine) return rejectStep(400, "INVALID_ENVELOPE", "Invalid envelope header encoding");
  if (!headerLine.text) return rejectStep(400, "INVALID_ENVELOPE", "Invalid envelope header");

  let parsedHeader: unknown;
  try {
    parsedHeader = JSON.parse(headerLine.text);
  } catch {
    return rejectStep(400, "INVALID_ENVELOPE", "Failed to parse envelope header JSON");
  }
  if (!isPlainEnvelopeHeader(parsedHeader)) {
    return rejectStep(400, "INVALID_ENVELOPE", "Failed to parse envelope header JSON");
  }

  const dsn = parsedHeader.dsn;
  if (typeof dsn !== "string" || !dsn)
    return rejectStep(400, "MISSING_DSN", "Missing DSN in envelope header");
  return { value: dsn };
};

const parseDsnUrl = (dsn: string): URL | null => {
  try {
    return new URL(dsn);
  } catch {
    return null;
  }
};

/** 安全防线 1—3：协议、端口、域名白名单，杜绝内网 SSRF 与开放中继。 */
const rejectUntrustedDsnTransport = (
  dsnUrl: URL,
  allowedHosts: Set<string>
): TunnelFailure | null => {
  if (dsnUrl.protocol !== "https:")
    return tunnelFailure(403, "FORBIDDEN_DSN_PROTOCOL", "Forbidden DSN protocol");
  if (dsnUrl.port && dsnUrl.port !== "443")
    return tunnelFailure(403, "FORBIDDEN_DSN_PORT", "Forbidden DSN port");
  if (!isHostAllowed(dsnUrl.hostname, allowedHosts))
    return tunnelFailure(403, "FORBIDDEN_DSN_HOST", "Forbidden DSN host");
  return null;
};

/**
 * 安全防线 4：DSN 必须只经 HTTPS/443 指向白名单域名下的单段项目 ID，
 * 且该项目在允许列表内；通过后返回回源 envelope 端点。
 */
const resolveTrustedEnvelopeUrl = (dsn: string, policy: SentryTunnelPolicy): TunnelStep<string> => {
  const dsnUrl = parseDsnUrl(dsn);
  if (!dsnUrl) return rejectStep(400, "MALFORMED_DSN", "Malformed DSN URL in envelope header");

  const transportRejection = rejectUntrustedDsnTransport(dsnUrl, policy.allowedHosts);
  if (transportRejection) return { failure: transportRejection };

  const match = dsnUrl.pathname.match(DSN_PROJECT_PATH_PATTERN);
  if (!match) return rejectStep(403, "INVALID_DSN_PATH", "Invalid DSN project path");

  const projectId = match[1];
  if (!policy.allowedProjects.has(projectId)) {
    return rejectStep(403, "PROJECT_NOT_ALLOWED", `Project ID "${projectId}" is not allowed`);
  }

  return { value: `https://${dsnUrl.hostname}/api/${projectId}/envelope/` };
};

const sendEnvelopeToSentry = (
  fetcher: typeof fetch,
  targetUrl: string,
  rawEnvelope: Uint8Array<ArrayBuffer>
): Promise<Response> =>
  fetcher(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-sentry-envelope",
    },
    body: rawEnvelope,
    signal: AbortSignal.timeout(10_000),
  });

export const sentryTunnelRoutes = ({
  allowedProjectIds = [],
  allowedHosts = [],
  sentryDsn,
  fetcher = fetch,
  rateLimiter,
  logger,
}: SentryTunnelOptions = {}) => {
  const allowedSet = new Set(allowedProjectIds.map((id) => String(id).trim()).filter(Boolean));
  const allowedHostSet = new Set(allowedHosts.map((h) => h.toLowerCase().trim()).filter(Boolean));

  if (sentryDsn) {
    try {
      const parsedDsn = new URL(sentryDsn);
      if (parsedDsn.hostname) {
        allowedHostSet.add(parsedDsn.hostname.toLowerCase().trim());
      }
    } catch {
      // 忽略非法配置的 sentryDsn
    }
  }

  const limiter = rateLimiter ?? new SentryTunnelRateLimiter();
  const policy: SentryTunnelPolicy = { allowedProjects: allowedSet, allowedHosts: allowedHostSet };

  return new Elysia({ name: "sentry-tunnel" }).post(
    "/api/monitoring/sentry",
    async ({ request, set, server }) => {
      // 失败出口只有一处：状态码与错误码由校验环节决定，信封形状统一由 HttpErrorEnvelope 产出。
      const traceId = traceIdOf(set.headers);
      const reject = (failure: TunnelFailure): HttpErrorBody => {
        set.status = failure.status;
        return httpError(failure.code, failure.message, traceId);
      };
      try {
        // 客户端身份取 ESA 托管转换写入的真实 IP 标头（无法被客户端伪造），
        // 缺失或不是 IP 字面量时退回 transport peer；peer 桶另行封顶，防止标头被伪造成新桶。
        const peerIp = server?.requestIP(request)?.address ?? "unknown";
        const clientIp = resolveClientIp(request.headers, peerIp);

        const verdict = limiter.consume(clientIp, peerIp);
        Object.assign(set.headers, rateLimitHeaders(verdict));
        if (!verdict.allowed)
          return reject(tunnelFailure(429, "RATE_LIMITED", "Too Many Requests"));

        const contentLength = request.headers.get("content-length");
        if (contentLength && Number.parseInt(contentLength, 10) > MAX_ENVELOPE_BYTES) {
          return reject(tunnelFailure(413, "PAYLOAD_TOO_LARGE", "Payload Too Large"));
        }

        const envelope = await readEnvelopePayload(request);
        if (isRejected(envelope)) return reject(envelope.failure);

        const dsn = readDsnFromEnvelope(envelope.value);
        if (isRejected(dsn)) return reject(dsn.failure);

        const targetUrl = resolveTrustedEnvelopeUrl(dsn.value, policy);
        if (isRejected(targetUrl)) return reject(targetUrl.failure);

        const response = await sendEnvelopeToSentry(fetcher, targetUrl.value, envelope.value);

        if (!response.ok) {
          // 本地桶此刻仍是放行的，resetAt 就等于整窗口——上游没说什么时候能再来时，用它兜底。
          Object.assign(
            set.headers,
            upstreamBackoffHeaders(response, Math.max(1, verdict.resetAt - Date.now()))
          );
          return reject(upstreamFailure(response));
        }

        return { ok: true };
      } catch (err) {
        const failure = classifyTunnelError(err);
        reportTunnelError(logger, err, failure);
        return reject(failure);
      }
    },
    {
      detail: {
        tags: ["System"],
        summary: "Sentry 异常与遥测同源反向代理隧道",
        description:
          "接收前端 Sentry 信封包，安全校验后中转至 Sentry Ingest，免疫浏览器广告拦截插件并保障中国大陆连通性。",
      },
      parse: "none", // 接收 raw 文本，保留换行符用于 Envelope 协议解析
    }
  );
};
