import { describe, expect, it } from "bun:test";
import { SITE_PAGES, findSitePage } from "../src/mcp/SiteMap";
import { SITE_PAGE_ENTRIES } from "../src/shared/SitePages";

describe("Agent 地图与页面登记", () => {
  it("登记里的每个公开页都在地图里，路径逐项一致", () => {
    for (const entry of Object.values(SITE_PAGE_ENTRIES))
      expect(findSitePage(entry.path)?.path, entry.path).toBe(entry.path);
  });

  it("三个大厅的标题与页面短名同形", () => {
    expect(findSitePage(SITE_PAGE_ENTRIES.faker.path)?.title).toBe("Who is Faker 谁是卧底大厅");
    expect(findSitePage(SITE_PAGE_ENTRIES.song.path)?.title).toBe("Songuessr 听歌猜歌大厅");
    expect(findSitePage(SITE_PAGE_ENTRIES.cee.path)?.title).toBe("CEE 猜动漫角色大厅");
  });

  it("地图里的路径不重复", () => {
    const paths = SITE_PAGES.map((page) => page.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
