import { expect, test } from "bun:test";
import { resolveRequestTraceId } from "../src/transport/RequestTraceId";
import { acceptTraceId } from "../src/infrastructure/logging/TraceId";
import { formatOtlpTraceId } from "../src/infrastructure/logging/OtelEncoding";

const W3C = "4bf92f3577b34da6a3ce929d0e0e4736";
const SENTRY = "771a43a4192642f0b136d5159a501700";
const at = (headers: Record<string, string>) => resolveRequestTraceId(new Headers(headers));

test("调用方显式给的追踪号优先，其次沿用上游 W3C 与 Sentry trace", () => {
  const mine = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  expect(at({ "x-trace-id": mine, traceparent: `00-${W3C}-00f067aa0ba902b7-01` })).toBe(mine);
  expect(at({ "x-request-id": W3C, "sentry-trace": `${SENTRY}-a1b2c3d4e5f60718` })).toBe(W3C);
  expect(
    at({
      traceparent: `00-${W3C}-00f067aa0ba902b7-01`,
      "sentry-trace": `${SENTRY}-a1b2c3d4e5f60718-1`,
    })
  ).toBe(W3C);
  expect(at({ "sentry-trace": `${SENTRY}-a1b2c3d4e5f60718-1` })).toBe(SENTRY);
});

test("沿用的上游 trace-id 原样进入 OTLP，导出的 span 与上游落在同一条 trace", () => {
  expect(formatOtlpTraceId(at({ "sentry-trace": `${SENTRY}-a1b2c3d4e5f60718` }))).toBe(SENTRY);
});

test("格式不对或全零的上游头不采用，退回自造", () => {
  const generated = /^[\da-f]{8}-[\da-f]{4}-/;
  expect(at({ traceparent: `00-${"0".repeat(32)}-00f067aa0ba902b7-01` })).toMatch(generated);
  expect(at({ traceparent: "garbage" })).toMatch(generated);
  expect(at({ "sentry-trace": "short-id" })).toMatch(generated);
  expect(at({})).toMatch(generated);
});

test("不可信的 x-trace-id / x-request-id 只认 UUID 或 32 位十六进制，其余丢弃并自造", () => {
  const generated = /^[\da-f]{8}-[\da-f]{4}-/;
  for (const hostile of [
    "hello-world",
    "a".repeat(200),
    "../../etc",
    "id with space",
    "<script>",
  ]) {
    expect(at({ "x-trace-id": hostile })).toMatch(generated);
    expect(at({ "x-request-id": hostile })).toMatch(generated);
  }
  // 丢弃坏的 x-trace-id 后仍可沿用后面合法的来源。
  expect(at({ "x-trace-id": "hello-world", "sentry-trace": `${SENTRY}-a1b2c3d4e5f60718` })).toBe(
    SENTRY
  );
  // 大小写归一，保证同一个号在日志、OTLP 与 Sentry 里是同一个字符串。
  expect(at({ "x-trace-id": W3C.toUpperCase() })).toBe(W3C);
});

test("acceptTraceId 供 WS 信封复用同一口径", () => {
  expect(acceptTraceId(W3C)).toBe(W3C);
  expect(acceptTraceId("0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D")).toBe(
    "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
  );
  expect(acceptTraceId("hello-world")).toBeUndefined();
  expect(acceptTraceId(undefined)).toBeUndefined();
  expect(acceptTraceId("0".repeat(32))).toBeUndefined();
});

test("无法规整成 32 位十六进制的追踪号进 OTLP 时取摘要而不是补零，不同的号不会撞成同一条 trace", () => {
  const first = formatOtlpTraceId("hello-world");
  const second = formatOtlpTraceId("hello-there");
  expect(first).toMatch(/^[\da-f]{32}$/);
  expect(second).toMatch(/^[\da-f]{32}$/);
  expect(first).not.toBe(second);
  // 同一个号永远得到同一个结果，日志与 span 才对得上。
  expect(formatOtlpTraceId("hello-world")).toBe(first);
  // 合法形状不受影响：带连字符的 UUID 去掉连字符即可。
  expect(formatOtlpTraceId("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")).toBe(
    "0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d"
  );
});
