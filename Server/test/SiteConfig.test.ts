import { Elysia } from "elysia";
import { expect, test } from "bun:test";
import { siteConfigRoutes } from "../src/transport/routes/SiteConfig";

const CONFIG_URL = "https://game.example.com/api/site/config";

test("未装配可见性依赖时全部开放，且响应不缓存", async () => {
  const app = new Elysia().use(siteConfigRoutes());
  const response = await app.handle(new Request(CONFIG_URL));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ceeRankedEntry: true });
  // 开关是运维止血手段：被中间层缓存住就等于要等缓存过期才能生效。
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("旋钮关掉后回报入口关闭，且每次都现读而不是装配时定死", async () => {
  let enabled = true;
  const app = new Elysia().use(siteConfigRoutes({ features: () => ({ ceeRankedEntry: enabled }) }));

  const open = await app.handle(new Request(CONFIG_URL));
  expect(await open.json()).toEqual({ ceeRankedEntry: true });

  enabled = false;
  // 后台改完不必等重启或重新装配：下一次读就是新值。
  const closed = await app.handle(new Request(CONFIG_URL));
  expect(await closed.json()).toEqual({ ceeRankedEntry: false });
});
