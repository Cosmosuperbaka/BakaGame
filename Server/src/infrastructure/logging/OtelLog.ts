import { formatOtlpTraceId, toUnixNanoString } from "../OtlpExporter";
import type { StructuredLogLevel } from "../StructuredLog";
import { isRecord } from "../../shared/Json";

const SEVERITY: Record<StructuredLogLevel, { number: number; text: string }> = {
  debug: { number: 5, text: "DEBUG" },
  info: { number: 9, text: "INFO" },
  warn: { number: 13, text: "WARN" },
  error: { number: 17, text: "ERROR" },
};

const MAX_ANY_VALUE_DEPTH = 8;

export interface OtelResource {
  serviceName: string;
  serviceNamespace?: string;
  deploymentEnvironment: string;
  hostName?: string;
}

/**
 * 一条日志的规范化记录：所有结构化出口（本地 JSONL、SQLite、MySQL、OTLP）
 * 都消费同一份对象，保证脱敏、字段与追踪号只有一次真相。
 */
export interface OtelLogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: string;
  attributes: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
}

export interface LogSink {
  write(record: OtelLogRecord): void;
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

type OtelAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtelAnyValue[] } }
  | { kvlistValue: { values: Array<{ key: string; value: OtelAnyValue }> } };

export const toUnixNano = (createdAt: number): string => toUnixNanoString(createdAt);

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

const toAttributes = (
  attributes: Record<string, unknown>
): Array<{ key: string; value: OtelAnyValue }> =>
  Object.entries(attributes).flatMap(([key, value]) => {
    const encoded = toAnyValue(value);
    return encoded ? [{ key, value: encoded }] : [];
  });

const resourceAttributes = (
  resource: OtelResource
): Array<{ key: string; value: OtelAnyValue }> => {
  const attributes: Record<string, unknown> = {
    "service.name": resource.serviceName,
    "deployment.environment": resource.deploymentEnvironment,
  };
  if (resource.serviceNamespace) attributes["service.namespace"] = resource.serviceNamespace;
  if (resource.hostName) attributes["host.name"] = resource.hostName;
  return toAttributes(attributes);
};

export const createOtelLogRecord = ({
  createdAt,
  level,
  body,
  attributes = {},
  traceId,
  spanId,
}: {
  createdAt: number;
  level: StructuredLogLevel;
  body: string;
  attributes?: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
}): OtelLogRecord => {
  const severity = SEVERITY[level];
  const timeUnixNano = toUnixNano(createdAt);
  const normalizedTraceId = traceId ? formatOtlpTraceId(traceId) : undefined;
  const attributesWithTrace =
    traceId && normalizedTraceId !== traceId.toLowerCase()
      ? { ...attributes, "trace.id.original": traceId }
      : attributes;
  return {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    severityNumber: severity.number,
    severityText: severity.text,
    body,
    attributes: attributesWithTrace,
    ...(normalizedTraceId ? { traceId: normalizedTraceId } : {}),
    ...(spanId ? { spanId } : {}),
  };
};

/** 单条 OTLP/JSON 日志（resourceLogs 信封），一行一条，便于 JSONL 与按行摄入。 */
export const formatOtelLogLine = (
  record: OtelLogRecord,
  resource: OtelResource,
  scopeName = "bakagame.logger"
): string =>
  JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes(resource) },
        scopeLogs: [
          {
            scope: { name: scopeName },
            logRecords: [
              {
                timeUnixNano: record.timeUnixNano,
                observedTimeUnixNano: record.observedTimeUnixNano,
                severityNumber: record.severityNumber,
                severityText: record.severityText,
                body: { stringValue: record.body },
                attributes: toAttributes(record.attributes),
                ...(record.traceId ? { traceId: record.traceId } : {}),
                ...(record.spanId ? { spanId: record.spanId } : {}),
              },
            ],
          },
        ],
      },
    ],
  });
