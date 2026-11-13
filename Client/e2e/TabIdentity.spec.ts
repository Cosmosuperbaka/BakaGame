import type { BrowserContext, Locator, Page } from "@playwright/test";
import { closeIsolatedContext, expect, test } from "./fixtures/Isolation";

const TAB_TOKEN_KEY = "bakagame:tab_token";
const SEAT_INVALID = /原座位已失效|会话已失效|会话令牌无效/;

const tabToken = (page: Page) => page.evaluate((key) => sessionStorage.getItem(key), TAB_TOKEN_KEY);

const waitForTabToken = async (page: Page): Promise<string> => {
  await expect.poll(() => tabToken(page)).not.toBeNull();
  return (await tabToken(page))!;
};

const faker = async (page: Page, name: string) => {
  await page.goto("/whoisfaker");
  await page.getByPlaceholder("用户名").fill(name);
};

const createFakerRoom = async (page: Page, roomName: string, hostName: string) => {
  await faker(page, hostName);
  await page.getByRole("button", { name: "创建房间" }).click();
  await page.getByPlaceholder("输入房间名称").fill(roomName);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page).toHaveURL(/\/whoisfaker\/room\/\d{4}$/);
  return page.url().split("/").at(-1)!;
};

const joinFromLobby = async (page: Page, roomName: string) => {
  await page.getByRole("button", { name: new RegExp(roomName) }).click();
  await expect(page).toHaveURL(/\/whoisfaker\/room\/\d{4}$/);
};

const bubble = (page: Page, text: string): Locator =>
  page.getByTestId("chat-message-bubble").filter({ hasText: text });

const say = async (page: Page, text: string) => {
  await page.getByPlaceholder("请输入文本").fill(text);
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(bubble(page, text)).toBeVisible();
};

/** 自己的消息贴右、别人的贴左：按聊天区的真实几何判定，不绑定样式类名。 */
const isOwnMessage = async (page: Page, text: string): Promise<boolean> => {
  const message = await bubble(page, text).boundingBox();
  const log = await page.getByRole("log").first().boundingBox();
  if (!message || !log) throw new Error("聊天气泡或聊天区不可见");
  const toRight = log.x + log.width - (message.x + message.width);
  return toRight < message.x - log.x;
};

/** 只数玩家栏：聊天气泡上方也写着发言人的名字。 */
const players = (page: Page, name: string) =>
  page.locator('[data-room-part="player"]').getByText(name, { exact: true });

/** 两张独立的标签页（两个浏览器上下文）进同一间房。 */
const twoPlayersInRoom = async (
  page: Page,
  isolatedContext: () => Promise<BrowserContext>,
  unique: string
) => {
  const roomName = `身份房${unique}`;
  const hostName = `房主${unique}`;
  const guestName = `访客${unique}`;
  await page.setViewportSize({ width: 1440, height: 900 });
  const roomId = await createFakerRoom(page, roomName, hostName);

  const guestContext = await isolatedContext();
  const guest = await guestContext.newPage();
  await guest.setViewportSize({ width: 1440, height: 900 });
  await faker(guest, guestName);
  await joinFromLobby(guest, roomName);
  await expect(players(page, guestName)).toBeVisible();
  return { roomId, roomName, hostName, guestName, guest, guestContext };
};

test("任意页面一进入就由全局连接分配身份，令牌不进握手地址", async ({ page }) => {
  const sockets: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));

  await page.goto("/cee");
  const token = await waitForTabToken(page);
  await page.waitForLoadState("networkidle");

  await page.goto("/");
  // 同一张标签页里换页、整页跳转都不换身份。
  expect(await waitForTabToken(page)).toBe(token);
  await page.waitForLoadState("networkidle");
  await page.goto("/whoisfaker");
  expect(await waitForTabToken(page)).toBe(token);
  await page.waitForLoadState("networkidle");

  expect(sockets.length).toBeGreaterThan(0);
  for (const url of sockets) expect(url).not.toContain(token);
});

test("退出房间再进：自己的历史消息仍显示为自己发的", async ({ isolatedContext, page }) => {
  const unique = Date.now().toString(36);
  const { roomId, guest, guestContext, guestName, roomName } = await twoPlayersInRoom(
    page,
    isolatedContext,
    unique
  );
  const history = `退房前说的话${unique}`;
  await say(guest, history);
  // 刚发出的气泡还在落位动画里，按轮询取稳定后的几何位置。
  await expect.poll(() => isOwnMessage(guest, history)).toBe(true);

  await guest.getByRole("button", { name: "离开房间" }).click();
  await expect(guest).toHaveURL(/\/whoisfaker$/);
  await expect(players(page, guestName)).toHaveCount(0);

  await joinFromLobby(guest, roomName);
  await expect(guest).toHaveURL(new RegExp(`/room/${roomId}$`));
  await expect(bubble(guest, history)).toBeVisible();
  await expect.poll(() => isOwnMessage(guest, history)).toBe(true);
  // 别人眼里还是同一个人发的，不是自己。
  expect(await isOwnMessage(page, history)).toBe(false);

  await closeIsolatedContext(guestContext);
});

test("房内刷新：回到原座位，历史消息归属不变，不提示会话失效", async ({
  isolatedContext,
  page,
}) => {
  const unique = Date.now().toString(36);
  const { guest, guestContext, guestName } = await twoPlayersInRoom(page, isolatedContext, unique);
  const before = await waitForTabToken(guest);
  const history = `刷新前说的话${unique}`;
  await say(guest, history);

  await guest.reload();

  await expect(bubble(guest, history)).toBeVisible();
  await expect.poll(() => isOwnMessage(guest, history)).toBe(true);
  await expect(guest.getByText(SEAT_INVALID)).toHaveCount(0);
  expect(await tabToken(guest)).toBe(before);
  // 房主那边始终只有一个访客，没有多出第二个席位。
  await expect(players(page, guestName)).toHaveCount(1);

  await closeIsolatedContext(guestContext);
});

test("0 分旁观者刷新：留在旁观席，不提示会话失效", async ({ isolatedContext, page }) => {
  const unique = Date.now().toString(36);
  const { guest, guestContext, guestName } = await twoPlayersInRoom(page, isolatedContext, unique);
  await guest.getByRole("button", { name: "加入旁观" }).click();
  await expect(guest.getByRole("button", { name: "取消旁观" })).toBeVisible();

  await guest.reload();

  await expect(guest.getByRole("button", { name: "取消旁观" })).toBeVisible();
  await expect(guest.getByText(SEAT_INVALID)).toHaveCount(0);
  await expect(players(page, guestName)).toHaveCount(1);

  await closeIsolatedContext(guestContext);
});

test("复制标签页换新身份：不顶掉原标签页的座位", async ({ isolatedContext, page }) => {
  const unique = Date.now().toString(36);
  const { guest, guestContext } = await twoPlayersInRoom(page, isolatedContext, unique);
  const original = await waitForTabToken(guest);
  const history = `复制前说的话${unique}`;
  await say(guest, history);

  // window.open 与「复制标签页」一样会继承 sessionStorage。
  const [copied] = await Promise.all([
    guestContext.waitForEvent("page"),
    guest.evaluate(() => void window.open("/whoisfaker", "_blank")),
  ]);
  await expect.poll(() => tabToken(copied)).not.toBeNull();
  await expect.poll(() => tabToken(copied)).not.toBe(original);
  expect(
    await copied.evaluate(() =>
      Object.keys(sessionStorage).filter((key) => key.startsWith("whoisfaker_session_"))
    )
  ).toEqual([]);

  // 原标签页不受影响：身份没变，还能继续发言，也没有被替代的提示。
  expect(await tabToken(guest)).toBe(original);
  await say(guest, `复制后说的话${unique}`);
  await expect(guest.getByText("您的连接已被新标签页替代")).toHaveCount(0);

  await copied.close();
  await closeIsolatedContext(guestContext);
});

test("本地标记漏网时由服务端判定：探测到原标签页还开着，复制品换新身份", async ({
  isolatedContext,
  page,
}) => {
  const unique = Date.now().toString(36);
  const { guest, guestContext } = await twoPlayersInRoom(page, isolatedContext, unique);
  const original = await waitForTabToken(guest);

  // 抹掉继承来的标记，让页面自己的同步判定失效，身份只能靠服务端探测原标签页来裁决。
  await guestContext.addInitScript(() => {
    if (window.opener) sessionStorage.removeItem("bakagame:tab_open");
  });
  const [copied] = await Promise.all([
    guestContext.waitForEvent("page"),
    guest.evaluate(() => void window.open("/whoisfaker", "_blank")),
  ]);

  await expect.poll(() => tabToken(copied)).not.toBe(original);
  await expect.poll(() => tabToken(copied)).not.toBeNull();
  await expect
    .poll(() =>
      copied.evaluate(() =>
        Object.keys(sessionStorage).filter((key) => key.startsWith("whoisfaker_session_"))
      )
    )
    .toEqual([]);
  expect(await tabToken(guest)).toBe(original);
  await say(guest, `判定后说的话${unique}`);

  await copied.close();
  await closeIsolatedContext(guestContext);
});

test("不同标签页是不同的人：同房各占一席，消息互不算自己", async ({ isolatedContext, page }) => {
  const unique = Date.now().toString(36);
  const { guest, guestContext } = await twoPlayersInRoom(page, isolatedContext, unique);
  const fromHost = `房主说的话${unique}`;
  await say(page, fromHost);

  await expect(bubble(guest, fromHost)).toBeVisible();
  expect(await isOwnMessage(page, fromHost)).toBe(true);
  expect(await isOwnMessage(guest, fromHost)).toBe(false);
  expect(await waitForTabToken(page)).not.toBe(await waitForTabToken(guest));

  await closeIsolatedContext(guestContext);
});
