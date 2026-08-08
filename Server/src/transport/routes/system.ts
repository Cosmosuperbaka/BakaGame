import { Elysia, t } from "elysia";

import type { RoomService } from "../../application/room-service";

export interface SystemRoutesDependencies {
  roomService: RoomService;
}

export const systemRoutes = ({ roomService }: SystemRoutesDependencies) =>
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
    );
