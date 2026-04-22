import type { VersionInfo } from "../config/version";

export interface OpenApiOptions {
  serverUrl: string;
  versionInfo: VersionInfo;
}

// ==================== HTTP 文档生成 ====================

// 这里只描述辅助 HTTP 接口，WebSocket 契约单独维护在 Agents/frontend-contract.md。
export const buildOpenApiDocument = ({ serverUrl, versionInfo }: OpenApiOptions) => ({
  openapi: "3.1.0",
  info: {
    title: "WhoIsFaker Backend HTTP API",
    version: versionInfo.version,
    description: "WhoIsFaker 后端辅助 HTTP 接口文档，实时业务通信通过 WebSocket /ws 完成。",
  },
  servers: [
    {
      url: serverUrl,
    },
  ],
  tags: [
    { name: "System", description: "服务状态与版本信息" },
    { name: "Docs", description: "OpenAPI 文档接口" },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["System"],
        summary: "获取服务健康状态",
        responses: {
          "200": {
            description: "服务健康状态",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["ok"] },
                    roomCount: { type: "integer" },
                    connectionCount: { type: "integer" },
                    onlinePlayerCount: { type: "integer" },
                  },
                  required: ["status", "roomCount", "connectionCount", "onlinePlayerCount"],
                },
              },
            },
          },
        },
      },
    },
    "/version": {
      get: {
        tags: ["System"],
        summary: "获取版本信息",
        responses: {
          "200": {
            description: "服务版本信息",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    version: { type: "string" },
                    commit: { type: "string" },
                    buildTime: { type: "string", format: "date-time" },
                  },
                  required: ["name", "version", "commit", "buildTime"],
                },
              },
            },
          },
        },
      },
    },
    "/openapi": {
      get: {
        tags: ["Docs"],
        summary: "查看 OpenAPI HTML 页面",
        responses: {
          "200": {
            description: "OpenAPI HTML 页面",
            content: {
              "text/html": {
                schema: {
                  type: "string",
                },
              },
            },
          },
        },
      },
    },
    "/openapi/json": {
      get: {
        tags: ["Docs"],
        summary: "获取 OpenAPI JSON",
        responses: {
          "200": {
            description: "OpenAPI JSON 文档",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                },
              },
            },
          },
        },
      },
    },
  },
});

// 为了避免额外引入文档 UI 依赖，这里直接生成一个轻量 HTML 页面。
export const renderOpenApiHtml = (document: object) => `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WhoIsFaker OpenAPI</title>
    <style>
      body {
        margin: 0;
        background: #0f172a;
        color: #e2e8f0;
        font-family: Consolas, "Courier New", monospace;
      }
      main {
        max-width: 1100px;
        margin: 0 auto;
        padding: 24px;
      }
      a {
        color: #38bdf8;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        background: #111827;
        border: 1px solid #334155;
        border-radius: 12px;
        padding: 16px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>WhoIsFaker OpenAPI</h1>
      <p>实时通信通过 <code>/ws</code> WebSocket 完成，HTTP 只承担辅助接口。</p>
      <p><a href="/openapi/json">查看 JSON 文档</a></p>
      <pre>${escapeHtml(JSON.stringify(document, null, 2))}</pre>
    </main>
  </body>
</html>`;

// 避免文档页被插入原始 HTML。
const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
