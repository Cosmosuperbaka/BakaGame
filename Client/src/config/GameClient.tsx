import type { ComponentType } from "react";
import type { RouteObject } from "react-router";
import type { GameId } from "@bakagame/shared";

type PageLoader = () => Promise<{ default: ComponentType }>;

/**
 * 路由级懒加载：数据路由先取到页面分块、再提交导航，
 * 跨页过渡因此总在新页可渲染之后才开始，不会把加载占位拍进快照。
 */
export const lazyPage =
  <P extends object = object>(load: () => Promise<{ default: ComponentType<P> }>, props?: P) =>
  async () => {
    const Page = (await load()).default;
    // 要给页面传固定属性（如单人房）时只能走 element；其余一律交给路由库按 Component 渲染。
    return props ? { element: <Page {...props} /> } : { Component: Page as ComponentType };
  };

export interface GameClientEntry {
  layout: PageLoader;
  /** 大厅之下的子路由，数组顺序就是声明顺序；末位的兜底重定向由路由装配统一补。 */
  routes: RouteObject[];
}

/**
 * 三款玩法的客户端登记表：按 `GameId` 映射，少一款或多一款都是编译错误。
 * 页面一律经动态 import 取分块，登记表本身不进玩法代码，首屏只为它付几个闭包。
 * 落地页卡片与页面元信息不进这里：前者带子模式与站点开关，后者要零依赖供构建期读取。
 */
export const GAME_CLIENT: { [G in GameId]: GameClientEntry } = {
  faker: {
    layout: () => import("@/layouts/WhoIsFakerLayout"),
    routes: [
      { index: true, lazy: lazyPage(() => import("@/pages/WhoIsFakerPage")) },
      { path: "room/:roomId", lazy: lazyPage(() => import("@/pages/WhoIsFakerRoomPage")) },
    ],
  },
  song: {
    layout: () => import("@/layouts/SonGuessrLayout"),
    routes: [
      { index: true, lazy: lazyPage(() => import("@/pages/SonGuessrPage")) },
      { path: "solo", lazy: lazyPage(() => import("@/pages/SonGuessrRoomPage"), { solo: true }) },
      { path: "room/:roomId", lazy: lazyPage(() => import("@/pages/SonGuessrRoomPage")) },
    ],
  },
  cee: {
    layout: () => import("@/layouts/CEELayout"),
    routes: [
      { index: true, lazy: lazyPage(() => import("@/pages/CEEPage")) },
      { path: "room/:roomId", lazy: lazyPage(() => import("@/pages/CEERoomPage")) },
      { path: "ranked", lazy: lazyPage(() => import("@/pages/CEERankedPage")) },
    ],
  },
};
