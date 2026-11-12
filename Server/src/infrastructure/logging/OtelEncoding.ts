import { createHash } from "node:crypto";

import { isRecord } from "../../shared/Json";

/**
 * OTLP/JSON 的编码原语：日志本地文件、OTLP 日志导出与 span 导出共用这一份，
 * 同一个值在三个出口里编码一致（整数不会在某一路退化成字符串）。
 */
const MAX_ANY_VALUE_DEPTH = 8;

export type OtelAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtelAnyValue[] } }
  | { kvlistValue: { values: Array<{ key: string; value: OtelAnyValue }> } };

export const formatOtlpTraceId = (traceId?: string): string => {
  if (!traceId) {
    return crypto.randomUUID().replace(/-/g, "").toLowerCase();
  }
  // 合法形状（32 位十六进制，或去掉连字符后恰为 32 位的 UUID）原样沿用，与上游 trace 对得上。
  const compact = traceId.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(compact)) return compact;
  // 其余取摘要：补零或截断会让不同的号撞成同一条 trace，摘要至少保证「不同输入、不同结果」。
  return createHash("sha256").update(traceId).digest("hex").slice(0, 32);
};

export const formatOtlpSpanId = (spanId?: string): string => {
  if (!spanId) {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16).toLowerCase();
  }
  const clean = spanId.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  if (clean.length === 16) return clean;
  if (clean.length > 16) return clean.slice(0, 16);
  return clean.padEnd(16, "0");
};

export const toUnixNanoString = (timeMs: number): string => {
  if (!Number.isFinite(timeMs) || timeMs < 0) {
    return String(BigInt(Date.now()) * 1_000_000n);
  }
  const ms = Math.trunc(timeMs);
  const nanos = Math.round((timeMs - ms) * 1_000_000);
  return String(BigInt(ms) * 1_000_000n + BigInt(nanos));
};

/**
 * OTLP/JSON 的 AnyValue 编码：整数按规范写成十进制字符串，对象与数组保留结构。
 * 超过深度上限或循环引用时用标记字符串收口，绝不让序列化抛进业务调用方。
 */
const toAnyValue = (value: unknown, depth = 0): OtelAnyValue | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { stringValue: String(value) };
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "bigint") return { intValue: String(value) };
  if (typeof value === "function" || typeof value === "symbol")
    return { stringValue: String(value) };
  if (depth >= MAX_ANY_VALUE_DEPTH) return { stringValue: "[MAX_DEPTH_EXCEEDED]" };
  if (value instanceof Date) return { stringValue: value.toISOString() };
  if (value instanceof Error)
    return toAnyValue(
      {
        errorName: value.name,
        errorMessage: value.message,
        stack: value.stack,
        ...("cause" in value ? { cause: value.cause } : {}),
        ...value,
      },
      depth + 1
    );
  if (Array.isArray(value)) {
    const values = value
      .map((item) => toAnyValue(item, depth + 1))
      .filter((item): item is OtelAnyValue => Boolean(item));
    return { arrayValue: { values } };
  }
  if (isRecord(value)) {
    const values = Object.entries(value).flatMap(([key, item]) => {
      const encoded = toAnyValue(item, depth + 1);
      return encoded ? [{ key, value: encoded }] : [];
    });
    return { kvlistValue: { values } };
  }
  return { stringValue: Object.prototype.toString.call(value) };
};

export const toAttributes = (
  attributes: Record<string, unknown>
): Array<{ key: string; value: OtelAnyValue }> =>
  Object.entries(attributes).flatMap(([key, value]) => {
    const encoded = toAnyValue(value);
    return encoded ? [{ key, value: encoded }] : [];
  });
