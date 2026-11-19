import { describe, expect, it } from "bun:test";
import { AGENT_PAGE_PATHS, isAgentPagePath } from "../src/shared/AgentPages";
import { GAME_ROOM_PATH, GAME_ROUTES, gameOfPath, roomIdOfPath } from "../src/shared/GameRoutes";
import { GAME_IDS } from "../src/shared/Protocol";
import { SITE_PAGE_ENTRIES } from "../src/shared/SitePages";

describe("玩法路径登记", () => {
  it("三款玩法齐全，大厅路径就是站点页登记里的那一条", () => {
    expect(Object.keys(GAME_ROUTES)).toEqual([...GAME_IDS]);
    expect(GAME_ROUTES.faker.base).toBe(SITE_PAGE_ENTRIES.faker.path);
    expect(GAME_ROUTES.song.base).toBe(SITE_PAGE_ENTRIES.song.path);
    expect(GAME_ROUTES.cee.base).toBe(SITE_PAGE_ENTRIES.cee.path);
  });

  it("Agent 白名单由登记表派生，排位赛与后台仍然进不去", () => {
    expect([...AGENT_PAGE_PATHS]).toEqual([
      "/",
      "/whoisfaker",
      "/songuessr",
      "/songuessr/solo",
      "/cee",
      "/abouts",
      "/abouts/changelog",
      "/abouts/privacy",
      "/abouts/terms",
      "/status",
    ]);
    for (const game of GAME_IDS) {
      expect(isAgentPagePath(GAME_ROUTES[game].base)).toBe(true);
      for (const page of GAME_ROUTES[game].agentPages) expect(isAgentPagePath(page)).toBe(true);
    }
    for (const path of ["/cee/ranked", "/admin", "/account"])
      expect(isAgentPagePath(path)).toBe(false);
  });

  it("房间页路径按三款基路径生成，房号的字符集与长度不变", () => {
    for (const game of GAME_IDS) {
      const room = `${GAME_ROUTES[game].base}/room/ab_cd-12`;
      expect(GAME_ROOM_PATH.test(room)).toBe(true);
      expect(roomIdOfPath(room)).toBe("ab_cd-12");
    }
    for (const path of ["/x/room/1234", "/cee/room/a", "/cee/room/1234/", "/cee/room/ab cd"])
      expect(GAME_ROOM_PATH.test(path)).toBe(false);
    expect(roomIdOfPath("/cee/room/a")).toBeUndefined();
    // 白名单先归一化结尾斜杠再放行，取房号这一步也要认这种路径。
    expect(isAgentPagePath("/whoisfaker/room/1234/")).toBe(true);
    expect(roomIdOfPath("/whoisfaker/room/1234/")).toBe("1234");
  });

  it("路径归属按前缀判定：大厅与子页算本款，相似前缀与站点页不算", () => {
    expect(gameOfPath("/whoisfaker")).toBe("faker");
    expect(gameOfPath("/whoisfaker/room/1234")).toBe("faker");
    expect(gameOfPath("/songuessr/solo")).toBe("song");
    expect(gameOfPath("/cee/ranked")).toBe("cee");
    for (const path of ["/", "/abouts", "/status", "/admin", "/ceex", "/whoisfakerish"])
      expect(gameOfPath(path)).toBeUndefined();
  });
});
