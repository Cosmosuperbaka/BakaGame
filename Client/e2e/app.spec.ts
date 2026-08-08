import { expect, test } from "@playwright/test";

test("landing page exposes one playable game and keeps placeholders disabled", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Baka Game" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Who is Faker" })).toBeVisible();
  await expect(page.locator('[aria-disabled="true"]')).toHaveCount(2);

  await page.getByRole("button", { name: "Who is Faker" }).click();
  await expect(page).toHaveURL(/\/whoisfaker$/);
  await expect(page.getByRole("heading", { name: "Who is Faker" })).toBeVisible();
});

test("removed and unknown routes fall back to a live page", async ({ page }) => {
  for (const path of ["/songguessr", "/animecharguessr", "/unknown"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Baka Game" })).toBeVisible();
  }

  await page.goto("/whoisfaker/unknown");
  await expect(page).toHaveURL(/\/whoisfaker$/);
  await expect(page.getByRole("heading", { name: "Who is Faker" })).toBeVisible();
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
