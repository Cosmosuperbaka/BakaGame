import { Elysia, t } from "elysia";
import { OPEN_SITE_FEATURES, type SiteFeatures } from "../../shared/SiteFeatures";

export interface SiteConfigRoutesDependencies {
  /**
   * 各模式入口的可用性，值由运行期旋钮（`enable*Entry`）给出；
   * 未装配时全部开放，与没有数据库的实例一致。
   */
  features?: () => SiteFeatures;
}

const flag = (description: string) => t.Boolean({ description });

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
      return features?.() ?? OPEN_SITE_FEATURES;
    },
    {
      detail: {
        tags: ["System"],
        summary: "读取站点配置",
        description:
          "返回各模式入口的可用性，由后台运行期旋钮控制；响应不缓存，开关改完即生效。关掉的入口在页面上仍然呈现，置灰并标注「暂时关闭」。",
      },
      response: {
        200: t.Object({
          fakerEntry: flag("谁是卧底是否开放"),
          songSoloEntry: flag("听歌猜歌单人模式是否开放"),
          songMultiplayerEntry: flag("听歌猜歌多人模式是否开放"),
          ceeMultiplayerEntry: flag("猜动漫角色多人模式是否开放"),
          ceeRankedEntry: flag("排位赛入口是否可用"),
        }),
      },
    }
  );
