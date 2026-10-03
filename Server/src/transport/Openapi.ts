import { swagger } from "@elysiajs/swagger";

export interface OpenApiOptions {
  serverUrl: string;
}

// ==================== OpenAPI Swagger 插件构建 ====================

export const createSwaggerPlugin = ({ serverUrl }: OpenApiOptions) =>
  swagger({
    provider: "swagger-ui",
    path: "/openapi",
    documentation: {
      openapi: "3.1.0",
      info: {
        title: "BakaGame Backend HTTP API",
        version: "unversioned",
        description:
          "BakaGame 后端辅助 HTTP 接口文档。三个游戏的实时接口为 /api/whoisfaker/ws、/api/songuessr/ws、/api/ccb/ws。",
      },
      servers: [
        {
          url: serverUrl,
        },
      ],
      tags: [
        { name: "System", description: "服务状态与版本信息" },
      ],
    },
  });
