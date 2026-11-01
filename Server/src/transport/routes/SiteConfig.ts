import { Elysia, t } from "elysia";

export interface SiteConfigRoutesDependencies {
  /**
   * 站点级功能可见性。当前只有 CEE 排位赛入口一项，值由运行期旋钮
   * （`enableCeeRankedEntry`）给出；未装配时全部开放，与没有数据库的实例一致。
   */
  features?: () => { ceeRankedEntry: boolean };
}

/**
 * 站点配置的公开读口：只回答「哪些入口现在该露出来」，不含任何账号或运营数据。
 *
 * 开关是运维止血手段，所以响应不让中间层缓存（`no-store`），改完下一次读取即生效；
 * 反过来，客户端读不到时按全开处理 —— 一次读失败不该把还能玩的入口藏起来。
 */
export const siteConfigRoutes = ({ features }: SiteConfigRoutesDependencies = {}) =>
  new Elysia({ name: "site-config", normalize: false }).get(
    "/api/site/config",
    ({ set }) => {
      set.headers["cache-control"] = "no-store";
      return { ceeRankedEntry: features?.().ceeRankedEntry ?? true };
    },
    {
      detail: {
        tags: ["System"],
        summary: "读取站点配置",
        description:
          "返回站点级功能可用性（当前为 CEE 排位赛入口），由运行期旋钮控制；响应不缓存，开关改完即生效。关掉的入口在页面上仍然呈现，只是置灰不可点。",
      },
      response: {
        200: t.Object({ ceeRankedEntry: t.Boolean({ description: "排位赛入口是否可用" }) }),
      },
    }
  );
