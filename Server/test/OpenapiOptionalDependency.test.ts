import { expect, test } from "bun:test";
import path from "node:path";
import { Elysia } from "elysia";
import { createOpenapiPlugin } from "../src/transport/Openapi";

const docsStatus = async (plugin: ReturnType<typeof createOpenapiPlugin>) => {
  const app = new Elysia().use(plugin);
  return (await app.handle(new Request("http://localhost/openapi/json"))).status;
};

test("文档页关闭时不取文档插件包", async () => {
  let loads = 0;
  const plugin = createOpenapiPlugin({
    serverUrl: "http://localhost",
    enabled: false,
    load: () => {
      loads += 1;
      throw new Error("关闭时不该加载");
    },
  });
  expect(loads).toBe(0);
  expect(await docsStatus(plugin)).toBe(404);
});

test("文档页开启而运行环境里没有这个包：告知后按关闭处理，不抛出", async () => {
  const missing = new Error("Cannot find module '@elysiajs/openapi'");
  const reported: unknown[] = [];
  const plugin = createOpenapiPlugin({
    serverUrl: "http://localhost",
    enabled: true,
    onUnavailable: (error) => reported.push(error),
    load: () => {
      throw missing;
    },
  });
  expect(reported).toEqual([missing]);
  expect(await docsStatus(plugin)).toBe(404);
});

test("文档页开启且包在：照常挂出文档", async () => {
  const reported: unknown[] = [];
  const plugin = createOpenapiPlugin({
    serverUrl: "http://localhost",
    enabled: true,
    onUnavailable: (error) => reported.push(error),
  });
  expect(reported).toEqual([]);
  expect(await docsStatus(plugin)).toBe(200);
});

test("文档插件包不在模块顶层按值引入", async () => {
  // 顶层按值引入会让没有这个包的运行环境在加载模块时崩掉，上面两条分支都走不到。
  const source = await Bun.file(
    path.resolve(import.meta.dir, "../src/transport/Openapi.ts")
  ).text();
  const valueImports = source
    .split(/\r?\n/)
    .filter((line) => /^import\s+(?!type\b).*["']@elysiajs\/openapi["']/.test(line));
  expect(valueImports).toEqual([]);
});
