import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { environmentSlug, FileLogSink } from "../src/infrastructure/logging/FileLogSink";
import { createOtelLogRecord, type OtelResource } from "../src/infrastructure/logging/OtelLog";

const directories: string[] = [];

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-logs-"));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const resource = (environment: string): OtelResource => ({
  serviceName: "Bakagame-Server",
  serviceNamespace: "Bakagame",
  deploymentEnvironment: environment,
  hostName: "fixture-host",
});

const record = (createdAt: number, body = "房间已创建") =>
  createOtelLogRecord({
    createdAt,
    level: "info",
    body,
    attributes: { "event.name": "room.created", roomId: "1234" },
  });

test("开发与生产写到不同文件，行内容为完整 OTLP/JSON", () => {
  const directory = temporaryDirectory();
  const production = new FileLogSink({
    directory,
    environment: "production",
    resource: resource("production"),
  });
  const development = new FileLogSink({
    directory,
    environment: "development",
    resource: resource("development"),
  });
  production.write(record(Date.UTC(2026, 9, 24, 1, 2, 3)));
  development.write(record(Date.UTC(2026, 9, 24, 1, 2, 4), "玩家已加入房间"));
  production.close();
  development.close();

  const files = readdirSync(directory).sort();
  expect(files).toEqual(["server-development-2026-10-24.log", "server-production-2026-10-24.log"]);
  const line = JSON.parse(
    readFileSync(join(directory, "server-production-2026-10-24.log"), "utf8").trim()
  ) as {
    resourceLogs: Array<{
      resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
      scopeLogs: Array<{ logRecords: Array<{ body: { stringValue: string } }> }>;
    }>;
  };
  const resourceAttrs = Object.fromEntries(
    line.resourceLogs[0].resource.attributes.map((item) => [item.key, item.value.stringValue])
  );
  expect(resourceAttrs["deployment.environment"]).toBe("production");
  expect(line.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue).toBe("房间已创建");
});

test("跨 UTC 日期自动换文件", () => {
  const directory = temporaryDirectory();
  const sink = new FileLogSink({
    directory,
    environment: "development",
    resource: resource("development"),
  });
  sink.write(record(Date.UTC(2026, 9, 24, 23, 59, 59)));
  sink.write(record(Date.UTC(2026, 9, 25, 0, 0, 0)));
  sink.close();
  expect(readdirSync(directory).sort()).toEqual([
    "server-development-2026-10-24.log",
    "server-development-2026-10-25.log",
  ]);
});

test("目录不可写时降级为单一告警，不向业务抛出", () => {
  const directory = temporaryDirectory();
  const blocker = join(directory, "not-a-directory");
  writeFileSync(blocker, "x");
  const errors: unknown[] = [];
  const sink = new FileLogSink({
    directory: blocker,
    environment: "development",
    resource: resource("development"),
    onError: (error) => errors.push(error),
  });
  expect(() => sink.write(record(Date.UTC(2026, 9, 24)))).not.toThrow();
  expect(errors).toHaveLength(1);
  expect(() => sink.write(record(Date.UTC(2026, 9, 24)))).not.toThrow();
  expect(errors).toHaveLength(1);
});

test("环境名归一为安全文件名片段", () => {
  expect(environmentSlug("Production East/1")).toBe("production-east-1");
  expect(environmentSlug("../")).toBe("unknown");
  expect(environmentSlug("")).toBe("unknown");
});
