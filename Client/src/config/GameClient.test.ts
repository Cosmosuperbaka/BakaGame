import { describe, expect, it } from "vitest";
import { GAME_IDS, GAME_ROUTES } from "@bakagame/shared/values";
import { PAGE_META } from "@/data/PageMeta";
import { GAME_CLIENT } from "./GameClient";

/** 子路由的声明顺序：索引路由记作 "/"，其余记路径本身。 */
const routePathsOf = (game: (typeof GAME_IDS)[number]) =>
  GAME_CLIENT[game].routes.map((route) => (route.index === true ? "/" : route.path));

describe("玩法客户端登记表", () => {
  it("三款玩法齐全，键与共享契约的玩法标识一一对应", () => {
    expect(Object.keys(GAME_CLIENT)).toEqual([...GAME_IDS]);
  });

  it("每款的大厅与子路由都走懒加载，登记表本身不带页面组件", () => {
    for (const game of GAME_IDS) {
      const entry = GAME_CLIENT[game];
      expect(typeof entry.layout).toBe("function");
      expect(entry.routes.length).toBeGreaterThan(0);
      for (const route of entry.routes) {
        expect(typeof route.lazy).toBe("function");
        expect(route.element).toBeUndefined();
        expect(route.Component).toBeUndefined();
      }
    }
  });

  it("子路由的路径与声明顺序保持原样：猜歌单人在房间前，猜角色排位在房间后", () => {
    expect(routePathsOf("faker")).toEqual(["/", "room/:roomId"]);
    expect(routePathsOf("song")).toEqual(["/", "solo", "room/:roomId"]);
    expect(routePathsOf("cee")).toEqual(["/", "room/:roomId", "ranked"]);
  });

  it("页面元信息里的玩法路径集合等于登记表的大厅路径集合", () => {
    // 站点页（首页、关于）不进玩法登记表，其余登记页必须一款不多一款不少。
    const siteOnlyPaths = ["/", "/abouts"];
    const bases = GAME_IDS.map((game) => GAME_ROUTES[game].base);
    expect(PAGE_META.map((meta) => meta.path).sort()).toEqual([...bases, ...siteOnlyPaths].sort());
  });
});
