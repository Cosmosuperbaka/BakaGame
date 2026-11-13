import { expect, test } from "bun:test";

import {
  compileRouteTemplates,
  httpOperationAction,
  UNROUTED_HTTP_ACTION,
} from "../src/transport/HttpOperation";

/**
 * 操作名的维度只允许来自已注册路由模板：路径参数值、扫描器的随机路径都不能进标签。
 */
const templates = compileRouteTemplates([
  { method: "GET", path: "/api/users/:id" },
  { method: "POST", path: "/api/items" },
  { method: "WS", path: "/api/ws" },
  { method: "ALL", path: "/api/proxy/*" },
]);

test("路径参数段按模板记名，真实参数值不进操作名", () => {
  expect(httpOperationAction(templates, "GET", "/api/users/u-1")).toBe("HTTP GET /api/users/:id");
  expect(httpOperationAction(templates, "GET", "/api/users/u-2")).toBe("HTTP GET /api/users/:id");
});

test("HEAD 复用 GET 模板，WS 升级在 HTTP 层按 GET 归类", () => {
  expect(httpOperationAction(templates, "HEAD", "/api/users/u-1")).toBe(
    "HTTP HEAD /api/users/:id"
  );
  expect(httpOperationAction(templates, "GET", "/api/ws")).toBe("HTTP GET /api/ws");
});

test("通配段吞掉其余路径，ALL 模板对标准方法都命中", () => {
  expect(httpOperationAction(templates, "DELETE", "/api/proxy/a/b/c")).toBe(
    "HTTP DELETE /api/proxy/*"
  );
  expect(httpOperationAction(templates, "OPTIONS", "/api/proxy/x")).toBe(
    "HTTP OPTIONS /api/proxy/*"
  );
});

test("方法不匹配、段数不符与非标准方法一律落固定桶", () => {
  expect(httpOperationAction(templates, "GET", "/api/items")).toBe(UNROUTED_HTTP_ACTION);
  expect(httpOperationAction(templates, "GET", "/api/users")).toBe(UNROUTED_HTTP_ACTION);
  expect(httpOperationAction(templates, "GET", "/api/users/u-1/extra")).toBe(UNROUTED_HTTP_ACTION);
  expect(httpOperationAction(templates, "FOO", "/api/proxy/x")).toBe(UNROUTED_HTTP_ACTION);
});

test("方法名在编译时统一大写，没有路由时恒为固定桶", () => {
  const compiled = compileRouteTemplates([{ method: "get", path: "/health" }]);
  expect(compiled[0]).toEqual({ method: "GET", path: "/health", segments: ["health"] });
  expect(httpOperationAction([], "GET", "/health")).toBe(UNROUTED_HTTP_ACTION);
});
