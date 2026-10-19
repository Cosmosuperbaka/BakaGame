import { expect, test } from "bun:test";
import { ClientChannel, InMemoryClientChannelStore } from "../src/infrastructure/ClientChannel";
import { clientChannelRoutes } from "../src/transport/routes/ClientChannelRoutes";

/** 桌面一档给最低版本、移动一档留空：正好覆盖「两端各自门槛」的读回口径。 */
const appAt = (desktopMinimum: string) =>
  clientChannelRoutes(
    new ClientChannel({
      store: new InMemoryClientChannelStore(),
      minimumVersion: (clientType) => (clientType === "desktop" ? desktopMinimum : ""),
    })
  );

async function check(app: ReturnType<typeof appAt>, search: string) {
  const response = await app.handle(
    new Request(`http://localhost/api/client/update-check?${search}`)
  );
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.json().catch(() => null),
  };
}

test("低于最低版本回 outdated，并把门槛一起回显给提醒用", async () => {
  expect(await check(appAt("2.0.0"), "clientType=desktop&clientVersion=1.9.0")).toMatchObject({
    status: 200,
    body: { minimumVersion: "2.0.0", outdated: true },
  });
});

test("等于最低版本即算够新：门槛是「不低于」不是「大于」", async () => {
  const result = await check(appAt("2.0.0"), "clientType=desktop&clientVersion=2.0.0");
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ outdated: false });
});

test("没配最低版本不报错：恒为够新，门槛回空串", async () => {
  const result = await check(appAt(""), "clientType=desktop&clientVersion=0.1.0");
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ minimumVersion: "", outdated: false });
});

test("两端门槛各算各的：桌面的旧不代表移动的旧", async () => {
  const result = await check(appAt("2.0.0"), "clientType=mobile&clientVersion=1.0.0");
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ minimumVersion: "", outdated: false });
});

test("提醒读回的门槛不许被边缘缓存：抬档要立刻生效", async () => {
  const result = await check(appAt("2.0.0"), "clientType=desktop&clientVersion=2.0.0");
  expect(result.cacheControl).toBe("no-store");
});

test("客户端类型不认识时拒绝，而不是当成够新放过", async () => {
  const result = await check(appAt("2.0.0"), "clientType=web&clientVersion=1.0.0");
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(result.status).toBeLessThan(500);
});

test("缺版本号时拒绝：没有版本就没有提醒的依据", async () => {
  const result = await check(appAt("2.0.0"), "clientType=desktop");
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(result.status).toBeLessThan(500);
});
