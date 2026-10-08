import type { Page } from "@playwright/test";
import { closeIsolatedContext, expect, isLoopbackUrl, test } from "./fixtures/Isolation";

async function useLocalCharacterImages(page: Page) {
  // SQLite 补全缓存也可能已有图片 URL；阻止这些可选图片绕过 WS 隔离回源。
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (route.request().resourceType() === "image" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
      return route.fulfill({ contentType: "image/gif", body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64") });
    }
    return route.fallback();
  });
  await page.routeWebSocket((url) => isLoopbackUrl(url) && url.pathname === "/api/ccb/ws", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (typeof message !== "string") { server.send(message); return; }
      const command = JSON.parse(message) as { type: string; id: string };
      if (command.type === "ccb.character.image") {
        socket.send(JSON.stringify({ type: "ack", id: command.id, requestType: command.type, payload: {
          imageUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        } }));
      } else server.send(message);
    });
  });
}

function watchQuality(page: Page) {
  const failures: string[] = [];
  let telemetryRateLimited = false;
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !(telemetryRateLimited && message.text().includes("429 (Too Many Requests)"))) failures.push(message.text());
  });
  page.on("response", (response) => {
    // 同一服务连续跑浏览器用例会触发遥测独立限流，它不影响对局命令。
    if (new URL(response.url()).pathname === "/api/monitoring/sentry" && response.status() === 429) {
      telemetryRateLimited = true;
      return;
    }
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });
  return () => expect(failures).toEqual([]);
}

async function chooseCharacter(page: Page, name: string) {
  const search = page.getByRole("region", { name: "角色搜索" });
  await search.getByRole("combobox", { name: "搜索角色", exact: true }).fill(name);
  await search.getByRole("button", { name: "搜角色", exact: true }).click();
  // 结果面板走 Portal，不在搜索区的 DOM 子树里。
  await page.getByRole("listbox", { name: "搜索角色结果" }).getByRole("option", { name: new RegExp(name) }).first().click();
}

async function expectViewportFits(page: Page) {
  expect(await page.evaluate(() => ({
    width: document.documentElement.scrollWidth <= innerWidth,
    height: document.documentElement.scrollHeight === innerHeight,
  }))).toEqual({ width: true, height: true });
}

test("增强房双浏览器连续两局、重连、聊天与三档布局", async ({ isolatedContext, page }, testInfo) => {
  test.setTimeout(process.env.CI ? 180_000 : 120_000);
  const guestContext = await isolatedContext({ reducedMotion: "reduce" });
  const guest = await guestContext.newPage();
  // 只替换可选头像补全；角色检索、出题、猜测及状态同步仍走真实 SQLite 与服务端。
  await Promise.all([useLocalCharacterImages(page), useLocalCharacterImages(guest)]);
  const checkHost = watchQuality(page);
  const checkGuest = watchQuality(guest);
  const hostName = "名称很长的房主玩家用于验证默认头像和分数排列";
  const guestName = `猜角色访客${Date.now().toString(36)}`;
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/ccb");
    await page.getByRole("textbox", { name: "用户名" }).fill(hostName);
    await page.getByRole("button", { name: "创建房间", exact: true }).click();
    await page.getByRole("textbox", { name: "房间名称" }).fill("连续两局验收房间");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page).toHaveURL(/\/ccb\/room\/\d{4}$/);
    const roomUrl = page.url();
    await guest.goto(roomUrl);
    await guest.getByRole("textbox", { name: "用户名" }).fill(guestName);
    await guest.getByRole("button", { name: "进入房间", exact: true }).click();
    await expect(guest.getByRole("heading", { name: "等待开始" })).toBeVisible();
    await expect(page.getByTitle(guestName, { exact: true })).toBeVisible();

    // 设置改成等待页内折叠面板加防抖自动保存：没有保存按钮，改动直达服务端。
    // 用访客侧的设置摘要断言落库——它只可能来自服务端广播，能证明确实保存成功。
    const guestGuessSettings = guest.getByRole("button", { name: "猜测设置", exact: true });
    await expect(guestGuessSettings).toHaveAccessibleDescription(/每次 60 秒/);
    await page.getByRole("button", { name: "猜测设置", exact: true }).click();
    const actionLimit = page.getByRole("textbox", { name: "每次行动限时" });
    await actionLimit.fill("0");
    await actionLimit.press("Enter");
    await expect(guestGuessSettings).toHaveAccessibleDescription(/不限行动时间/);
    // 房主不准备；随机出题要等其他人都准备好。
    await expect(page.getByRole("button", { name: "准备", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "等待玩家准备 (0/1)", exact: true })).toBeDisabled();

    const chat = "联机聊天".repeat(75);
    await page.getByPlaceholder("请输入文本").fill(chat);
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(guest.getByTestId("chat-message-bubble").filter({ hasText: chat })).toBeVisible();
    // 出题方式在题目设置里；指定出题人时开始游戏先进入选人阶段，出题人不必准备。
    await page.getByRole("button", { name: "题目设置", exact: true }).click();
    await page.getByRole("radiogroup", { name: "出题方式" }).getByText("指定出题人", { exact: true }).click();
    await expect(page.getByRole("radio", { name: "指定出题人", exact: true })).toBeChecked();
    await page.getByRole("button", { name: "开始并指定出题人", exact: true }).click();
    await expect(guest.getByText("等待房主指定本局出题人")).toBeVisible();
    await page.getByRole("button", { name: hostName, exact: true }).click();
    await expect(page.getByRole("heading", { name: "选择本局答案" })).toBeVisible();
    await chooseCharacter(page, "后藤一里");
    await page.getByRole("textbox", { name: "文本提示 1", exact: true }).fill("吉他手");
    await page.getByRole("button", { name: "确认答案并开始" }).click();
    await expect(guest.getByRole("heading", { name: "猜猜是哪位角色" })).toBeVisible();
    await expect(guest.getByText(/答案对猜题者隐藏/)).toHaveCount(0);
    await chooseCharacter(guest, "伊地知虹夏");
    await expect(guest.getByRole("region", { name: "猜测反馈" })).toContainText("伊地知虹夏");
    await guest.reload();
    await expect(guest.getByRole("region", { name: "猜测反馈" })).toContainText("伊地知虹夏");

    for (const viewport of [{ width: 1440, height: 900 }, { width: 1100, height: 800 }, { width: 900, height: 800 }, { width: 832, height: 800 }, { width: 768, height: 800 }, { width: 390, height: 844 }]) {
      await guest.setViewportSize(viewport);
      await expectViewportFits(guest);
      const feedback = guest.getByRole("region", { name: "猜测反馈" });
      await feedback.scrollIntoViewIfNeeded();
      // 一次猜测一行（Design 数据表格一节）：去头像后最小内容宽度约 531px。1024 及更宽（1280 聊天栏刚常驻的一小段除外）
      // 不横滚；900 及以下横向滚动是这段宽度的既定形态：角色列贴住左缘，数值与标签横移。
      if (viewport.width <= 900) {
        await expect.poll(() => feedback.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
        await feedback.evaluate((element) => element.scrollTo({ left: element.scrollWidth }));
        await expect.poll(() => feedback.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
        await expect(feedback.getByText("伊地知虹夏")).toBeInViewport({ ratio: 1 });
      } else {
        await expect.poll(() => feedback.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
      }
      // 聊天栏 xl 起常驻；其下与玩家栏同时常驻会挤窄游戏区，改由顶栏按钮打开覆盖面板。
      if (viewport.width < 1280) {
        await guest.getByRole("button", { name: "聊天", exact: true }).click();
        await expect(guest.getByRole("dialog", { name: "聊天", exact: true })).toBeVisible();
        await guest.keyboard.press("Escape");
        await expect(guest.getByRole("dialog", { name: "聊天", exact: true })).toHaveCount(0);
      }
      if (viewport.width < 768) {
        await guest.getByRole("button", { name: "玩家列表", exact: true }).click();
        await expect(guest.getByRole("dialog", { name: "玩家", exact: true })).toContainText(hostName);
        await guest.getByRole("button", { name: "关闭面板" }).click();
        await expect(guest.getByRole("dialog", { name: "玩家", exact: true })).toHaveCount(0);
      }
      await guest.screenshot({ path: testInfo.outputPath(`ccb-${viewport.width}.png`) });
    }
    await guest.setViewportSize({ width: 1440, height: 900 });
    await chooseCharacter(guest, "后藤一里");
    await expect(guest.getByRole("heading", { name: "答案揭晓" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "答案揭晓" })).toBeVisible();
    await expect(guest.getByRole("table", { name: "本局得分" })).toContainText("快速 2");
    await page.getByRole("button", { name: "返回等待房间" }).click();
    await expect(guest.getByRole("heading", { name: "等待开始" })).toBeVisible();
    await page.getByRole("button", { name: "开始并指定出题人", exact: true }).click();
    await page.getByRole("button", { name: guestName, exact: true }).click();
    await expect(guest.getByRole("heading", { name: "选择本局答案" })).toBeVisible();
    await chooseCharacter(guest, "伊地知虹夏");
    await guest.getByRole("button", { name: "确认答案并开始" }).click();
    await chooseCharacter(page, "伊地知虹夏");
    await expect(page.getByRole("heading", { name: "答案揭晓" })).toBeVisible();
    await expect(page.getByRole("table", { name: "本局得分" })).toContainText("首猜 12");
    await expect(page.getByText("第 2 局", { exact: true })).toBeVisible();
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)));
    await page.screenshot({ path: testInfo.outputPath("ccb-settled-dark.png") });
    await guest.getByRole("button", { name: "离开房间" }).click();
    await page.goBack();
    await expect(page).toHaveURL(/\/ccb$/);
    await page.getByRole("button", { name: "创建房间", exact: true }).click();
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.getByRole("heading", { name: "等待玩家加入" })).toBeVisible();
    await page.getByRole("button", { name: "离开房间" }).click();
    checkHost();
    checkGuest();
  } finally {
    await closeIsolatedContext(guestContext);
  }
});

test("直链测试房在房间不存在时就地创建并允许单人开局", async ({ page }) => {
  const checkQuality = watchQuality(page);
  // 测试房不进大厅、没有创建入口；冷启动的隔离服务里它必然不存在。
  // 直链进入必须用同一房号就地建起它，否则永远停在「房间不存在或已经关闭」。
  await page.goto("/ccb/room/Oblivionis");
  await page.getByRole("textbox", { name: "用户名" }).fill(`测试房主${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "进入房间", exact: true }).click();
  await expect(page.getByRole("heading", { name: "等待玩家加入" })).toBeVisible();
  // 单人测试房允许房主一人试玩：普通房此处是禁用的「等待玩家加入」。
  const start = page.getByRole("button", { name: "开始游戏", exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByRole("heading", { name: "猜猜是哪位角色" })).toBeVisible();
  checkQuality();
});
