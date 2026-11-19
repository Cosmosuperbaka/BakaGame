import { expect, test } from "bun:test";

import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import type { AppEnv } from "../src/config/Env";
import { EventLogger } from "../src/infrastructure/EventLogger";
import { StatusHistoryStore } from "../src/infrastructure/StatusHistoryStore";
import { StatusSampleStore } from "../src/infrastructure/StatusSampleStore";
import { createDocumentationApp } from "../src/scripts/ExportOpenapi";
import { createTestApp } from "./AppFixtures";

const env: AppEnv = {
  clientUrl: "http://localhost:5173",
  serverUrl: "http://127.0.0.1",
  serverListenHost: "127.0.0.1",
  serverPort: 0,
  bangumiApiUrl: "https://api.bgm.tv",
  bangumiImageUrl: "",
};

/** 实时升级路由不属于 HTTP 契约；OPTIONS 是跨域插件为全站挂的预检路由，文档装配没有跨域插件。 */
const NOT_HTTP_CONTRACT = new Set(["WS", "OPTIONS"]);

const httpRoutesOf = (app: { routes: readonly { method: string; path: string }[] }) =>
  new Set(
    app.routes
      .filter((route) => !NOT_HTTP_CONTRACT.has(route.method))
      .map((route) => `${route.method} ${route.path}`)
  );

test("接口文档装配与运行时共用同一份 HTTP 路由组合：路由集合逐条一致", () => {
  const logger = new EventLogger(() => undefined);
  const { app } = createTestApp({
    env,
    logger,
    games: { faker: new WhoIsFakerService({ eventLogger: logger }) },
    // 运行时按依赖有无才注册的状态接口：与文档装配一样传入空账本。
    statusHistory: new StatusHistoryStore({ environment: "test" }),
    statusSamples: new StatusSampleStore({ environment: "test" }),
    statusEvents: {
      list: async () => ({ items: [], total: 0 }),
      get: async () => null,
      create: () => Promise.reject(new Error("unused")),
      update: () => Promise.reject(new Error("unused")),
      remove: () => Promise.reject(new Error("unused")),
    },
  });
  const documented = httpRoutesOf(createDocumentationApp());
  const runtime = httpRoutesOf(app);
  // 文档页自己的路由（Swagger UI 与 JSON）两边都有，一并比较。
  // 任一边多出路由都报红：运行时新增 HTTP 路由而文档装配没跟上，契约产物就会缺端点。
  expect([...runtime].filter((route) => !documented.has(route))).toEqual([]);
  expect([...documented].filter((route) => !runtime.has(route))).toEqual([]);
});
