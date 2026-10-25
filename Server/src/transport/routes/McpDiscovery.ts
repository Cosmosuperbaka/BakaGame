import { Elysia } from "elysia";
import { MCP_INSTRUCTIONS, MCP_POLICY } from "../../mcp/Policy";
import { TOOLS } from "../../mcp/Tools";

/** Agent 只拿到站点链接时，按这几份公开文件发现远程 MCP，不依赖人类额外提示。 */
const POLICY = MCP_POLICY.split("\n");
const INSTRUCTIONS = MCP_INSTRUCTIONS;

const publicOrigin = (request: Request, fallback: string): string => {
  try {
    return new URL(request.url).origin;
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
}) =>
  new Elysia({ name: "mcp-discovery", normalize: false })
    .get("/.well-known/mcp.json", ({ request, set }) => {
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
        serverCard: `${origin}/.well-known/mcp/server-card.json`,
        documentation: `${origin}/llms.txt`,
        instructions: INSTRUCTIONS,
        policy: POLICY,
      };
    })
    .get("/.well-known/mcp/server-card.json", ({ request, set }) => {
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
    })
    .get("/mcp/server-card", ({ request, set }) => {
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
