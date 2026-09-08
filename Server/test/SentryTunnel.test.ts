import { describe, expect, it } from "bun:test";
import {
  MAX_ENVELOPE_BYTES,
  sentryTunnelRoutes,
  SentryTunnelRateLimiter,
} from "../src/transport/routes/SentryTunnel";

describe("SentryTunnel (同源信封代理与安全校验)", () => {
  const allowedProjectIds = ["100001", "100002"];

  it("拦截空载荷并返回 400", async () => {
    const app = sentryTunnelRoutes({ allowedProjectIds });
    const res = await app.handle(
      new Request("http://localhost/api/monitoring/sentry", {
        method: "POST",
        body: "",
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("Empty envelope payload");
  });

  it("拦截畸形 JSON 头部并返回 400", async () => {
    const app = sentryTunnelRoutes({ allowedProjectIds });
    const res = await app.handle(
      new Request("http://localhost/api/monitoring/sentry", {
        method: "POST",
        body: "{not-json\n{}\n{}",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("拦截缺少 DSN 的信封并返回 400", async () => {
    const app = sentryTunnelRoutes({ allowedProjectIds });
    const res = await app.handle(
      new Request("http://localhost/api/monitoring/sentry", {
        method: "POST",
        body: JSON.stringify({ sdk: { name: "sentry.javascript.react" } }),
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("Missing DSN in envelope header");
  });

  it("防范 SSRF：拦截非官方 Ingest 且未授权的外部恶意域名 (如 sentry.evil.example) 并返回 403", async () => {
    const app = sentryTunnelRoutes({ allowedProjectIds });
    const payload = `${JSON.stringify({ dsn: "https://x@sentry.evil.example/100001" })}\n{}\n{}`;
    const res = await app.handle(
      new Request("http://localhost/api/monitoring/sentry", {
        method: "POST",
        body: payload,
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("Forbidden DSN host");
  });

  it("安全防线：拦截不安全 HTTP 协议并返回 403", async () => {
    const app = sentryTunnelRoutes({ allowedProjectIds });
    const payload = `${JSON.stringify({ dsn: "http://o000000.ingest.us.sentry.io/100001" })}\n{}\n{}`;
    const res = await app.handle(
      new Request("http://localhost/api/monitoring/sentry", {
        method: "POST",
        body: payload,
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("Forbidden DSN protocol");
  });

  it("安全防线：拦截非 443 自定义端口并返回 403", async () => {
    const app = sentryTunnelRoutes({ allowedProjectIds });
    const payload = `${JSON.stringify({ dsn: "https://o000000.ingest.us.sentry.io:8443/100001" })}\n{}\n{}`;
    const res = await app.handle(
      new Request("http://localhost/api/monitoring/sentry", {
        method: "POST",
        body: payload,
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("Forbidden DSN port");
  });

  it("安全防线：拦截非法 DSN 路径格式并返回 403", async () => {
    const app = sentryTunnelRoutes({ allowedProjectIds });
    const payload = `${JSON.stringify({ dsn: "https://o000000.ingest.us.sentry.io/100001/malicious/path" })}\n{}\n{}`;
    const res = await app.handle(
      new Request("http://localhost/api/monitoring/sentry", {
        method: "POST",
        body: payload,
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("Invalid DSN project path");
  });

  it("防范开放中继：拦截不在白名单内的未知 project ID 并返回 403", async () => {
    const app = sentryTunnelRoutes({ allowedProjectIds });
    const payload = `${JSON.stringify({ dsn: "https://mockkey@o000000.ingest.us.sentry.io/999999" })}\n{}\n{}`;
    const res = await app.handle(
      new Request("http://localhost/api/monitoring/sentry", {
        method: "POST",
        body: payload,
      }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toContain("is not allowed");
  });

  it("安全防线：拦截超出 256KB 限制的超大载荷并返回 413 Payload Too Large", async () => {
    const app = sentryTunnelRoutes({ allowedProjectIds });
    const hugeBody = "a".repeat(MAX_ENVELOPE_BYTES + 1024);
    const res = await app.handle(
      new Request("http://localhost/api/monitoring/sentry", {
        method: "POST",
        body: hugeBody,
      }),
    );
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("Payload Too Large");
  });

  it("应用级限流：请求频率超限时返回 429 Too Many Requests", async () => {
    const mockFetcher = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const limiter = new SentryTunnelRateLimiter({ windowMs: 60_000, maxRequests: 2 });
    const app = sentryTunnelRoutes({ allowedProjectIds, rateLimiter: limiter, fetcher: mockFetcher });
    const payload = `${JSON.stringify({ dsn: "https://mockkey@o000000.ingest.us.sentry.io/100001" })}\n{}\n{}`;

    const headers = { "x-forwarded-for": "192.168.1.100" };
    const r1 = await app.handle(
      new Request("http://localhost/api/monitoring/sentry", { method: "POST", body: payload, headers }),
    );
    expect(r1.status).toBe(200);

    const r2 = await app.handle(
      new Request("http://localhost/api/monitoring/sentry", { method: "POST", body: payload, headers }),
    );
    expect(r2.status).toBe(200);

    const r3 = await app.handle(
      new Request("http://localhost/api/monitoring/sentry", { method: "POST", body: payload, headers }),
    );
    expect(r3.status).toBe(429);
    const json = (await r3.json()) as { error?: string };
    expect(json.error).toBe("Too Many Requests");
  });

  it("合法信封通过 Mock fetcher 安全转发至 Sentry 端点并返回 200", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    const mockFetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "GET";
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ id: "event-id-123" }), { status: 200 });
    }) as unknown as typeof fetch;

    const app = sentryTunnelRoutes({ allowedProjectIds, fetcher: mockFetcher });
    const envelope = `${JSON.stringify({ dsn: "https://mockkey@o000000.ingest.us.sentry.io/100001" })}\n{"type":"event"}\n{"message":"Test React Crash"}`;

    const res = await app.handle(
      new Request("http://localhost/api/monitoring/sentry", {
        method: "POST",
        body: envelope,
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok?: boolean };
    expect(json.ok).toBe(true);

    expect(capturedUrl).toBe("https://o000000.ingest.us.sentry.io/api/100001/envelope/");
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders["Content-Type"]).toBe("application/x-sentry-envelope");
    expect(capturedBody).toBe(envelope);
  });

  it("支持通过 allowedHosts 与 sentryDsn 配置企业私有 Sentry 域名", async () => {
    const mockFetcher = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const app = sentryTunnelRoutes({
      allowedProjectIds: ["200"],
      sentryDsn: "https://key@sentry.mycorp.example/200",
      fetcher: mockFetcher,
    });
    const envelope = `${JSON.stringify({ dsn: "https://key@sentry.mycorp.example/200" })}\n{}\n{}`;
    const res = await app.handle(
      new Request("http://localhost/api/monitoring/sentry", {
        method: "POST",
        body: envelope,
      }),
    );
    expect(res.status).toBe(200);
  });

  it("上游 Sentry 报错时透传相应状态码", async () => {
    const mockFetcher = (async () => {
      return new Response("Too Many Requests", { status: 429 });
    }) as unknown as typeof fetch;

    const app = sentryTunnelRoutes({ allowedProjectIds, fetcher: mockFetcher });
    const envelope = `${JSON.stringify({ dsn: "https://mockkey@o000000.ingest.us.sentry.io/100001" })}\n{}\n{}`;

    const res = await app.handle(
      new Request("http://localhost/api/monitoring/sentry", {
        method: "POST",
        body: envelope,
      }),
    );

    expect(res.status).toBe(429);
  });

  it("上游 fetch 异常时脱敏，返回 500 且不泄露堆栈与内部异常信息", async () => {
    const errorFetcher = (async () => {
      throw new Error("DNS resolution failure to internal-network-secret:8080");
    }) as unknown as typeof fetch;

    const loggedErrors: unknown[] = [];
    const mockLogger = {
      error: (msg: string, ctx?: unknown) => loggedErrors.push({ msg, ctx }),
      warn: () => {},
      info: () => {},
    };

    const app = sentryTunnelRoutes({
      allowedProjectIds,
      fetcher: errorFetcher,
      logger: mockLogger,
    });
    const envelope = `${JSON.stringify({ dsn: "https://mockkey@o000000.ingest.us.sentry.io/100001" })}\n{}\n{}`;

    const res = await app.handle(
      new Request("http://localhost/api/monitoring/sentry", {
        method: "POST",
        body: envelope,
      }),
    );

    expect(res.status).toBe(500);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("Internal Sentry tunnel error");
    expect(json.message).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain("internal-network-secret");
    expect(loggedErrors.length).toBe(1);
  });
});
