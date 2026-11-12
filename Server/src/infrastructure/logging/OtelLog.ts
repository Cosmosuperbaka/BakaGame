import {
  formatOtlpTraceId,
  toAttributes,
  toUnixNanoString,
  type OtelAnyValue,
} from "./OtelEncoding";
import type { StructuredLogLevel } from "../StructuredLog";

const SEVERITY: Record<StructuredLogLevel, { number: number; text: string }> = {
  debug: { number: 5, text: "DEBUG" },
  info: { number: 9, text: "INFO" },
  warn: { number: 13, text: "WARN" },
  error: { number: 17, text: "ERROR" },
};

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

export const toUnixNano = (createdAt: number): string => toUnixNanoString(createdAt);

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
