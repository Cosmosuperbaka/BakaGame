import { Elysia } from "elysia";

export interface SentryTunnelOptions {
  allowedProjectIds?: string[];
  fetcher?: typeof fetch;
}

export const sentryTunnelRoutes = ({
  allowedProjectIds = [],
  fetcher = fetch,
}: SentryTunnelOptions = {}) => {
  const allowedSet = new Set(allowedProjectIds.map((id) => String(id).trim()));

  return new Elysia({ name: "sentry-tunnel" }).post(
    "/api/monitoring/sentry",
    async ({ request, set }) => {
      try {
        const rawEnvelope = await request.text();
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

        // 安全防线 1：域名白名单校验，杜绝内网 SSRF 探测
        if (!dsnUrl.host.endsWith(".sentry.io") && !dsnUrl.host.includes("sentry")) {
          set.status = 403;
          return { error: "Forbidden DSN host" };
        }

        // 安全防线 2：项目 ID 白名单校验，杜绝开放式跳板 (Open Relay)
        const projectId = dsnUrl.pathname.replace(/^\/+/, "");
        if (!allowedSet.has(projectId)) {
          set.status = 403;
          return { error: `Project ID "${projectId}" is not allowed` };
        }

        const targetUrl = `https://${dsnUrl.host}/api/${projectId}/envelope/`;
        const response = await fetcher(targetUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-sentry-envelope",
          },
          body: rawEnvelope,
        });

        if (!response.ok) {
          set.status = response.status;
          return { error: "Upstream Sentry error", status: response.status };
        }

        return { ok: true };
      } catch (err) {
        set.status = 500;
        return { error: "Internal Sentry tunnel error", message: String(err) };
      }
    },
    {
      detail: {
        tags: ["System"],
        summary: "Sentry 异常与遥测同源反向代理隧道",
        description: "接收前端 Sentry 信封包，安全校验后中转至 Sentry Ingest，免疫浏览器广告拦截插件并保障中国大陆连通性。",
      },
      parse: "none", // 接收 raw 文本，保留换行符用于 Envelope 协议解析
    },
  );
};
