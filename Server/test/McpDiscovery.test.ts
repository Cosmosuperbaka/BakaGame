import { readFileSync } from "node:fs";
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

test("/api 前缀别名与根路径给同一份发现数据", async () => {
  // 前端托管在 ESA Pages：未命中静态资源的路径会被 SPA 兜底成 HTML，只有 `/api/*`
  // 由边缘反代到后端。别名让「边缘只转发 /api」的环境也能读到活数据。
  for (const [root, alias] of [
    ["/.well-known/mcp.json", "/api/.well-known/mcp.json"],
    ["/.well-known/mcp/server-card.json", "/api/.well-known/mcp/server-card.json"],
    ["/mcp/server-card", "/api/mcp/server-card"],
  ] as const) {
    const rootBody = await (
      await app.handle(new Request(`https://game.example.com${root}`))
    ).json();
    const aliasBody = await (
      await app.handle(new Request(`https://game.example.com${alias}`))
    ).json();
    expect(aliasBody).toEqual(rootBody);
  }
});

test("发现文件里的 serverCard 指向 /api 别名，根路径被 SPA 兜底时仍可读", async () => {
  const body = (await (
    await app.handle(new Request("https://game.example.com/api/.well-known/mcp.json"))
  ).json()) as { serverCard: string };
  expect(body.serverCard).toBe("https://game.example.com/api/.well-known/mcp/server-card.json");
});

test("前端静态发现指针与后端生成的端点同源，不出现第二份真相", () => {
  // 静态文件只做「指路」：它必须指到同一个 /api/mcp，且把完整能力的读取位置
  // 交给 canonical（后端活数据）。这条断言防止两边端点悄然漂移。
  const staticPath = new URL("../../Client/public/.well-known/mcp.json", import.meta.url);
  const pointer = JSON.parse(readFileSync(staticPath, "utf8")) as {
    mcpServers: { bakagame: { type: string; url: string } };
    canonical: string;
    serverCard: string;
  };
  expect(pointer.mcpServers.bakagame).toEqual({
    type: "http",
    url: "https://game.baka.website/api/mcp",
  });
  expect(pointer.canonical).toBe("https://game.baka.website/api/.well-known/mcp.json");
  expect(pointer.serverCard).toBe("https://game.baka.website/api/.well-known/mcp/server-card.json");
});

test("边缘终止 TLS 后仍按公网 https 生成端点，不把内网 http 写进发现文件", async () => {
  // 回源是明文，`request.url` 只看得到 http。若照抄，Agent 会连到一条要 301 的地址，
  // POST 重定向还可能丢包体 —— 所以代理声明的协议与主机优先。
  const body = (await (
    await app.handle(
      new Request("http://127.0.0.1:4850/api/.well-known/mcp/server-card.json", {
        headers: { "x-forwarded-proto": "https", "x-forwarded-host": "game.example.com" },
      })
    )
  ).json()) as { transport: { url: string }; enabled: boolean };
  expect(body.transport.url).toBe("https://game.example.com/api/mcp");

  // 只有协议、没有 forwarded host 时，主机名沿用请求本身。
  const onlyProto = (await (
    await app.handle(
      new Request("http://origin.internal/.well-known/mcp.json", {
        headers: { "x-forwarded-proto": "https" },
      })
    )
  ).json()) as { serverCard: string };
  expect(onlyProto.serverCard).toBe("https://origin.internal/api/.well-known/mcp/server-card.json");
});
