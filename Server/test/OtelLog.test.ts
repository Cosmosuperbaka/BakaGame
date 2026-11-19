import { describe, expect, test } from "bun:test";

import {
  createOtelLogRecord,
  formatOtelLogLine,
  toUnixNano,
  type OtelResource,
} from "../src/infrastructure/logging/OtelLog";

const resource: OtelResource = {
  serviceName: "Bakagame-Server",
  serviceNamespace: "Bakagame",
  deploymentEnvironment: "production",
  hostName: "fixture-host",
};

describe("OTel 日志记录", () => {
  test("按 OTLP/JSON 输出单行信封，资源、严重级别、正文与追踪号完整", () => {
    const record = createOtelLogRecord({
      createdAt: Date.UTC(2026, 9, 24, 1, 2, 3, 4),
      level: "error",
      body: "数据库迁移失败，账号功能不可用",
      attributes: {
        "http.response.status_code": 500,
        duration_ms: 12.5,
        nested: { attempt: 2, ok: false },
        tags: ["a", "b"],
        omitted: undefined,
      },
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    });
    const line = formatOtelLogLine(record, resource);
    expect(line).not.toContain("\n");

    const payload = JSON.parse(line) as {
      resourceLogs: Array<{
        resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> };
        scopeLogs: Array<{
          scope: { name: string };
          logRecords: Array<{
            timeUnixNano: string;
            severityNumber: number;
            severityText: string;
            body: { stringValue: string };
            traceId: string;
            attributes: Array<{ key: string; value: Record<string, unknown> }>;
          }>;
        }>;
      }>;
    };
    const resourceAttrs = Object.fromEntries(
      payload.resourceLogs[0].resource.attributes.map((item) => [item.key, item.value.stringValue])
    );
    expect(resourceAttrs).toMatchObject({
      "service.name": "Bakagame-Server",
      "service.namespace": "Bakagame",
      "deployment.environment": "production",
      "host.name": "fixture-host",
    });

    const logRecord = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(payload.resourceLogs[0].scopeLogs[0].scope.name).toBe("bakagame.logger");
    expect(logRecord.timeUnixNano).toBe(toUnixNano(Date.UTC(2026, 9, 24, 1, 2, 3, 4)));
    expect(logRecord.severityNumber).toBe(17);
    expect(logRecord.severityText).toBe("ERROR");
    expect(logRecord.body.stringValue).toBe("数据库迁移失败，账号功能不可用");
    expect(logRecord.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");

    const attrs = Object.fromEntries(logRecord.attributes.map((item) => [item.key, item.value]));
    expect(attrs["http.response.status_code"]).toEqual({ intValue: "500" });
    expect(attrs.duration_ms).toEqual({ doubleValue: 12.5 });
    expect(attrs.nested).toEqual({
      kvlistValue: {
        values: [
          { key: "attempt", value: { intValue: "2" } },
          { key: "ok", value: { boolValue: false } },
        ],
      },
    });
    expect(attrs.tags).toEqual({
      arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] },
    });
    expect(attrs.omitted).toBeUndefined();
  });

  test("非 32 位十六进制的追踪号按 OTLP 规则补齐", () => {
    const record = createOtelLogRecord({
      createdAt: 0,
      level: "info",
      body: "测试",
      traceId: "abc",
    });
    expect(record.traceId).toHaveLength(32);
    expect(record.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("循环引用与超深对象不会让序列化抛错", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    const record = createOtelLogRecord({
      createdAt: 0,
      level: "warn",
      body: "循环",
      attributes: { cyclic },
    });
    expect(() => formatOtelLogLine(record, resource)).not.toThrow();
    expect(formatOtelLogLine(record, resource)).toContain("MAX_DEPTH_EXCEEDED");
  });
});
