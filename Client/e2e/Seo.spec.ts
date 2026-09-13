import { test, expect } from "@playwright/test";

// 该用例验证 SEO 元信息是否正确注入：
// 本项目是 SPA，元信息由 react-helmet-async 在运行时写入 document.head，
// 静态 HTML 里看不到，只能用真实浏览器断言。回归时会捕获 HelmetProvider
// 被移除、Seo 组件被删、或页面切换时标签未更新等退化。
test.describe("页面 SEO 元信息", () => {
  test("首页注入标题、描述与 canonical", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle("BakaGame - 在线玩谁是卧底与听歌猜歌");

    const description = page.locator('head meta[name="description"]');
    await expect(description).toHaveAttribute("content", /BakaGame/);

    const canonical = page.locator('head link[rel="canonical"]');
    await expect(canonical).toHaveAttribute("href", "https://game.baka.website/");
  });

  test("谁是卧底大厅有独立标题与 canonical", async ({ page }) => {
    await page.goto("/whoisfaker");
    await expect(page).toHaveTitle(/谁是卧底/);

    const canonical = page.locator('head link[rel="canonical"]');
    await expect(canonical).toHaveAttribute("href", "https://game.baka.website/whoisfaker");
  });

  test("听歌猜歌大厅有独立标题与 canonical", async ({ page }) => {
    await page.goto("/songuessr");
    await expect(page).toHaveTitle(/听歌猜歌/);

    const canonical = page.locator('head link[rel="canonical"]');
    await expect(canonical).toHaveAttribute("href", "https://game.baka.website/songuessr");
  });

  test("对局页标记 noindex", async ({ page }) => {
    await page.goto("/songuessr/solo");
    const robots = page.locator('head meta[name="robots"]');
    await expect(robots).toHaveAttribute("content", /noindex/);
  });
});
