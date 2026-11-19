import { createRequire } from "node:module";
import type { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";

export interface OpenApiOptions {
  serverUrl: string;
  /** 关闭时返回空插件：`/openapi` 不挂任何路由，落到全局 404 信封。 */
  enabled?: boolean;
  /** 文档插件包装不进来时的告知；之后按关闭处理，不让一张文档页拖垮整个进程。 */
  onUnavailable?: (error: unknown) => void;
  /** 取文档插件的办法，缺省按需加载这个包；测试用它模拟「运行环境里没有这个包」。 */
  load?: () => typeof openapi;
}

const requireFromHere = createRequire(import.meta.url);

/**
 * 文档插件按需加载，不在模块顶层引入：文档页默认只在非生产挂载，运行环境因此可以不带这个包，
 * 而顶层引入会让缺包的环境在加载模块时直接崩掉，连「关闭」这条分支都走不到。
 */
const loadOpenapi = (): typeof openapi =>
  (requireFromHere("@elysiajs/openapi") as typeof import("@elysiajs/openapi")).openapi;

// ==================== OpenAPI 文档插件构建 ====================

export const createOpenapiPlugin = ({
  serverUrl,
  enabled = true,
  onUnavailable,
  load = loadOpenapi,
}: OpenApiOptions) => {
  // 文档页把全部路由、参数与管理端点面列成一份可直接照打的清单，生产不该对外交付它。
  // 契约产物由 `scripts/ExportOpenapi.ts` 离线生成，不依赖线上文档。
  if (!enabled) return new Elysia({ name: "docs" });
  let plugin: typeof openapi;
  try {
    plugin = load();
  } catch (error) {
    onUnavailable?.(error);
    return new Elysia({ name: "docs" });
  }
  return plugin({
    provider: "swagger-ui",
    path: "/openapi",
    // 插件缺省会把文档版本改成 3.1.2；契约产物一直声明 3.1.0，版本号不随换库变动。
    openapiVersion: "3.1.0",
    documentation: {
      openapi: "3.1.0",
      info: {
        title: "BakaGame Backend HTTP API",
        version: "unversioned",
        description:
          "BakaGame 后端辅助 HTTP 接口文档。实时接口统一为 /api/ws（三款游戏与站点通道共用）；旧路径 /api/whoisfaker/ws、/api/songuessr/ws、/api/cee/ws 仍作为兼容别名保留。" +
          "本页只列 Elysia 声明的路由；账号与后台 API（/api/rpc/*，oRPC 契约）由 scripts/ExportOpenapi.ts 一并写进仓库内的 Server/docs/http-openapi.json。",
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
