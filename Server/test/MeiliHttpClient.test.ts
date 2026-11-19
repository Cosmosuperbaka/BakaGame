import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { Meilisearch, MeilisearchApiError } from "meilisearch";
import { isMeiliApiError, meiliHttpClient } from "../src/infrastructure/MeiliHttpClient";

// 假 Meilisearch：只实现测试需要的端点。
// - GET /health           → 200 {"status":"available"}
// - GET /empty            → 200 空响应体
// - GET /indexes/slow     → 600ms 后响应（用于超时 abort）
// - GET /html502 / /badjson / /huge → 非 JSON 的 502、非法 JSON 的 200、超限响应体
// - 其余（如 /indexes/missing）→ 404 index_not_found
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "available" }));
      return;
    }
    if (url === "/empty") {
      res.writeHead(200);
      res.end();
      return;
    }
    if (url === "/html502") {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<html><body>Bad Gateway</body></html>");
      return;
    }
    if (url === "/badjson") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("<not-json>");
      return;
    }
    if (url === "/huge") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`"${"x".repeat(9 * 1024 * 1024)}"`);
      return;
    }
    if (url.startsWith("/indexes/slow")) {
      const timer = setTimeout(() => {
        if (!res.writableEnded && !res.socket?.destroyed) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ uid: "slow" }));
        }
      }, 600);
      res.socket?.once("close", () => clearTimeout(timer));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        message: "Index `missing` not found.",
        code: "index_not_found",
        type: "invalid_request",
        link: "https://docs.meilisearch.com/errors#index_not_found",
      })
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server.closeAllConnections?.();
  server.close();
});

describe("meiliHttpClient", () => {
  test("成功响应返回解析后的 JSON", async () => {
    const result = await meiliHttpClient(new URL(`${base}/health`), { method: "GET" });
    expect(result).toEqual({ status: "available" });
  });

  test("空响应体返回 undefined", async () => {
    const result = await meiliHttpClient(new URL(`${base}/empty`), { method: "GET" });
    expect(result).toBeUndefined();
  });

  test("非 2xx 抛出 MeilisearchApiError（直接调用时未被 SDK 包装）", async () => {
    let caught: unknown;
    try {
      await meiliHttpClient(new URL(`${base}/indexes/missing`), { method: "GET" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MeilisearchApiError);
    expect(isMeiliApiError(caught, "index_not_found")).toBe(true);
  });

  test("502 返回 HTML 时拒绝为 MeilisearchApiError，不触发未捕获异常", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      let caught: unknown;
      try {
        await meiliHttpClient(new URL(`${base}/html502`), { method: "GET" });
      } catch (error) {
        caught = error;
      }
      await Bun.sleep(20);
      expect(caught).toBeInstanceOf(MeilisearchApiError);
      expect((caught as MeilisearchApiError).message).toContain("502");
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  test("200 返回非法 JSON 时拒绝为请求错误，不触发未捕获异常", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      let caught: unknown;
      try {
        await meiliHttpClient(new URL(`${base}/badjson`), { method: "GET" });
      } catch (error) {
        caught = error;
      }
      await Bun.sleep(20);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("非 JSON");
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  test("响应体超过上限时中止并拒绝", async () => {
    await expect(meiliHttpClient(new URL(`${base}/huge`), { method: "GET" })).rejects.toThrow(
      "过大"
    );
  });

  test("已中止的 signal 立即拒绝，不发起请求", async () => {
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    let caught: unknown;
    try {
      await meiliHttpClient(new URL(`${base}/health`), {
        method: "GET",
        signal: controller.signal,
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe("pre-aborted");
  });
});

describe("经 SDK 的真实链路", () => {
  test("SDK 正常请求返回数据", async () => {
    const client = new Meilisearch({ host: base, httpClient: meiliHttpClient, timeout: 2_000 });
    const result = await client.health();
    expect(result).toEqual({ status: "available" });
  });

  test("fetchInfo 404 经 SDK 包装后仍能识别 index_not_found（ensureIndex 依赖此判定）", async () => {
    const client = new Meilisearch({ host: base, httpClient: meiliHttpClient, timeout: 2_000 });
    let caught: unknown;
    try {
      await client.index("missing").fetchInfo();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    // 关键回归：自定义 httpClient 抛出的 MeilisearchApiError 会被 SDK 包装为
    // MeilisearchRequestError，isMeiliApiError 必须穿透 cause 链识别出 index_not_found。
    expect(isMeiliApiError(caught, "index_not_found")).toBe(true);
    expect(isMeiliApiError(caught, "document_not_found")).toBe(false);
  });

  test("超时触发 abort，请求不悬挂且后续请求正常", async () => {
    const client = new Meilisearch({ host: base, httpClient: meiliHttpClient, timeout: 150 });
    const startedAt = performance.now();
    let caught: unknown;
    try {
      await client.index("slow").fetchInfo();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    // SDK 外层错误恒为 MeilisearchRequestError；超时识别体现在 cause：
    // Object.is(reject 值, timeoutSymbol) 为真时 cause 为 MeilisearchRequestTimeOutError，
    // 否则退化为普通请求失败（cause 为原始错误）。
    expect((caught as Error).name).toBe("MeilisearchRequestError");
    expect((caught as { cause?: Error }).cause?.name).toBe("MeilisearchRequestTimeOutError");
    // 假服务器的慢响应为 600ms；若 abort 未生效将等到 600ms+，这里断言远小于该值以证明超时生效。
    expect(performance.now() - startedAt).toBeLessThan(500);
    // 超时后连接池未被污染：后续请求正常返回。
    const result = await client.health();
    expect(result).toEqual({ status: "available" });
  });

  test("连接失败向上抛（经 SDK 包装后仍为请求错误）", async () => {
    const client = new Meilisearch({
      host: "http://127.0.0.1:1",
      httpClient: meiliHttpClient,
      timeout: 2_000,
    });
    let caught: unknown;
    try {
      await client.health();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
  });
});
