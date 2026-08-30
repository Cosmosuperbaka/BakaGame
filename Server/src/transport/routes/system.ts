import { Elysia, t } from "elysia";

import type { RoomService } from "../../application/RoomService";
import type { SonGuessrService } from "../../application/SonGuessrService";

export interface SystemRoutesDependencies {
  roomService: RoomService;
  sonGuessrService?: SonGuessrService;
}

export const systemRoutes = ({ roomService, sonGuessrService }: SystemRoutesDependencies) =>
  new Elysia({ name: "system" })
    .get(
      "/health",
      () => {
        const fakerHealth = roomService.getHealthSnapshot();
        const sonHealth = sonGuessrService?.getHealthSnapshot() ?? {
          roomCount: 0,
          connectionCount: 0,
          onlinePlayerCount: 0,
        };

        return {
          status: "ok" as const,
          roomCount: fakerHealth.roomCount + sonHealth.roomCount,
          connectionCount: fakerHealth.connectionCount + sonHealth.connectionCount,
          onlinePlayerCount: fakerHealth.onlinePlayerCount + sonHealth.onlinePlayerCount,
        };
      },
      {
        detail: {
          tags: ["System"],
          summary: "获取服务健康状态",
          description: "返回当前运行状况、房间数量、连接数和在线玩家数（聚合所有游戏模式）。",
        },
        response: t.Object({
          status: t.Literal("ok"),
          roomCount: t.Number({ description: "活跃房间总数" }),
          connectionCount: t.Number({ description: "当前连接总数" }),
          onlinePlayerCount: t.Number({ description: "在线玩家总数" }),
        }),
      },
    );
