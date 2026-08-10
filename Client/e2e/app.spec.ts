import { expect, test } from "@playwright/test";

test("landing page exposes both playable games and keeps placeholders disabled", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Baka Game" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Who is Faker" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Song Guessr" })).toBeVisible();
  await expect(page.locator('[aria-disabled="true"]')).toHaveCount(1);

  await page.getByRole("button", { name: "Who is Faker" }).click();
  await expect(page).toHaveURL(/\/whoisfaker$/);
  await expect(page.getByRole("heading", { name: "Who is Faker" })).toBeVisible();
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

  await page.goto("/songguessr/unknown");
  await expect(page).toHaveURL(/\/songguessr$/);
  await expect(page.getByRole("heading", { name: "Song Guessr" })).toBeVisible();
});

test("Song Guessr is reachable from the landing page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Song Guessr" }).click();

  await expect(page).toHaveURL(/\/songguessr$/);
  await expect(page.getByRole("heading", { name: "Song Guessr" })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建房间" })).toBeVisible();
});

test("Song Guessr lobby uses the same shell as Who is Faker", async ({ page }) => {
  const readShellClasses = async () => ({
    root: await page.locator("#root > div").first().getAttribute("class"),
    header: await page.locator("header").first().getAttribute("class"),
    headerInner: await page.locator("header > div").first().getAttribute("class"),
    main: await page.locator("main").first().getAttribute("class"),
    toolbar: await page.locator("main > div").first().getAttribute("class"),
  });

  await page.goto("/whoisfaker");
  const whoIsFakerShell = await readShellClasses();

  await page.goto("/songguessr");
  expect(await readShellClasses()).toEqual(whoIsFakerShell);
});

test("landing and lobby stay within a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Baka Game" })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);

  await page.getByRole("button", { name: "Who is Faker" }).click();
  await expect(page.getByRole("heading", { name: "Who is Faker" })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
});

test("two browser sessions can create and join the same server room", async ({ browser, page }) => {
  const unique = Date.now().toString(36);
  const roomName = `E2E 集成房间 ${unique}`;
  const hostName = `房主${unique}`;
  const guestName = `访客${unique}`;

  await page.goto("/whoisfaker");
  await page.getByPlaceholder("用户名").fill(hostName);
  await page.getByRole("button", { name: "创建房间" }).click();
  await page.getByPlaceholder("输入房间名称").fill(roomName);
  await page.getByRole("button", { name: "创建", exact: true }).click();

  await expect(page).toHaveURL(/\/whoisfaker\/room\/\d{4}$/);
  await expect(page.getByText(roomName, { exact: true })).toBeVisible();

  const roomId = page.url().split("/").at(-1);
  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto("http://localhost:5173/whoisfaker");
  await guestPage.getByPlaceholder("用户名").fill(guestName);
  await guestPage.getByRole("button", { name: new RegExp(roomName) }).click();

  await expect(guestPage).toHaveURL(new RegExp(`/whoisfaker/room/${roomId}$`));
  await expect(guestPage.getByText(roomName, { exact: true })).toBeVisible();
  await expect(page.getByText(guestName, { exact: true })).toBeVisible();
  await guestContext.close();
});

test("two browser sessions can create and join a Song Guessr room", async ({ browser, page }) => {
  const unique = Date.now().toString(36);
  const roomName = `E2E 音乐房间 ${unique}`;
  const hostName = `歌房主${unique}`;
  const guestName = `歌访客${unique}`;

  await page.goto("/songguessr");
  await page.getByPlaceholder("用户名").fill(hostName);
  await page.getByRole("button", { name: "创建房间" }).click();
  await page.getByPlaceholder("输入房间名称").fill(roomName);
  await page.getByRole("button", { name: "创建", exact: true }).click();

  await expect(page).toHaveURL(/\/songguessr\/room\/\d{4}$/);
  await expect(page.getByText(roomName, { exact: true })).toBeVisible();
  await expect(page.locator("header").first()).toHaveClass(/grid h-14 shrink-0/);
  await expect(page.locator("main").first()).toHaveClass(/isolate flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-panel/);
  await expect(page.locator("aside").first()).toHaveClass(/absolute inset-y-0 left-0 z-30 hidden flex-col rounded-xl border bg-panel md:flex/);

  const roomId = page.url().split("/").at(-1);
  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto("http://localhost:5173/songguessr");
  await guestPage.getByPlaceholder("用户名").fill(guestName);
  await guestPage.getByRole("button", { name: new RegExp(roomName) }).click();

  await expect(guestPage).toHaveURL(new RegExp(`/songguessr/room/${roomId}$`));
  await expect(guestPage.getByText(roomName, { exact: true })).toBeVisible();
  await expect(page.getByText(guestName, { exact: true })).toBeVisible();
  await guestContext.close();
});

test("Song Guessr direct room URL creates the room and leaving returns cleanly", async ({ page }) => {
  const roomId = String(1_000 + (Date.now() % 8_900));
  const userName = `直链玩家${Date.now().toString(36)}`;

  await page.goto(`/songguessr/room/${roomId}`);
  await expect(page.getByRole("heading", { name: "设置用户名" })).toBeVisible();
  await page.getByPlaceholder("用户名").fill(userName);
  await page.getByRole("button", { name: "进入房间" }).click();

  await expect(page).toHaveURL(new RegExp(`/songguessr/room/${roomId}$`));
  await expect(page.getByText(`${userName}的房间`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "音量设置" })).toBeVisible();
  await page.getByRole("button", { name: "音量设置" }).click();
  await expect(page.getByRole("slider", { name: "播放音量" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /网易云账号/ }).click();
  await expect(page.getByRole("button", { name: "扫码", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "手机", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "邮箱", exact: true })).toBeVisible();
  await expect(page.getByText(/服务器不会保存账号、手机号、邮箱或密码/)).toBeVisible();

  await page.getByRole("button", { name: "离开房间" }).click();
  await expect(page).toHaveURL(/\/songguessr$/);
  await expect(page.getByText(/会话.*失效|会话令牌无效/)).toHaveCount(0);
});

test("private Song Guessr rooms stay listed and direct links request the password", async ({ browser, page }) => {
  const unique = Date.now().toString(36);
  const roomName = `私密音乐房 ${unique}`;
  const password = `pw-${unique}`;

  await page.goto("/songguessr");
  await page.getByPlaceholder("用户名").fill(`私密房主${unique}`);
  await page.getByRole("button", { name: "创建房间" }).click();
  const createDialog = page.getByRole("dialog");
  await createDialog.getByPlaceholder("输入房间名称").fill(roomName);
  await createDialog.locator('button[role="switch"]').first().click();
  await createDialog.getByPlaceholder("设置房间密码").fill(password);
  await createDialog.getByRole("button", { name: "创建", exact: true }).click();
  const roomId = page.url().split("/").at(-1)!;

  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto("http://localhost:5173/songguessr");
  await guestPage.getByPlaceholder("用户名").fill(`私密访客${unique}`);
  await expect(guestPage.getByText(roomName, { exact: true })).toBeVisible();
  await guestPage.goto(`http://localhost:5173/songguessr/room/${roomId}`);
  await expect(guestPage.getByRole("heading", { name: "输入房间密码" })).toBeVisible();
  await guestPage.getByPlaceholder("请输入密码").fill(password);
  await guestPage.getByRole("button", { name: "加入房间" }).click();
  await expect(guestPage).toHaveURL(new RegExp(`/songguessr/room/${roomId}$`));
  await expect(guestPage.getByText(roomName, { exact: true })).toBeVisible();
  await guestContext.close();
});

test("Song Guessr test room exposes bots and guests can switch to spectator", async ({ browser, page }) => {
  const unique = Date.now().toString(36);
  await page.goto("/songguessr/room/Oblivionis");
  await expect(page.getByRole("heading", { name: "设置用户名" })).toBeVisible();
  await page.getByPlaceholder("用户名").fill(`测试房主${unique}`);
  await page.getByRole("button", { name: "进入房间" }).click();
  await expect(page.getByText("测试控制器", { exact: true })).toBeVisible();

  const removeBot = page.getByRole("button", { name: "移除一个测试人机" });
  for (let index = 0; index < 16 && await removeBot.isEnabled(); index += 1) {
    await removeBot.click();
  }
  await page.getByRole("button", { name: "添加一个测试人机" }).click();
  await expect(page.getByLabel("测试人机", { exact: true })).toHaveCount(1);

  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto("http://localhost:5173/songguessr/room/Oblivionis");
  await guestPage.getByPlaceholder("用户名").fill(`旁观访客${unique}`);
  await guestPage.getByRole("button", { name: "进入房间" }).click();
  await guestPage.getByRole("button", { name: "加入旁观" }).click();
  await expect(guestPage.getByRole("button", { name: "取消旁观" })).toBeVisible();
  await expect(page.getByText(`旁观访客${unique}`, { exact: true }).first()).toBeVisible();
  await guestContext.close();
});
