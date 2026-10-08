import { assertLobbyRendering } from "./fixtures/LobbyRendering";
import type { BrowserContext, Page } from "@playwright/test";
import { closeIsolatedContext, expect, isLoopbackUrl, test } from "./fixtures/Isolation";

async function expectActionAreaScrollable(page: Page) {
  const viewport = page
    .getByTestId("game-area-scroll")
    .locator("[data-radix-scroll-area-viewport]");

  await expect(viewport).toBeVisible();
  await expect.poll(() => viewport.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(0);
  await expect(viewport).toHaveCSS("overflow-y", "auto");
  await viewport.evaluate((element) => element.scrollTo({ top: 0 }));
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
  await viewport.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
}

function installPageQualityGuards(page: Page) {
  const failures: string[] = [];
  let sentryRateLimitObserved = false;
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !(message.text().includes("429 (Too Many Requests)") && sentryRateLimitObserved)
    ) {
      failures.push(`console: ${message.text()}`);
    }
  });
  page.on("response", (response) => {
    const isSentryTunnel = new URL(response.url()).pathname === "/api/monitoring/sentry";
    if (isSentryTunnel && (response.status() === 429 || response.status() === 502 || response.status() === 504)) {
      if (response.status() === 429) sentryRateLimitObserved = true;
      return;
    }
    if (response.status() >= 400) {
      failures.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return async () => expect(failures, failures.join("\n")).toEqual([]);
}

async function removeAllTestBots(page: Page) {
  const bots = page.getByLabel("测试人机", { exact: true });
  const removeBot = page.getByRole("button", { name: "移除一个测试人机" });

  for (let index = 0; index < 16; index += 1) {
    const count = await bots.count();
    if (count === 0) return;
    await expect(removeBot).toBeEnabled();
    await removeBot.click();
    await expect(bots).toHaveCount(count - 1);
  }

  await expect(bots).toHaveCount(0);
}

test("landing page exposes playable games and keeps placeholders disabled", async ({ page }) => {
  const assertPageQuality = installPageQualityGuards(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Baka Game" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Who is Faker/ })).toBeVisible();
  await expect(page.getByText("Songuessr")).toBeVisible();
  await expect(page.getByTestId("game-entry-songuessr").getByRole("button", { name: /多人模式/ })).toBeVisible();

  // CCB 增强版的主页入口在生产构建里临时下线：卡片保留原尺寸与结构，
  // 但整卡不可用（没有可点击的入口）。直链进大厅见下一条用例。
  const ccbEntry = page.getByTestId("game-entry-animecharguessr");
  await expect(ccbEntry).toBeVisible();
  await expect(ccbEntry.getByText("即将上线")).toBeVisible();
  await expect(ccbEntry.getByRole("button")).toHaveCount(0);

  await expect(page.locator('[aria-disabled="true"]').first()).toBeVisible();
  await page.getByRole("button", { name: /Who is Faker/ }).click();
  await expect(page).toHaveURL(/\/whoisfaker$/);
  // 大厅标题写「Who is」接 Faker 图标，标题的可读名仍是完整的「Who is Faker」。
  await expect(page.getByRole("heading", { name: "Who is Faker" })).toBeVisible();
  await assertPageQuality();
});

test("CCB lobby stays reachable by direct link while its home entry is disabled", async ({ page }) => {
  const assertPageQuality = installPageQualityGuards(page);
  await page.goto("/");

  // 入口不可点：主页上没有任何通往 /ccb 的按钮
  await expect(page.getByTestId("game-entry-animecharguessr").getByRole("button")).toHaveCount(0);

  await page.goto("/ccb");
  await expect(page).toHaveURL(/\/ccb$/);
  await expect(page.getByRole("textbox", { name: "用户名" })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建房间", exact: true })).toBeVisible();
  await assertPageQuality();
});

test("landing game entries stack cleanly and stay clear of the footer", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const viewport of [
    { width: 2048, height: 1050 },
    { width: 1024, height: 500 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");

    const entries = ["whoisfaker", "songuessr", "animecharguessr"].map((id) =>
      page.getByTestId(`game-entry-${id}`),
    );
    const boxes = await Promise.all(entries.map((entry) => entry.boundingBox()));
    const headerBox = await page.locator("header").boundingBox();
    const footerBox = await page.locator("footer").boundingBox();

    expect(boxes.every((box) => box !== null)).toBe(true);
    expect(headerBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    const resolvedBoxes = boxes.filter((box): box is NonNullable<typeof box> => box !== null);

    // 竖排单列布局：Y 坐标按卡片顺序严格递增，X 坐标水平居中对齐
    expect(resolvedBoxes[0]!.y).toBeLessThan(resolvedBoxes[1]!.y);
    expect(resolvedBoxes[1]!.y).toBeLessThan(resolvedBoxes[2]!.y);
    expect(Math.abs(resolvedBoxes[0]!.x - resolvedBoxes[1]!.x)).toBeLessThan(5);
    expect(Math.abs(resolvedBoxes[1]!.x - resolvedBoxes[2]!.x)).toBeLessThan(5);

    // 顶部不遮挡 header
    expect(resolvedBoxes[0]!.y).toBeGreaterThanOrEqual(headerBox!.y);
    // 底部存在合理间距
    expect(footerBox!.y).toBeGreaterThan(0);
  }
});

test("players in a room are prompted when a newer build is deployed", async ({ page }) => {
  await page.route("**/?version-check=*", async (route) => {
    if (!isLoopbackUrl(route.request().url())) return route.fallback();
    await route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><meta name="bakagame-build" content="newer-build"></head></html>',
    });
  });

  const unique = Date.now().toString(36);
  await page.goto("/whoisfaker");
  await page.getByPlaceholder("用户名").fill(`版本测试${unique}`);
  await page.getByRole("button", { name: "创建房间" }).click();
  await page.getByPlaceholder("输入房间名称").fill(`版本测试房${unique}`);
  await page.getByRole("button", { name: "创建", exact: true }).click();

  await expect(page).toHaveURL(/\/whoisfaker\/room\/\d{4}$/);
  await expect(page.getByRole("status").filter({ hasText: "游戏有新版本" })).toContainText("游戏有新版本，请刷新后继续游玩");
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeVisible();
});

test("removed and unknown routes fall back to a live page", async ({ page }) => {
  for (const path of ["/animecharguessr", "/unknown"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Baka Game" })).toBeVisible();
  }

  await page.goto("/whoisfaker/unknown");
  await expect(page).toHaveURL(/\/whoisfaker$/);
  await expect(page.getByRole("heading", { name: "Who is Faker" })).toBeVisible();

  await page.goto("/songuessr/unknown");
  await expect(page).toHaveURL(/\/songuessr$/);
  await expect(page.getByRole("heading", { name: "Songuessr" })).toBeVisible();
});

test("Songuessr is reachable from the landing page", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("game-entry-songuessr").getByRole("button", { name: /多人模式/ }).click();

  await expect(page).toHaveURL(/\/songuessr$/);
  await expect(page.getByRole("heading", { name: "Songuessr" })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建房间" })).toBeVisible();
});

test("Songuessr lobby and Who is Faker share the unified application shell structure", async ({ page }) => {
  const verifyShellContract = async () => {
    await expect(page.locator("header")).toBeVisible();
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("header a[href='/'], header button").first()).toBeVisible();
    const widthFits = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(widthFits).toBe(true);
  };

  await page.goto("/whoisfaker");
  await verifyShellContract();

  await page.goto("/songuessr");
  await verifyShellContract();
});

test("长玩家名不会挤出两款游戏玩家栏中的分数", async ({ page }, testInfo) => {
  const name = "默认头像与长名称排列验收玩家";
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const game of ["whoisfaker", "songuessr"]) {
    await page.goto(`/${game}`);
    await page.getByPlaceholder("用户名").fill(name);
    await page.getByRole("button", { name: "创建房间", exact: true }).click();
    await page.getByPlaceholder("输入房间名称").fill("玩家栏验收");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${game}/room/\\d{4}$`));
    const score = page.getByLabel("0 分", { exact: true });
    await expect(score).toBeInViewport();
    const visible = await score.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      return element.contains(document.elementFromPoint(x, y));
    });
    expect(visible).toBe(true);
    // 猜歌等待页的队伍成员叠放（TeamPicker）对同一批玩家也带 title —— 那是 aria-hidden
    // 的装饰层；排除它，只断言玩家栏里承载姓名的那个可见元素。
    await expect(page.getByTitle(name).and(page.locator(":not([aria-hidden])"))).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${game}-default-avatar.png`) });
  }
});

test("landing and lobby stay within a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Baka Game" })).toBeVisible();
  expect(await page.evaluate(() => ({
    widthFits: document.documentElement.scrollWidth <= window.innerWidth,
    heightFits: document.documentElement.scrollHeight === window.innerHeight,
    overflow: getComputedStyle(document.documentElement).overflow,
  }))).toEqual({ widthFits: true, heightFits: true, overflow: "hidden" });

  await page.getByRole("button", { name: /Who is Faker/ }).click();
  await expect(page.getByRole("heading", { name: "Who is Faker" })).toBeVisible();
  expect(await page.evaluate(() => ({
    widthFits: document.documentElement.scrollWidth <= window.innerWidth,
    heightFits: document.documentElement.scrollHeight === window.innerHeight,
    overflow: getComputedStyle(document.documentElement).overflow,
  }))).toEqual({ widthFits: true, heightFits: true, overflow: "hidden" });
});

test("internal scrolling works without visible scrollbar chrome", async ({ page }) => {
  await page.goto("/");

  const result = await page.evaluate(() => {
    const probe = document.createElement("div");
    const content = document.createElement("div");
    probe.className = "scrollbar-hidden";
    probe.style.cssText = "position:fixed;inset:0 auto auto 0;width:100px;height:80px;overflow:auto";
    content.style.cssText = "width:240px;height:240px";
    probe.append(content);
    document.body.append(probe);

    probe.scrollTo({ left: probe.scrollWidth, top: probe.scrollHeight });
    const measurement = {
      scrollLeft: probe.scrollLeft,
      scrollTop: probe.scrollTop,
    };
    probe.remove();
    return measurement;
  });

  expect(result).toEqual({
    scrollLeft: 140,
    scrollTop: 160,
  });
});

test("stickers load from stable paths and long chat messages stay inside both panels", async ({ page }) => {
  const assertPageQuality = installPageQualityGuards(page);
  const unique = Date.now().toString(36);
  const measureBubble = async (text: string) => {
    const bubble = page.getByTestId("chat-message-bubble").filter({ hasText: text }).last();
    await expect(bubble).toBeVisible();
    return bubble.evaluate((element) => {
      return {
        clientWidth: (element as HTMLElement).clientWidth,
        scrollWidth: (element as HTMLElement).scrollWidth,
      };
    });
  };

  await page.goto("/whoisfaker");
  await page.getByPlaceholder("用户名").fill(`长消息${unique}`);
  await page.getByRole("button", { name: "创建房间" }).click();
  await page.getByPlaceholder("输入房间名称").fill(`长消息房${unique}`);
  await page.getByRole("button", { name: "创建", exact: true }).click();

  const stickerResponse = page.waitForResponse((response) =>
    /\/stickers\/[0-9a-f]{24}\.(?:apng|gif|jpe?g|png|webp)$/.test(new URL(response.url()).pathname),
  );
  await page.getByRole("button", { name: "发送表情" }).click();
  const firstSticker = page.locator('img[src^="/stickers/"]').first();
  await expect(firstSticker).toBeVisible();
  expect((await stickerResponse).status()).toBe(200);
  expect(await firstSticker.getAttribute("src")).toMatch(
    /^\/stickers\/[0-9a-f]{24}\.(?:apng|gif|jpe?g|png|webp)$/,
  );
  expect(await firstSticker.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "发送表情" }).click();

  const whoMessage = "W".repeat(200);
  await page.getByPlaceholder("请输入文本").fill(whoMessage);
  await page.getByRole("button", { name: "发送消息" }).click();
  const whoMetrics = await measureBubble(whoMessage);
  expect(whoMetrics.scrollWidth).toBeLessThanOrEqual(whoMetrics.clientWidth + 1);

  await page.goto("/songuessr");
  await page.getByPlaceholder("用户名").fill(`歌聊${unique}`);
  await page.getByRole("button", { name: "创建房间" }).click();
  await page.getByPlaceholder("输入房间名称").fill(`歌聊房${unique}`);
  await page.getByRole("button", { name: "创建", exact: true }).click();

  const songMessage = "S".repeat(200);
  await page.getByPlaceholder("请输入文本").fill(songMessage);
  await page.getByRole("button", { name: "发送消息" }).click();
  const songMetrics = await measureBubble(songMessage);
  expect(songMetrics.scrollWidth).toBeLessThanOrEqual(songMetrics.clientWidth + 1);
  await assertPageQuality();
});

test("two browser sessions can create and join the same server room", async ({ isolatedContext, page }) => {
  const unique = Date.now().toString(36);
  const roomName = `E2E 集成房间 ${unique}`;
  const hostName = `房主${unique}`;
  const guestName = `访客${unique}`;

  await page.setViewportSize({ width: 1280, height: 400 });
  await page.goto("/whoisfaker");
  await page.getByPlaceholder("用户名").fill(hostName);
  await page.getByRole("button", { name: "创建房间" }).click();
  await page.getByPlaceholder("输入房间名称").fill(roomName);
  await page.getByRole("button", { name: "创建", exact: true }).click();

  await expect(page).toHaveURL(/\/whoisfaker\/room\/\d{4}$/);
  await expect(page.getByText(roomName, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "复制房间链接" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "复制", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "身份设置", exact: true }).click();
  await expect(page.getByText("卧底人数", { exact: true })).toBeVisible();
  await expectActionAreaScrollable(page);

  const roomId = page.url().split("/").at(-1);
  const guestContext = await isolatedContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto("http://127.0.0.1:5173/whoisfaker");
  await guestPage.getByPlaceholder("用户名").fill(guestName);
  await guestPage.getByRole("button", { name: new RegExp(roomName) }).click();

  await expect(guestPage).toHaveURL(new RegExp(`/whoisfaker/room/${roomId}$`));
  await expect(guestPage.getByText(roomName, { exact: true })).toBeVisible();
  await expect(guestPage.getByRole("button", { name: "复制房间链接" })).toHaveCount(0);
  await expect(guestPage.getByRole("button", { name: "复制", exact: true })).toBeVisible();
  await expect(page.getByText(guestName, { exact: true })).toBeVisible();
  await closeIsolatedContext(guestContext);
});

test("独自一人在旁观动画途中切回，自己的玩家行仍然可见", async ({ page }) => {
  const unique = Date.now().toString(36);
  const name = `独自${unique}`;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/whoisfaker");
  await page.getByPlaceholder("用户名").fill(name);
  await page.getByRole("button", { name: "创建房间" }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page).toHaveURL(/\/whoisfaker\/room\/\d{4}$/);
  const row = page.locator(`span[title="${name}"]`);
  await expect(row).toBeVisible();
  // 等进房的入场动画落定，下面的切换才是「第一次」换组。
  await page.waitForTimeout(1_000);

  await page.getByRole("button", { name: "加入旁观" }).click();
  // 不等入口滑完：旧行退场播到一半时切回来，正是会把行「复活」成透明态的时机。
  // force 跳过 Playwright 的稳定性等待，否则点击会被拖到动画播完之后。
  await page.getByRole("button", { name: "取消旁观" }).waitFor({ state: "attached" });
  await page.waitForTimeout(250);
  await page.getByRole("button", { name: "取消旁观" }).click({ force: true });
  await expect(page.getByRole("button", { name: "加入旁观" })).toBeVisible();
  // 旧行退场卸载后只剩一行，且它连同祖先都完全不透明。
  await expect.poll(() => row.evaluateAll((elements) => elements.map((element) => {
    for (let node: HTMLElement | null = element as HTMLElement; node; node = node.parentElement) {
      if (getComputedStyle(node).opacity !== "1") return false;
    }
    return true;
  }))).toEqual([true]);
});

test("empty description history keeps the player pane width after a direct voting jump", async ({ page }) => {
  const unique = Date.now().toString(36);
  await page.setViewportSize({ width: 1440, height: 900 });
  // 直链用小写房号：测试房号大小写不敏感，客户端必须归一成服务端的规范房号后再入房。
  await page.goto("/whoisfaker/room/oblivionis");
  await page.getByPlaceholder("用户名").fill(`历史测试${unique}`);
  await page.getByRole("button", { name: "进入房间" }).click();
  await expect(page.getByText("#Oblivionis")).toBeVisible();

  const addBot = page.getByRole("button", { name: "添加一个测试人机" });
  await page.getByRole("button", { name: "等待中", exact: true }).click();
  await removeAllTestBots(page);
  for (let index = 0; index < 4; index += 1) await addBot.click();

  await page.getByRole("button", { name: "投票阶段", exact: true }).click();
  await expect(page.getByRole("heading", { name: "投票阶段", exact: true })).toBeVisible();

  const playerPane = page.locator("section > aside").first();
  const roomSection = playerPane.locator("..");
  const playerSpacer = playerPane.locator("xpath=preceding-sibling::div[1]");
  const collapsedWidths = await Promise.all([
    playerPane.evaluate((element) => element.getBoundingClientRect().width),
    playerSpacer.evaluate((element) => element.getBoundingClientRect().width),
  ]);
  expect(Math.abs(collapsedWidths[0] - collapsedWidths[1])).toBeLessThan(1);
  await page.getByRole("button", { name: "展开发言历史" }).click();
  await expect(page.getByRole("button", { name: "收起发言历史" })).toBeVisible();
  await expect.poll(async () => {
    const [paneWidth, sectionWidth] = await Promise.all([
      playerPane.evaluate((element) => element.getBoundingClientRect().width),
      roomSection.evaluate((element) => element.getBoundingClientRect().width),
    ]);
    return Math.abs(paneWidth - sectionWidth);
  }).toBeLessThan(1);
});

test("a decisive vote shows the eliminated player before game over", async ({ isolatedContext, page }) => {
  // 本用例是本套件里最重的一条：5 个浏览器上下文跑完整的建房 → 分配身份 → 描述 → 投票 → 结算。
  // 游戏最少需要 4 名玩家，上下文数量已无法再减，只能靠并行加入与资源屏蔽提速。
  // CI 的 2 核 runner 比本地慢约 6 倍，180 秒预算实测三次全超（全部步骤都满足、
  // 纯粹是累积耗时，无死锁），因此 CI 预算放宽到 300 秒，本地保持 180 秒。
  test.setTimeout(process.env.CI ? 300_000 : 180_000);
  const unique = Date.now().toString(36);
  const hostName = `结算主持${unique}`;
  const playerNames = Array.from({ length: 4 }, (_, index) => `结算玩家${index + 1}-${unique}`);
  const playerContexts: BrowserContext[] = [];
  // 屏蔽图片/字体/音视频：本用例断言只依赖 DOM 结构与文本，CI 的 2 核 runner
  // 上 5 个页面重复加载这些静态资源是显著的纯开销。
  const trimHeavyAssets = (context: BrowserContext) => {
    void context.route(/\.(png|jpe?g|gif|webp|avif|svg|woff2?|otf|ttf|mp3|mp4|webm)(\?.*)?$/, (route) => isLoopbackUrl(route.request().url()) ? route.abort() : route.fallback());
  };

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  trimHeavyAssets(page.context());
  await page.goto("/whoisfaker");
  await page.getByPlaceholder("用户名").fill(hostName);
  await page.getByRole("button", { name: "创建房间" }).click();
  await page.getByPlaceholder("输入房间名称").fill(`结算展示房${unique}`);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page).toHaveURL(/\/whoisfaker\/room\/\d{4}$/);
  const roomUrl = page.url();

  try {
    // 4 名玩家并行建房加入：各自的页面与会话完全独立，是真实多人场景，
    // 串行加载 4 个生产 bundle 在 CI 上光加入就要消耗 1 分钟以上。
    // map 保序，playerPages[i] 对应 playerNames[i]。
    const playerPages = await Promise.all(playerNames.map(async (playerName) => {
      const context = await isolatedContext({ reducedMotion: "reduce" });
      playerContexts.push(context);
      trimHeavyAssets(context);
      const playerPage = await context.newPage();
      await playerPage.goto(roomUrl);
      await playerPage.getByPlaceholder("用户名").fill(playerName);
      await playerPage.getByRole("button", { name: "进入房间" }).click();
      await playerPage.getByRole("button", { name: "准备", exact: true }).click();
      return playerPage;
    }));

    await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "开始游戏", exact: true }).click();
    await expect(page.getByRole("heading", { name: "指定主持人" })).toBeVisible();
    await page.getByRole("button", { name: hostName, exact: true }).click();
    await expect(page.getByRole("heading", { name: "指定主持人" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "提交词语" })).toBeVisible();
    await expect(page.getByRole("button", { name: "确认提交" })).toBeVisible();

    const fillInput = async (placeholder: string, value: string) => {
      const input = page.getByPlaceholder(placeholder);
      await expect(input).toBeVisible();
      await expect.poll(async () => {
        await input.fill(value);
        return input.inputValue();
      }).toBe(value);
    };

    await fillInput("输入平民获得的词语", "苹果");
    await fillInput("输入卧底获得的词语", "香蕉");

    await page.getByRole("switch").click();
    const firstRoleGroup = page.getByRole("radiogroup", { name: `为 ${playerNames[0]} 分配身份` });
    await expect(firstRoleGroup).toBeVisible();
    for (const [index, playerName] of playerNames.entries()) {
      const roleGroup = page.getByRole("radiogroup", { name: `为 ${playerName} 分配身份` });
      // 分段控件的单选框藏在可见标签下面，点标签选中。
      await roleGroup.getByText(index === 0 ? "卧底" : "平民", { exact: true }).click();
    }

    await expect(page.getByPlaceholder("输入平民获得的词语")).toHaveValue("苹果");
    await expect(page.getByPlaceholder("输入卧底获得的词语")).toHaveValue("香蕉");
    await page.getByRole("button", { name: "确认提交" }).click();
    await expect(page.getByRole("heading", { name: "描述阶段" })).toBeVisible();

    // 提交不限座位顺序（服务端只查存活与去重），但其他玩家的提交会触发快照
    // 广播与输入区重渲染，单次「输入→点击」可能恰好落在重渲染窗口里丢失。
    // 因此用轮询整段重试，直到该玩家输入区消失（提交成功）为止。
    // 另外首日描述阶段会自动揭词（居中背板 + 全屏 blur，约数秒后收回），
    // click 若恰好撞进背板动画窗口会长期不满足 stable/enabled——必须给每个
    // 操作设短超时，让 poll 能进入下一轮；否则单次 click 会把整个 predicate 挂死。
    for (const [index, playerPage] of playerPages.entries()) {
      await expect(playerPage.getByRole("heading", { name: "描述阶段" })).toBeVisible();
      await expect.poll(async () => {
        try {
          const descInput = playerPage.getByPlaceholder("输入你的描述...");
          if ((await descInput.count()) === 0) return true;
          await descInput.fill(`描述${index + 1}`, { timeout: 2_500 });
          const send = playerPage.getByRole("button", { name: "发送", exact: true });
          if (!(await send.isEnabled())) return false;
          await send.click({ timeout: 2_500 });
          return (await descInput.count()) === 0;
        } catch {
          return false;
        }
      }, { timeout: 60_000, intervals: [500] }).toBe(true);
    }

    await page.getByRole("button", { name: "进入投票阶段" }).click();
    await expect(page.getByRole("heading", { name: "投票阶段", exact: true })).toBeVisible();

    // 投票同为互不依赖的独立操作，真实场景即同时进行；投票界面的快照更新
    // 同样可能打断单次点击，轮询到「已完成投票」出现为止。click 同样必须
    // 设短超时防止单次 action 把整个 predicate 挂死（与描述段同理）。
    await Promise.all(playerPages.map(async (playerPage, index) => {
      const targetName = index === 0 ? playerNames[1]! : playerNames[0]!;
      await expect.poll(async () => {
        try {
          const done = playerPage.getByText("已完成投票", { exact: true });
          if ((await done.count()) > 0) return true;
          const target = playerPage.getByRole("button", { name: targetName, exact: true });
          if ((await target.count()) === 0) return false;
          await target.click({ timeout: 2_500 });
          return (await done.count()) > 0;
        } catch {
          return false;
        }
      }, { timeout: 60_000, intervals: [500] }).toBe(true);
    }));

    await page.getByRole("button", { name: "结算投票" }).click();
    // 结算投票后先停在「投票结果」反馈阶段，由主持人点「查看结算」才推进到结算页。
    const viewSettlement = page.getByRole("button", { name: "查看结算" });
    await expect(viewSettlement).toBeVisible();
    await viewSettlement.click();
    await expect(page.getByText("好人阵营胜利", { exact: true })).toBeVisible();
    await expect(page.getByLabel("已出局")).toHaveCount(1);
  } finally {
    await Promise.all(playerContexts.map(closeIsolatedContext));
  }
});

test("two browser sessions can create and join a Songuessr room", async ({ isolatedContext, page }) => {
  const unique = Date.now().toString(36);
  const roomName = `E2E 音乐房间 ${unique}`;
  const hostName = `歌房主${unique}`;
  const guestName = `歌访客${unique}`;

  await page.setViewportSize({ width: 1280, height: 400 });
  await page.goto("/songuessr");
  await page.getByPlaceholder("用户名").fill(hostName);
  await page.getByRole("button", { name: "创建房间" }).click();
  await page.getByPlaceholder("输入房间名称").fill(roomName);
  await page.getByRole("button", { name: "创建", exact: true }).click();

  await expect(page).toHaveURL(/\/songuessr\/room\/\d{4}$/);
  await expect(page.getByText(roomName, { exact: true })).toBeVisible();
  await expect(page.locator("header").first()).toBeVisible();
  await expect(page.locator("main").first()).toBeVisible();
  await expect(page.locator("aside").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "复制房间链接" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "复制", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "题目设置", exact: true }).click();
  await expect(page.getByText("自动轮流出题", { exact: true })).toBeVisible();
  await expectActionAreaScrollable(page);

  const roomId = page.url().split("/").at(-1);
  const guestContext = await isolatedContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto("http://127.0.0.1:5173/songuessr");
  await guestPage.getByPlaceholder("用户名").fill(guestName);
  await guestPage.getByRole("button", { name: new RegExp(roomName) }).click();

  await expect(guestPage).toHaveURL(new RegExp(`/songuessr/room/${roomId}$`));
  await expect(guestPage.getByText(roomName, { exact: true })).toBeVisible();
  await expect(guestPage.getByRole("button", { name: "复制房间链接" })).toHaveCount(0);
  await expect(guestPage.getByRole("button", { name: "复制", exact: true })).toBeVisible();
  await expect(page.getByText(guestName, { exact: true })).toBeVisible();
  await closeIsolatedContext(guestContext);
});

test("Songuessr direct room URL creates the room and leaving returns cleanly", async ({ page }) => {
  // 只替换必须访问真实网易云的二维码创建/轮询；房间与其余命令仍走隔离真实服务。
  let qrCreates = 0;
  await page.routeWebSocket((url) => isLoopbackUrl(url) && url.pathname === "/api/songuessr/ws", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (typeof message !== "string") { server.send(message); return; }
      const command = JSON.parse(message) as { type: string; id: string };
      let payload: unknown;
      if (command.type === "song.auth.qr.create") {
        qrCreates += 1;
        payload = { key: "e2e-qr", qrImage: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" };
      } else if (command.type === "song.auth.qr.check") {
        payload = { status: "waiting", message: "隔离夹具等待扫码" };
      } else { server.send(message); return; }
      socket.send(JSON.stringify({ type: "ack", id: command.id, requestType: command.type, payload }));
    });
  });
  const roomId = String(1_000 + (Date.now() % 8_900));
  const userName = `直链玩家${Date.now().toString(36)}`;

  await page.goto(`/songuessr/room/${roomId}`);
  await expect(page.getByRole("heading", { name: "设置用户名" })).toBeVisible();
  await page.getByPlaceholder("用户名").fill(userName);
  await page.getByRole("button", { name: "进入房间" }).click();

  await expect(page).toHaveURL(new RegExp(`/songuessr/room/${roomId}$`));
  await expect(page.getByText(`${userName}的房间`, { exact: true })).toBeVisible();
  await expect(page.getByRole("slider", { name: "播放音量" })).toBeVisible();
  await page.getByRole("button", { name: /音乐账号配置/ }).click();
  const qrImage = page.getByAltText("网易云登录二维码");
  await expect(qrImage).toBeVisible();
  await expect.poll(() => qrImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  expect(qrCreates).toBe(1);
  await expect(page.getByText(/服务器不会保存账号信息/)).toBeVisible();

  await page.getByRole("button", { name: "离开房间" }).click();
  await expect(page).toHaveURL(/\/songuessr$/);
  await expect(page.getByText(/会话.*失效|会话令牌无效/)).toHaveCount(0);
});

test("private Songuessr rooms stay listed and direct links request the password", async ({ isolatedContext, page }) => {
  const unique = Date.now().toString(36);
  const roomName = `私密音乐房 ${unique}`;
  const password = `pw-${unique}`;

  await page.goto("/songuessr");
  await page.getByPlaceholder("用户名").fill(`私密房主${unique}`);
  await page.getByRole("button", { name: "创建房间" }).click();
  const createDialog = page.getByRole("dialog");
  await createDialog.getByPlaceholder("输入房间名称").fill(roomName);
  await createDialog.locator('button[role="switch"]').first().click();
  await createDialog.getByPlaceholder("设置房间密码").fill(password);
  await createDialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page).toHaveURL(/\/songuessr\/room\/\d{4}$/);
  await expect(page.getByText(roomName, { exact: true })).toBeVisible();
  const roomId = page.url().split("/").at(-1)!;

  const guestContext = await isolatedContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto("http://127.0.0.1:5173/songuessr");
  await guestPage.getByPlaceholder("用户名").fill(`私密访客${unique}`);
  await expect(guestPage.getByText(roomName, { exact: true })).toBeVisible();
  await guestPage.goto(`http://127.0.0.1:5173/songuessr/room/${roomId}`);
  await expect(guestPage.getByRole("heading", { name: "输入房间密码" })).toBeVisible();
  await guestPage.getByPlaceholder("请输入密码").fill(password);
  await guestPage.getByRole("button", { name: "加入房间" }).click();
  await expect(guestPage).toHaveURL(new RegExp(`/songuessr/room/${roomId}$`));
  await expect(guestPage.getByText(roomName, { exact: true })).toBeVisible();
  await closeIsolatedContext(guestContext);
});

test("Songuessr test room exposes bots and guests can switch to spectator", async ({ isolatedContext, page }) => {
  const unique = Date.now().toString(36);
  await page.goto("/songuessr/room/Oblivionis");
  await expect(page.getByRole("heading", { name: "设置用户名" })).toBeVisible();
  await page.getByPlaceholder("用户名").fill(`测试房主${unique}`);
  await page.getByRole("button", { name: "进入房间" }).click();
  await expect(page.getByText("测试控制器", { exact: true })).toBeVisible();

  await removeAllTestBots(page);
  await page.getByRole("button", { name: "添加一个测试人机" }).click();
  await expect(page.getByLabel("测试人机", { exact: true })).toHaveCount(1);

  const guestContext = await isolatedContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto("http://127.0.0.1:5173/songuessr/room/Oblivionis");
  await guestPage.getByPlaceholder("用户名").fill(`旁观访客${unique}`);
  await guestPage.getByRole("button", { name: "进入房间" }).click();
  await guestPage.getByRole("button", { name: "加入旁观" }).click();
  await expect(guestPage.getByRole("button", { name: "取消旁观" })).toBeVisible();
  await expect(page.getByText(`旁观访客${unique}`, { exact: true }).first()).toBeVisible();
  await closeIsolatedContext(guestContext);
});


test("大厅卡片在亮暗移动桌面均不透光、人数用等宽数字且不溢出", async ({ page }) => {
  const assertQuality = installPageQualityGuards(page);
  await page.routeWebSocket(/ws:\/\/127\.0\.0\.1:4850\/api\/songuessr\/ws/, socket => {
    socket.onMessage(message => {
      const command = JSON.parse(String(message)) as { id: string; type: string };
      if (command.type !== "song.lobby.subscribeRooms") throw new Error(`Unexpected fixture command: ${command.type}`);
      socket.send(JSON.stringify({ type: "ack", id: command.id, requestType: command.type, payload: {} }));
      socket.send(JSON.stringify({ type: "event", event: "song.lobby.rooms", payload: [
        { roomId: "8629", name: "长房间名称与人数排版浏览器验收".repeat(3), phase: "playing", playerCount: 2, spectatorCount: 13, onlineCount: 15, visibility: "public", hasPassword: true, allowSpectators: true },
        { roomId: "1234", name: "等待房", phase: "waiting", playerCount: 15, spectatorCount: 0, onlineCount: 15, visibility: "public", hasPassword: false, allowSpectators: false },
      ] }));
    });
  });
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(theme => localStorage.setItem("bakagame-theme", theme), theme);
      await page.goto("/songuessr");
      await page.evaluate(theme => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
      const card = page.getByRole("button", { name: /长房间名称与人数排版浏览器验收/ });
      await expect(card).toBeVisible();
      await expect.poll(() => assertLobbyRendering(card).then(() => true, () => false)).toBe(true);
      await card.hover();
      await expect.poll(() => assertLobbyRendering(card).then(() => true, () => false)).toBe(true);
      // 猜歌大厅只给听歌识番挂题型标签，默认的听歌识曲不标。
      await expect(card).toHaveText("长房间名称与人数排版浏览器验收".repeat(3) + "房间号 8629游戏中可旁观2 人 · 13 旁观");
    }
  }
  // 故意破坏实际渲染，验证同一个检查能检出透明背景与溢出；不以类名存在作为通过条件。
  const card = page.getByRole("button", { name: /长房间名称与人数排版浏览器验收/ });
  const transparency = await page.addStyleTag({ content: "* { background-color: transparent !important; }" });
  await expect.poll(() => assertLobbyRendering(card).then(() => "passed", (error: Error) => error.message)).toBe("Lobby card background is translucent");
  await transparency.evaluate(element => element.parentNode?.removeChild(element));
  await expect.poll(() => assertLobbyRendering(card).then(() => true, () => false)).toBe(true);
  await page.addStyleTag({ content: '[role="button"] { background-color: white !important; min-width: 2000px !important; }' });
  await expect.poll(() => assertLobbyRendering(card).then(() => "passed", (error: Error) => error.message)).toBe("Lobby card overflows its viewport");
  await assertQuality();
});
