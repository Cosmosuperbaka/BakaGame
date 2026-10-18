import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";

export interface OpenApiOptions {
  serverUrl: string;
  /** 关闭时返回空插件：`/openapi` 不挂任何路由，落到全局 404 信封。 */
  enabled?: boolean;
}

// ==================== OpenAPI Swagger 插件构建 ====================

export const createSwaggerPlugin = ({ serverUrl, enabled = true }: OpenApiOptions) => {
  // 文档页把全部路由、参数与管理端点面列成一份可直接照打的清单，生产不该对外交付它。
  // 契约产物由 `scripts/ExportOpenapi.ts` 离线生成，不依赖线上文档。
  if (!enabled) return new Elysia({ name: "docs" });
  return swagger({
    provider: "swagger-ui",
    path: "/openapi",
    documentation: {
      openapi: "3.1.0",
      info: {
        title: "BakaGame Backend HTTP API",
        version: "unversioned",
        description:
          "BakaGame 后端辅助 HTTP 接口文档。三个游戏的实时接口为 /api/whoisfaker/ws、/api/songuessr/ws、/api/cee/ws。" +
          "本页只列 Elysia 声明的路由；账号与后台 API（/api/rpc/*，oRPC 契约）由 scripts/ExportOpenapi.ts 一并写进仓库内的 Agents/http-openapi.json。",
      },
      servers: [
        {
          url: serverUrl,
        },
      ],
      tags: [{ name: "System", description: "服务状态与版本信息" }],
    },
  });
};
