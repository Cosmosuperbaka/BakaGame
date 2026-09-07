import { describe, expect, it } from "bun:test";
import { sentryTunnelRoutes } from "../src/transport/routes/SentryTunnel";

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

  it("防范 SSRF：拦截非 sentry.io 目标主机并返回 403", async () => {
    const app = sentryTunnelRoutes({ allowedProjectIds });
    const payload = `${JSON.stringify({ dsn: "http://internal-service.local/100001" })}\n{}\n{}`;
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
});
