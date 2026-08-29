import { expect, test, type Page } from "@playwright/test";

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

test("landing page exposes both playable games and keeps placeholders disabled", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Baka Game" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Who is Faker" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Songuessr" })).toBeVisible();
  await expect(page.locator('[aria-disabled="true"]')).toHaveCount(1);
  expect(await page.getByText("Who is Faker", { exact: true }).evaluate((element) => (
    Number.parseFloat(getComputedStyle(element).fontSize)
  ))).toBeGreaterThanOrEqual(20);

  await page.getByRole("button", { name: "Who is Faker" }).click();
  await expect(page).toHaveURL(/\/whoisfaker$/);
  await expect(page.getByRole("heading", { name: "Who is Faker" })).toBeVisible();
  const fakerImageStyle = await page.getByAltText("Faker").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      width: element.getBoundingClientRect().width,
      borderRadius: Number.parseFloat(style.borderRadius),
    };
  });
  expect(fakerImageStyle.width).toBeGreaterThan(45);
  expect(fakerImageStyle.borderRadius).toBeGreaterThanOrEqual(8);
});

test("landing game entries stay horizontal and clear of the footer", async ({ page }) => {
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
    const yPositions = resolvedBoxes.map((box) => box.y);
    expect(Math.max(...yPositions) - Math.min(...yPositions)).toBeLessThan(3);
    expect(resolvedBoxes[0]!.x).toBeLessThan(resolvedBoxes[1]!.x);
    expect(resolvedBoxes[1]!.x).toBeLessThan(resolvedBoxes[2]!.x);
    expect(Math.min(...resolvedBoxes.map((box) => box.y))).toBeGreaterThanOrEqual(
      headerBox!.y + headerBox!.height,
    );
    expect(Math.max(...resolvedBoxes.map((box) => box.y + box.height))).toBeLessThanOrEqual(
      footerBox!.y,
    );
  }
});

test("players in a room are prompted when a newer build is deployed", async ({ page }) => {
  await page.route("**/?version-check=*", async (route) => {
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
  await expect(page.getByRole("status")).toContainText("游戏有新版本，请刷新后继续游玩");
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
  await page.getByRole("button", { name: "Songuessr" }).click();

  await expect(page).toHaveURL(/\/songuessr$/);
  await expect(page.getByRole("heading", { name: "Songuessr" })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建房间" })).toBeVisible();
});

test("Songuessr lobby uses the same shell as Who is Faker", async ({ page }) => {
  const readShellClasses = async () => ({
    root: await page.locator("#root > div").first().getAttribute("class"),
    header: await page.locator("header").first().getAttribute("class"),
    headerInner: await page.locator("header > div").first().getAttribute("class"),
    main: await page.locator("main").first().getAttribute("class"),
    toolbar: await page.locator("main > div").first().getAttribute("class"),
  });

  await page.goto("/whoisfaker");
  const whoIsFakerShell = await readShellClasses();

  await page.goto("/songuessr");
  expect(await readShellClasses()).toEqual(whoIsFakerShell);
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

  await page.getByRole("button", { name: "Who is Faker" }).click();
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

    const style = getComputedStyle(probe);
    const webkitScrollbar = getComputedStyle(probe, "::-webkit-scrollbar");
    probe.scrollTo({ left: probe.scrollWidth, top: probe.scrollHeight });
    const measurement = {
      scrollbarWidth: style.getPropertyValue("scrollbar-width"),
      webkitDisplay: webkitScrollbar.display,
      webkitWidth: webkitScrollbar.width,
      webkitHeight: webkitScrollbar.height,
      scrollLeft: probe.scrollLeft,
      scrollTop: probe.scrollTop,
    };
    probe.remove();
    return measurement;
  });

  expect(result).toEqual({
    scrollbarWidth: "none",
    webkitDisplay: "none",
    webkitWidth: "0px",
    webkitHeight: "0px",
    scrollLeft: 140,
    scrollTop: 160,
  });
});

test("stickers load from stable paths and long chat messages stay inside both panels", async ({ page }) => {
  const unique = Date.now().toString(36);
  const measureBubble = async (text: string) => {
    const textNode = page.getByText(text, { exact: true }).last();
    await expect(textNode).toBeVisible();
    return textNode.evaluate((element) => {
      const candidate = element as HTMLElement;
      const bubble = candidate.className.includes("max-w-[85%]")
        ? candidate
        : candidate.parentElement!;
      return {
        clientWidth: bubble.clientWidth,
        scrollWidth: bubble.scrollWidth,
        overflowWrap: getComputedStyle(bubble).overflowWrap,
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
  expect(whoMetrics.overflowWrap).toBe("anywhere");

  await page.goto("/songuessr");
  await page.getByPlaceholder("用户名").fill(`歌聊${unique}`);
  await page.getByRole("button", { name: "创建房间" }).click();
  await page.getByPlaceholder("输入房间名称").fill(`歌聊房${unique}`);
  await page.getByRole("button", { name: "创建", exact: true }).click();

  const songMessage = "S".repeat(200);
  await page.getByPlaceholder("发送消息...").fill(songMessage);
  await page.getByRole("button", { name: "发送消息" }).click();
  const songMetrics = await measureBubble(songMessage);
  expect(songMetrics.scrollWidth).toBeLessThanOrEqual(songMetrics.clientWidth + 1);
  expect(songMetrics.overflowWrap).toBe("anywhere");
});

test("two browser sessions can create and join the same server room", async ({ browser, page }) => {
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
  await page.getByRole("button", { name: "房间设置", exact: true }).click();
  await expect(page.getByText("卧底人数", { exact: true })).toBeVisible();
  await expectActionAreaScrollable(page);

  const roomId = page.url().split("/").at(-1);
  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto("http://localhost:5173/whoisfaker");
  await guestPage.getByPlaceholder("用户名").fill(guestName);
  await guestPage.getByRole("button", { name: new RegExp(roomName) }).click();

  await expect(guestPage).toHaveURL(new RegExp(`/whoisfaker/room/${roomId}$`));
  await expect(guestPage.getByText(roomName, { exact: true })).toBeVisible();
  await expect(guestPage.getByRole("button", { name: "复制房间链接" })).toHaveCount(0);
  await expect(guestPage.getByRole("button", { name: "复制", exact: true })).toBeVisible();
  await expect(page.getByText(guestName, { exact: true })).toBeVisible();
  await guestContext.close();
});

test("empty description history keeps the player pane width after a direct voting jump", async ({ page }) => {
  const unique = Date.now().toString(36);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/whoisfaker/room/Oblivionis");
  await page.getByPlaceholder("用户名").fill(`历史测试${unique}`);
  await page.getByRole("button", { name: "进入房间" }).click();

  const addBot = page.getByRole("button", { name: "添加一个测试人机" });
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

  const firstColumn = playerPane.locator('[style*="grid-template-columns"]').first();
  const firstColumnWidth = await firstColumn.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).gridTemplateColumns),
  );
  expect(Math.abs(firstColumnWidth - collapsedWidths[1])).toBeLessThan(1);
});

test("a decisive vote shows the eliminated player before game over", async ({ browser, page }) => {
  test.setTimeout(75_000);
  const unique = Date.now().toString(36);
  const hostName = `结算主持${unique}`;
  const playerNames = Array.from({ length: 4 }, (_, index) => `结算玩家${index + 1}-${unique}`);
  const playerContexts = [];
  const waitForPhaseAnimation = async (targetPage: typeof page) => {
    const stage = targetPage.locator('main [style*="will-change"]').first();
    await expect(stage).toBeVisible();
    await expect.poll(async () => stage.evaluate((element) => ({
      opacity: getComputedStyle(element).opacity,
      transform: getComputedStyle(element).transform,
    }))).toEqual({ opacity: "1", transform: "none" });
  };

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/whoisfaker");
  await page.getByPlaceholder("用户名").fill(hostName);
  await page.getByRole("button", { name: "创建房间" }).click();
  await page.getByPlaceholder("输入房间名称").fill(`结算展示房${unique}`);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page).toHaveURL(/\/whoisfaker\/room\/\d{4}$/);
  const roomUrl = page.url();

  try {
    for (const playerName of playerNames) {
      const context = await browser.newContext({ reducedMotion: "reduce" });
      playerContexts.push(context);
      const playerPage = await context.newPage();
      await playerPage.goto(roomUrl);
      await playerPage.getByPlaceholder("用户名").fill(playerName);
      await playerPage.getByRole("button", { name: "进入房间" }).click();
      await playerPage.getByRole("button", { name: "准备", exact: true }).click();
    }

    await expect(page.getByRole("button", { name: "开始游戏", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "开始游戏", exact: true }).click();
    await expect(page.getByRole("heading", { name: "指定主持人" })).toBeVisible();
    await page.getByRole("button", { name: hostName, exact: true }).click();
    await expect(page.getByRole("heading", { name: "提交词语" })).toBeVisible();
    await waitForPhaseAnimation(page);

    await page.getByPlaceholder("输入平民获得的词语").fill("苹果");
    await page.getByPlaceholder("输入卧底获得的词语").fill("香蕉");
    await page.getByRole("switch").click();
    for (const [index, playerName] of playerNames.entries()) {
      const roleGroup = page.getByRole("group", { name: `为 ${playerName} 分配身份` });
      await roleGroup.getByRole("button", { name: index === 0 ? "卧底" : "平民" }).click();
    }
    await page.getByRole("button", { name: "确认提交" }).click();
    await expect(page.getByRole("heading", { name: "描述阶段" })).toBeVisible();

    const playerPages = playerContexts.map((context) => context.pages()[0]!);
    for (const [index, playerPage] of playerPages.entries()) {
      await expect(playerPage.getByPlaceholder("输入你的描述...")).toBeVisible();
      await waitForPhaseAnimation(playerPage);
      await playerPage.getByPlaceholder("输入你的描述...").fill(`描述${index + 1}`);
      await playerPage.getByRole("button", { name: "发送", exact: true }).click();
      await expect(playerPage.getByPlaceholder("输入你的描述...")).toHaveCount(0);
    }

    await page.getByRole("button", { name: "进入投票阶段" }).click();
    await expect(page.getByRole("heading", { name: "投票阶段", exact: true })).toBeVisible();

    for (const [index, playerPage] of playerPages.entries()) {
      const targetName = index === 0 ? playerNames[1]! : playerNames[0]!;
      await playerPage.getByRole("button", { name: targetName, exact: true }).click();
      await expect(playerPage.getByText("已完成投票", { exact: true })).toBeVisible();
    }

    await page.getByRole("button", { name: "结算投票" }).click();
    await expect(page.getByRole("heading", { name: "投票阶段", exact: true })).toBeVisible();
    await expect(page.getByLabel("已出局")).toHaveCount(1);
    await expect(page.getByText("好人阵营胜利", { exact: true })).toHaveCount(0);
    await expect(page.getByText("好人阵营胜利", { exact: true })).toBeVisible();
  } finally {
    await Promise.all(playerContexts.map((context) => context.close()));
  }
});

test("two browser sessions can create and join a Songuessr room", async ({ browser, page }) => {
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
  await expect(page.locator("header").first()).toHaveClass(/grid h-14 shrink-0/);
  await expect(page.locator("main").first()).toHaveClass(/isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-panel/);
  await expect(page.locator("aside").first()).toHaveClass(/absolute inset-y-0 left-0 z-30 hidden flex-col rounded-xl border bg-panel md:flex/);
  await expect(page.getByRole("button", { name: "复制房间链接" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "复制", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "题目设置", exact: true }).click();
  await expect(page.getByText("自动轮流出题", { exact: true })).toBeVisible();
  await expectActionAreaScrollable(page);

  const roomId = page.url().split("/").at(-1);
  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto("http://localhost:5173/songuessr");
  await guestPage.getByPlaceholder("用户名").fill(guestName);
  await guestPage.getByRole("button", { name: new RegExp(roomName) }).click();

  await expect(guestPage).toHaveURL(new RegExp(`/songuessr/room/${roomId}$`));
  await expect(guestPage.getByText(roomName, { exact: true })).toBeVisible();
  await expect(guestPage.getByRole("button", { name: "复制房间链接" })).toHaveCount(0);
  await expect(guestPage.getByRole("button", { name: "复制", exact: true })).toBeVisible();
  await expect(page.getByText(guestName, { exact: true })).toBeVisible();
  await guestContext.close();
});

test("Songuessr direct room URL creates the room and leaving returns cleanly", async ({ page }) => {
  const roomId = String(1_000 + (Date.now() % 8_900));
  const userName = `直链玩家${Date.now().toString(36)}`;

  await page.goto(`/songuessr/room/${roomId}`);
  await expect(page.getByRole("heading", { name: "设置用户名" })).toBeVisible();
  await page.getByPlaceholder("用户名").fill(userName);
  await page.getByRole("button", { name: "进入房间" }).click();

  await expect(page).toHaveURL(new RegExp(`/songuessr/room/${roomId}$`));
  await expect(page.getByText(`${userName}的房间`, { exact: true })).toBeVisible();
  await expect(page.getByRole("slider", { name: "播放音量" })).toBeVisible();
  await page.getByRole("button", { name: /网易云账号/ }).click();
  await expect(page.getByAltText("网易云登录二维码")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/服务器不会保存账号信息/)).toBeVisible();

  await page.getByRole("button", { name: "离开房间" }).click();
  await expect(page).toHaveURL(/\/songuessr$/);
  await expect(page.getByText(/会话.*失效|会话令牌无效/)).toHaveCount(0);
});

test("private Songuessr rooms stay listed and direct links request the password", async ({ browser, page }) => {
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

  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto("http://localhost:5173/songuessr");
  await guestPage.getByPlaceholder("用户名").fill(`私密访客${unique}`);
  await expect(guestPage.getByText(roomName, { exact: true })).toBeVisible();
  await guestPage.goto(`http://localhost:5173/songuessr/room/${roomId}`);
  await expect(guestPage.getByRole("heading", { name: "输入房间密码" })).toBeVisible();
  await guestPage.getByPlaceholder("请输入密码").fill(password);
  await guestPage.getByRole("button", { name: "加入房间" }).click();
  await expect(guestPage).toHaveURL(new RegExp(`/songuessr/room/${roomId}$`));
  await expect(guestPage.getByText(roomName, { exact: true })).toBeVisible();
  await guestContext.close();
});

test("Songuessr test room exposes bots and guests can switch to spectator", async ({ browser, page }) => {
  const unique = Date.now().toString(36);
  await page.goto("/songuessr/room/Oblivionis");
  await expect(page.getByRole("heading", { name: "设置用户名" })).toBeVisible();
  await page.getByPlaceholder("用户名").fill(`测试房主${unique}`);
  await page.getByRole("button", { name: "进入房间" }).click();
  await expect(page.getByText("测试控制器", { exact: true })).toBeVisible();

  await removeAllTestBots(page);
  await page.getByRole("button", { name: "添加一个测试人机" }).click();
  await expect(page.getByLabel("测试人机", { exact: true })).toHaveCount(1);

  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto("http://localhost:5173/songuessr/room/Oblivionis");
  await guestPage.getByPlaceholder("用户名").fill(`旁观访客${unique}`);
  await guestPage.getByRole("button", { name: "进入房间" }).click();
  await guestPage.getByRole("button", { name: "加入旁观" }).click();
  await expect(guestPage.getByRole("button", { name: "取消旁观" })).toBeVisible();
  await expect(page.getByText(`旁观访客${unique}`, { exact: true }).first()).toBeVisible();
  await guestContext.close();
});
