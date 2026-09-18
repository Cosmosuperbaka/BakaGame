import { test, expect } from "@playwright/test";

test.describe("CCB 基本游戏流程", () => {
  test("应该能够创建房间并进入", async ({ page }) => {
    await page.goto("/");

    // 进入 CCB 大厅
    await page.click('a[href="/ccb"]');
    await expect(page).toHaveURL("/ccb");

    // 创建房间
    await page.fill('input[placeholder*="房间号"]', "TestRoom123");
    await page.click('button:has-text("创建房间")');

    // 应该进入房间
    await expect(page).toHaveURL(/\/ccb\/TestRoom123/);
    await expect(page.locator("text=TestRoom123")).toBeVisible();
  });

  test("应该能够打开设置对话框", async ({ page, context }) => {
    await page.goto("/");

    // 创建房间
    await page.goto("/ccb/TestSettingsRoom");

    // 等待进入房间
    await page.waitForSelector('text=/等待开始|猜测中/');

    // 打开设置
    await page.click('button[aria-label*="设置"]');

    // 验证设置对话框打开
    await expect(page.locator('text=游戏设置')).toBeVisible();
    await expect(page.locator('text=猜测设置')).toBeVisible();
    await expect(page.locator('text=答案设置')).toBeVisible();
  });

  test("应该能够开始游戏", async ({ page }) => {
    await page.goto("/ccb/TestGameRoom");

    // 等待进入房间
    await page.waitForSelector('button:has-text("准备")');

    // 点击准备
    await page.click('button:has-text("准备")');

    // 作为房主应该看到开始游戏按钮
    const startButton = page.locator('button:has-text("开始游戏")');
    await expect(startButton).toBeVisible();

    // 点击开始
    await startButton.click();

    // 应该进入游戏状态
    await expect(page.locator('text=/猜测中|出题中/')).toBeVisible({ timeout: 10000 });
  });

  test("应该能够搜索角色", async ({ page }) => {
    // 需要先进入对局中的房间
    await page.goto("/ccb/TestSearchRoom");

    // 等待进入房间并开始游戏
    await page.waitForSelector('button:has-text("准备")');
    await page.click('button:has-text("准备")');

    const startButton = page.locator('button:has-text("开始游戏")');
    if (await startButton.isVisible()) {
      await startButton.click();
    }

    // 等待游戏开始
    await page.waitForSelector('input[placeholder*="搜索角色"]', { timeout: 15000 });

    // 搜索角色
    await page.fill('input[placeholder*="搜索角色"]', "鲁路修");

    // 应该看到搜索结果
    await expect(page.locator('text=鲁路修')).toBeVisible({ timeout: 5000 });
  });
});

test.describe("CCB 设置功能", () => {
  test("应该能够修改游戏设置", async ({ page }) => {
    await page.goto("/ccb/TestSettingsModify");

    // 等待进入房间
    await page.waitForSelector('button[aria-label*="设置"]');

    // 打开设置
    await page.click('button[aria-label*="设置"]');

    // 修改猜测次数
    const attemptsInput = page.locator('input#maxAttempts');
    await attemptsInput.fill("15");

    // 修改角色数量
    const characterNumInput = page.locator('input#characterNum');
    await characterNumInput.fill("8");

    // 应用设置
    await page.click('button:has-text("应用设置")');

    // 验证设置已保存（重新打开检查）
    await page.click('button[aria-label*="设置"]');
    await expect(page.locator('input#maxAttempts')).toHaveValue("15");
    await expect(page.locator('input#characterNum')).toHaveValue("8");
  });

  test("应该能够选择预设配置", async ({ page }) => {
    await page.goto("/ccb/TestPreset");

    await page.waitForSelector('button[aria-label*="设置"]');
    await page.click('button[aria-label*="设置"]');

    // 选择"入门"预设
    await page.click('button:has-text("入门")');

    // 验证设置已应用
    await expect(page.locator('input#characterNum')).toHaveValue("3");
  });

  test("应该能够启用多人模式选项", async ({ page }) => {
    await page.goto("/ccb/TestMultiplayer");

    await page.waitForSelector('button[aria-label*="设置"]');
    await page.click('button[aria-label*="设置"]');

    // 启用角色全局BP
    await page.click('button:has-text("角色全局BP")');

    // 启用同步模式
    await page.click('button:has-text("同步模式")');

    // 应用设置
    await page.click('button:has-text("应用设置")');

    // 验证设置已保存
    await page.click('button[aria-label*="设置"]');
    const globalPickButton = page.locator('button:has-text("角色全局BP")');
    await expect(globalPickButton).toHaveClass(/border-red-500/);
  });
});
