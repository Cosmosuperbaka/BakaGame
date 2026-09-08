import { Elysia } from "elysia";
import type { EventLogger } from "../../infrastructure/EventLogger";

export const MAX_ENVELOPE_BYTES = 256 * 1024; // 256KB

const SENTRY_INGEST_REGEX =
  /^[a-z0-9-]+\.(ingest\.sentry\.io|ingest\.us\.sentry\.io|ingest\.de\.sentry\.io)$/i;

export class SentryTunnelRateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(options: { windowMs?: number; maxRequests?: number } = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRequests = options.maxRequests ?? 60;
  }

  public allow(key: string, now = Date.now()): boolean {
    const windowStart = now - this.windowMs;
    const timestamps = (this.windows.get(key) ?? []).filter((t) => t > windowStart);
    if (timestamps.length >= this.maxRequests) {
      this.windows.set(key, timestamps);
      return false;
    }
    timestamps.push(now);
    this.windows.set(key, timestamps);

    if (this.windows.size > 1000) {
      for (const [k, ts] of this.windows.entries()) {
        const valid = ts.filter((t) => t > windowStart);
        if (valid.length === 0) {
          this.windows.delete(k);
        } else {
          this.windows.set(k, valid);
        }
      }
    }

    return true;
  }

  public reset(): void {
    this.windows.clear();
  }
}

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

  return new Elysia({ name: "sentry-tunnel" }).post(
    "/api/monitoring/sentry",
    async ({ request, set }) => {
      try {
        const clientIp =
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          request.headers.get("x-real-ip")?.trim() ||
          "127.0.0.1";

        if (!limiter.allow(clientIp)) {
          set.status = 429;
          return { error: "Too Many Requests" };
        }

        const contentLength = request.headers.get("content-length");
        if (contentLength && Number.parseInt(contentLength, 10) > MAX_ENVELOPE_BYTES) {
          set.status = 413;
          return { error: "Payload Too Large" };
        }

        const rawEnvelope = await request.text();
        if (Buffer.byteLength(rawEnvelope, "utf8") > MAX_ENVELOPE_BYTES) {
          set.status = 413;
          return { error: "Payload Too Large" };
        }

        if (!rawEnvelope || !rawEnvelope.trim()) {
          set.status = 400;
          return { error: "Empty envelope payload" };
        }

        const firstLine = rawEnvelope.split("\n")[0];
        if (!firstLine) {
          set.status = 400;
          return { error: "Invalid envelope header" };
        }

        let header: { dsn?: string };
        try {
          header = JSON.parse(firstLine) as { dsn?: string };
        } catch {
          set.status = 400;
          return { error: "Failed to parse envelope header JSON" };
        }

        if (!header.dsn) {
          set.status = 400;
          return { error: "Missing DSN in envelope header" };
        }

        let dsnUrl: URL;
        try {
          dsnUrl = new URL(header.dsn);
        } catch {
          set.status = 400;
          return { error: "Malformed DSN URL in envelope header" };
        }

        // 安全防线 1：严格 HTTPS 协议
        if (dsnUrl.protocol !== "https:") {
          set.status = 403;
          return { error: "Forbidden DSN protocol" };
        }

        // 安全防线 2：严格默认 443 端口
        if (dsnUrl.port && dsnUrl.port !== "443") {
          set.status = 403;
          return { error: "Forbidden DSN port" };
        }

        // 安全防线 3：域名白名单与权威 Ingest 通配校验，杜绝内网 SSRF 与开放中继
        if (!isHostAllowed(dsnUrl.hostname, allowedHostSet)) {
          set.status = 403;
          return { error: "Forbidden DSN host" };
        }

        // 安全防线 4：项目 ID 路径格式与白名单校验
        const match = dsnUrl.pathname.match(/^\/([0-9a-zA-Z_-]+)$/);
        if (!match) {
          set.status = 403;
          return { error: "Invalid DSN project path" };
        }

        const projectId = match[1];
        if (!allowedSet.has(projectId)) {
          set.status = 403;
          return { error: `Project ID "${projectId}" is not allowed` };
        }

        const targetUrl = `https://${dsnUrl.hostname}/api/${projectId}/envelope/`;
        const response = await fetcher(targetUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-sentry-envelope",
          },
          body: rawEnvelope,
          signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
          set.status = response.status;
          return { error: "Upstream Sentry error", status: response.status };
        }

        return { ok: true };
      } catch (err) {
        logger?.error("Internal Sentry tunnel error", {
          error: err instanceof Error ? err.stack ?? err.message : String(err),
        });
        set.status = 500;
        return { error: "Internal Sentry tunnel error" };
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
    },
  );
};
