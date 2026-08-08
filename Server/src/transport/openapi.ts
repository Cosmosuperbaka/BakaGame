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
        title: "WhoIsFaker Backend HTTP API",
        version: "unversioned",
        description:
          "WhoIsFaker 后端辅助 HTTP 接口文档。实时业务通信通过 WebSocket /api/whoisfaker/ws 完成。",
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
