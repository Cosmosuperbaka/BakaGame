import { test, expect } from "@playwright/test";

// 该用例验证 SEO 元信息是否正确注入：
// 本项目是 SPA，description/canonical/robots 由 react-helmet-async 在运行时写入
// document.head，静态 HTML 里看不到，只能用真实浏览器断言。
// 标签页标题按产品决策（2026-09-14）统一为纯站名「BakaGame」（index.html 兜底），
// Seo 组件不写 <title>；toHaveTitle 用严格相等断言，一旦有人给标题追加后缀即失败。
test.describe("页面 SEO 元信息", () => {
  test("首页标题为纯站名，注入描述与 canonical", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle("BakaGame");

    const description = page.locator('head meta[name="description"]');
    await expect(description).toHaveAttribute("content", /BakaGame/);

    const canonical = page.locator('head link[rel="canonical"]');
    await expect(canonical).toHaveAttribute("href", "https://game.baka.website/");
  });

  test("谁是卧底大厅标题仍为纯站名，有独立描述与 canonical", async ({ page }) => {
    await page.goto("/whoisfaker");
    await expect(page).toHaveTitle("BakaGame");

    const description = page.locator('head meta[name="description"]');
    await expect(description).toHaveAttribute("content", /谁是卧底/);

    const canonical = page.locator('head link[rel="canonical"]');
    await expect(canonical).toHaveAttribute("href", "https://game.baka.website/whoisfaker");
  });

  test("听歌猜歌大厅标题仍为纯站名，有独立描述与 canonical", async ({ page }) => {
    await page.goto("/songuessr");
    await expect(page).toHaveTitle("BakaGame");

    const description = page.locator('head meta[name="description"]');
    await expect(description).toHaveAttribute("content", /听歌猜歌/);

    const canonical = page.locator('head link[rel="canonical"]');
    await expect(canonical).toHaveAttribute("href", "https://game.baka.website/songuessr");
  });

  test("对局页标记 noindex", async ({ page }) => {
    await page.goto("/songuessr/solo");
    const robots = page.locator('head meta[name="robots"]');
    await expect(robots).toHaveAttribute("content", /noindex/);
  });

  // 静态外壳只服务不执行 JS 的爬虫，对执行 JS 的客户端必须在首帧之前消失，
  // 否则用户进站会先看到一段裸文本（曾是线上实际观感问题）。
  // 这里把应用脚本全部掐掉，模拟「首屏 JS 最慢」的极端情况：外壳仍不得出现在页面上，
  // 而原始 HTML 里必须留有正文——两边都不能少。
  test("静态外壳对爬虫可见、对执行 JS 的客户端首帧前即被清空", async ({ page }) => {
    const raw = await (await page.request.get("/whoisfaker")).text();
    expect(raw).toContain("在线版谁是卧底");
    expect(raw).toContain('<div id="root"><main>');

    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/whoisfaker", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#root")).toBeEmpty();
  });
});
