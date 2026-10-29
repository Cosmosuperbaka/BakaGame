import { expect, test } from "bun:test";
import { resolveRequestTraceId } from "../src/transport/RequestTraceId";
import { formatOtlpTraceId } from "../src/infrastructure/OtlpExporter";

const W3C = "4bf92f3577b34da6a3ce929d0e0e4736";
const SENTRY = "771a43a4192642f0b136d5159a501700";
const at = (headers: Record<string, string>) => resolveRequestTraceId(new Headers(headers));

test("调用方显式给的追踪号优先，其次沿用上游 W3C 与 Sentry trace", () => {
  expect(at({ "x-trace-id": "mine", traceparent: `00-${W3C}-00f067aa0ba902b7-01` })).toBe("mine");
  expect(at({ "x-request-id": "req-1", "sentry-trace": `${SENTRY}-a1b2c3d4e5f60718` })).toBe(
    "req-1"
  );
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
