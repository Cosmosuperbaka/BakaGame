import { Elysia } from "elysia";
import { expect, test } from "bun:test";
import { mcpDiscoveryRoutes } from "../src/transport/routes/McpDiscovery";

const app = new Elysia({ normalize: false }).use(
  mcpDiscoveryRoutes({ mcpEnabled: true, serverUrl: "http://127.0.0.1:4850", version: "1.0.0" })
);

test("MCP 发现文件只凭站点 Origin 给出远程端点与反作弊声明", async () => {
  const response = await app.handle(new Request("https://game.example.com/.well-known/mcp.json"));
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    mcpServers: { bakagame: { type: string; url: string } };
    policy: string[];
    documentation: string;
  };
  expect(body.mcpServers.bakagame).toEqual({
    type: "http",
    url: "https://game.example.com/api/mcp",
  });
  expect(body.documentation).toBe("https://game.example.com/llms.txt");
  expect(body.policy.join("\n")).toContain("严禁用于辅助人类作弊");
});

test("MCP Server Card 暴露协议版本、工具清单与端点", async () => {
  const response = await app.handle(
    new Request("https://game.example.com/.well-known/mcp/server-card.json")
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    transport: { type: string; url: string };
    protocolVersions: string[];
    tools: Array<{ name: string }>;
  };
  expect(body.transport.url).toBe("https://game.example.com/api/mcp");
  expect(body.protocolVersions).toContain("2026-07-28");
  expect(body.tools.map((tool) => tool.name)).toContain("claim_seat");
});
