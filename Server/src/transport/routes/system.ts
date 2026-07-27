import { Elysia, t } from "elysia";

import type { RoomService } from "../../application/room-service";
import type { VersionInfo } from "../../config/version";

export interface SystemRoutesDependencies {
  roomService: RoomService;
  versionInfo: VersionInfo;
}

export const systemRoutes = ({ roomService, versionInfo }: SystemRoutesDependencies) =>
  new Elysia({ name: "system" })
    .get(
      "/health",
      () => ({
        status: "ok" as const,
        ...roomService.getHealthSnapshot(),
      }),
      {
        detail: {
          tags: ["System"],
          summary: "获取服务健康状态",
          description: "返回当前运行状况、房间数量、连接数和在线玩家数。",
        },
        response: t.Object({
          status: t.Literal("ok"),
          roomCount: t.Number({ description: "活跃房间总数" }),
          connectionCount: t.Number({ description: "当前连接总数" }),
          onlinePlayerCount: t.Number({ description: "在线玩家总数" }),
        }),
      },
    )
    .get(
      "/version",
      () => versionInfo,
      {
        detail: {
          tags: ["System"],
          summary: "获取版本信息",
          description: "返回当前服务名称、版本号、 Git Commit 和构建时间。",
        },
        response: t.Object({
          name: t.String({ description: "服务名称" }),
          version: t.String({ description: "版本号" }),
          commit: t.String({ description: "Git Commit ID" }),
          buildTime: t.String({ description: "构建时间 ISO 字符串" }),
        }),
      },
    );
