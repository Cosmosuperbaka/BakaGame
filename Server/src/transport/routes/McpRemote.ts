import { Elysia } from "elysia";
import type { EventLogger } from "../../infrastructure/EventLogger";
import { handleRemoteMcp, RemoteMcpSessions } from "../../mcp/Remote";
import type { PageControlPort } from "../../mcp/Tools";
import { resolveClientIp } from "../ClientIp";

/**
 * 远程 MCP（Streamable HTTP）入口。
 * 支持 2025 系列的 initialize + Mcp-Session-Id，也接受 2026-07-28 的无状态请求；
 * 无状态客户端把 create_room / join_room 返回的 session 放进后续工具参数即可。
 * `pages` 是页面接管租约：只有站内远程 MCP 能认领人类浏览器，stdio 入口拿不到它。
 */
export const mcpRemoteRoutes = ({
  enabled,
  logger,
  sessions,
  pages,
}: {
  enabled: boolean;
  logger: EventLogger;
  sessions: RemoteMcpSessions;
  pages?: PageControlPort;
}) =>
  new Elysia({ name: "mcp-remote", normalize: false })
    .post("/api/mcp", async ({ request, body, set, server }) => {
      const clientKey = resolveClientIp(request.headers, server?.requestIP(request)?.address);
      const outcome = await handleRemoteMcp(
        { enabled, sessions, logger, pages },
        request,
        body,
        clientKey
      );
      set.status = outcome.status;
      for (const [key, value] of Object.entries(outcome.headers)) set.headers[key] = value;
      set.headers["cache-control"] = "no-store";
      set.headers["mcp-protocol-version"] = "2025-06-18";
      if (outcome.payload === null) return new Response(null, { status: outcome.status });
      return outcome.payload;
    })
    .get("/api/mcp", ({ set }) => {
      set.status = 405;
      set.headers.allow = "POST, DELETE";
      set.headers["cache-control"] = "no-store";
      return {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "MCP 端点只接受 POST；需要服务端推送时使用 subscriptions/listen（暂未提供）。",
        },
      };
    })
    .delete("/api/mcp", ({ request, set }) => {
      const id = request.headers.get("mcp-session-id")?.trim();
      if (id) sessions.close(id);
      set.status = 204;
      return new Response(null, { status: 204 });
    });
