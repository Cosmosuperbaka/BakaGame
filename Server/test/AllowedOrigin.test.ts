import { expect, test } from "bun:test";

import { isAllowedOrigin } from "../src/transport/App";

/**
 * 来源白名单是 HTTP CORS 与 WebSocket 握手共用的同一道闸门（见 `App.ts` 的
 * `rejectDisallowedOrigin` 与 `cors({ origin })`）。
 *
 * 这里重点锁住两条口径：
 * 1. 内嵌安卓壳的固定 origin `https://localhost` 恒可信 —— 壳把前端产物打进 WebView，
 *    接口在公网域名上，跨域是常态，不放行就等于壳内全部接口不可用。
 * 2. 这个放宽**只针对 https**：`http://localhost:端口` 是任意本机进程（含恶意页面）
 *    都能提供的来源，必须继续走白名单判定，不能顺手一起放行。
 */

const PROD = "https://game.baka.website";

test("内嵌壳来源 https://localhost 在生产白名单下仍被信任", () => {
  expect(isAllowedOrigin("https://localhost", PROD)).toBe(true);
  // 白名单缺省（本地开发）时同样可信
  expect(isAllowedOrigin("https://localhost", undefined)).toBe(true);
});

test("http://localhost 不会因为壳来源被顺带放行", () => {
  expect(isAllowedOrigin("http://localhost:5173", PROD)).toBe(false);
  expect(isAllowedOrigin("http://localhost:4850", PROD)).toBe(false);
});

test("配置的前端来源可用，其他公网来源被拒", () => {
  expect(isAllowedOrigin(PROD, PROD)).toBe(true);
  expect(isAllowedOrigin("https://evil.example.com", PROD)).toBe(false);
});

test("缺 Origin 的请求放行（原生客户端与健康检查不带 Origin）", () => {
  expect(isAllowedOrigin(null, PROD)).toBe(true);
  expect(isAllowedOrigin(undefined, PROD)).toBe(true);
});

test("白名单支持逗号分隔多来源", () => {
  const list = `${PROD},https://alt.example.com`;
  expect(isAllowedOrigin("https://alt.example.com", list)).toBe(true);
});
