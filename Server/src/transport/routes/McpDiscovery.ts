import { Elysia } from "elysia";
import { MCP_INSTRUCTIONS, MCP_POLICY } from "../../mcp/Policy";
import { TOOLS } from "../../mcp/Tools";

/** Agent 只拿到站点链接时，按这几份公开文件发现远程 MCP，不依赖人类额外提示。 */
const POLICY = MCP_POLICY.split("\n");
const INSTRUCTIONS = MCP_INSTRUCTIONS;

/**
 * 同一个发现文件的路径别名。
 *
 * - `/.well-known/mcp.json` 是 Agent 约定俗成的位置，必须存在。
 * - `/api/...` 是**边缘只转发 `/api/*`** 时的逃生口：前端静态托管（ESA Pages）把
 *   未命中静态资源的请求交给 SPA 兜底，`/.well-known/*` 会退回一份 HTML；而 `/api/*`
 *   由边缘反代到后端，能拿到活数据（含 `enabled` 与全量工具清单）。
 *
 * 两份路径共用同一个 handler，不复制内容：静态文件只需要指向 `/api` 别名即可，
 * 真相仍然只有这一处。
 */
const WELL_KNOWN_PATHS = ["/.well-known/mcp.json", "/api/.well-known/mcp.json"] as const;
const SERVER_CARD_PATHS = [
  "/.well-known/mcp/server-card.json",
  "/api/.well-known/mcp/server-card.json",
] as const;
const LEGACY_CARD_PATHS = ["/mcp/server-card", "/api/mcp/server-card"] as const;

/** 取代理链里最靠前的一跳值：`X-Forwarded-*` 允许逗号列表，只用第一个。 */
const firstHop = (value: string | null): string | undefined => {
  const head = value?.split(",")[0]?.trim();
  return head ? head.toLowerCase() : undefined;
};

/**
 * 公开 origin。
 *
 * 边缘（ESA / nginx）终止 TLS 后回源是明文，`request.url` 只看得到 http；
 * 发现文件里写 `http://` 会让 Agent 连到一条要 301 的地址，POST 重定向还可能丢包体。
 * 所以优先采信代理声明的协议与主机，两者都没有时才用请求本身的 origin。
 * 只接受 http/https，避免把调用方传进来的奇怪协议拼进返回体。
 */
const publicOrigin = (request: Request, fallback: string): string => {
  const proto = firstHop(request.headers.get("x-forwarded-proto"));
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || undefined;

  let origin = fallback;
  try {
    origin = new URL(request.url).origin;
  } catch {
    // request.url 不可解析时保持 fallback
  }

  try {
    const url = new URL(origin);
    // 直接拼 origin：改 `protocol` 会把回源端口（4850）一起带过去，
    // 而 forwarded host 不带端口时那个端口对外并不存在。
    const scheme = proto === "https" || proto === "http" ? proto : url.protocol.replace(":", "");
    return `${scheme}://${host ?? url.host}`;
  } catch {
    return fallback;
  }
};

export const mcpDiscoveryRoutes = ({
  mcpEnabled,
  serverUrl,
  version,
}: {
  mcpEnabled: boolean;
  serverUrl: string;
  version: string;
}) => {
  const app = new Elysia({ name: "mcp-discovery", normalize: false });

  for (const path of WELL_KNOWN_PATHS)
    app.get(path, ({ request, set }) => {
      const origin = publicOrigin(request, serverUrl);
      set.headers["cache-control"] = "public, max-age=300";
      return {
        schemaVersion: 1,
        enabled: mcpEnabled,
        mcpServers: mcpEnabled
          ? {
              bakagame: {
                type: "http",
                url: `${origin}/api/mcp`,
              },
            }
          : {},
        // 指向 `/api` 别名：根路径在只转发 `/api/*` 的边缘上会被 SPA 兜底成 HTML，
        // 而 server-card 里带全量工具清单，必须真的能读到。
        serverCard: `${origin}/api/.well-known/mcp/server-card.json`,
        documentation: `${origin}/llms.txt`,
        instructions: INSTRUCTIONS,
        policy: POLICY,
      };
    });

  for (const path of SERVER_CARD_PATHS)
    app.get(path, ({ request, set }) => {
      const origin = publicOrigin(request, serverUrl);
      set.headers["cache-control"] = "public, max-age=300";
      return {
        schemaVersion: 1,
        name: "bakagame-mcp",
        title: "BakaGame",
        description:
          "BakaGame 的远程 MCP：三款多人游戏的大厅、房间、对局操作与本人私有状态。只允许纯 Agent 自行游玩。",
        version,
        enabled: mcpEnabled,
        transport: {
          type: "streamable-http",
          url: `${origin}/api/mcp`,
        },
        protocolVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
        capabilities: { tools: { listChanged: false } },
        authentication: { type: "none" },
        documentation: `${origin}/llms.txt`,
        instructions: INSTRUCTIONS,
        policy: POLICY,
        tools: TOOLS.map(({ name, description }) => ({ name, description })),
      };
    });

  for (const path of LEGACY_CARD_PATHS)
    app.get(path, ({ request, set }) => {
      const origin = publicOrigin(request, serverUrl);
      set.headers["cache-control"] = "public, max-age=300";
      return {
        schemaVersion: 1,
        name: "bakagame-mcp",
        transport: { type: "streamable-http", url: `${origin}/api/mcp` },
        enabled: mcpEnabled,
        policy: POLICY,
      };
    });

  return app;
};
