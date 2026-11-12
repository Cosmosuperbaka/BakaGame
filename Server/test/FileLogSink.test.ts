import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  // 写入先进批量缓冲，落盘故障在合并写时暴露：不向调用方抛，且只告警一次。
  expect(() => sink.write(record(Date.UTC(2026, 9, 24)))).not.toThrow();
  expect(() => sink.flush()).not.toThrow();
  expect(errors).toHaveLength(1);
  expect(() => sink.write(record(Date.UTC(2026, 9, 24)))).not.toThrow();
  expect(() => sink.flush()).not.toThrow();
  expect(errors).toHaveLength(1);
});

test("环境名归一为安全文件名片段", () => {
  expect(environmentSlug("Production East/1")).toBe("production-east-1");
  expect(environmentSlug("../")).toBe("unknown");
  expect(environmentSlug("")).toBe("unknown");
});

const DAY = Date.UTC(2026, 9, 24, 8);
const lineCount = (path: string): number =>
  readFileSync(path, "utf8").split("\n").filter(Boolean).length;
const sinkOf = (
  directory: string,
  extra: Partial<ConstructorParameters<typeof FileLogSink>[0]> = {}
) =>
  new FileLogSink({
    directory,
    environment: "development",
    resource: resource("development"),
    ...extra,
  });

test("非错误记录先进批量缓冲，flush 后按原顺序整批落盘", () => {
  const directory = temporaryDirectory();
  const sink = sinkOf(directory, { flushIntervalMs: 60_000 });
  for (let index = 0; index < 100; index += 1) sink.write(record(DAY + index, `条目 ${index}`));
  // 还没到合并写时机：磁盘上没有这批记录，写日志不再逐条阻塞事件循环。
  expect(readdirSync(directory)).toEqual([]);
  sink.flush();
  const path = join(directory, "server-development-2026-10-24.log");
  const bodies = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue);
  expect(bodies).toEqual(Array.from({ length: 100 }, (_, index) => `条目 ${index}`));
  sink.close();
});

test("错误级记录立即落盘并带上此前缓冲的记录，强杀前的最后一条不丢", () => {
  const directory = temporaryDirectory();
  const sink = sinkOf(directory, { flushIntervalMs: 60_000 });
  sink.write(record(DAY, "先发生的信息"));
  sink.write(
    createOtelLogRecord({ createdAt: DAY + 1, level: "error", body: "随后的错误", attributes: {} })
  );
  const path = join(directory, "server-development-2026-10-24.log");
  // 没有 flush、没有 close：错误已经在盘上，且顺序在信息之后。
  expect(readFileSync(path, "utf8")).toContain("随后的错误");
  expect(lineCount(path)).toBe(2);
  expect(readFileSync(path, "utf8").indexOf("先发生的信息")).toBeLessThan(
    readFileSync(path, "utf8").indexOf("随后的错误")
  );
  sink.close();
});

test("到期自动合并写，不依赖显式 flush", async () => {
  const directory = temporaryDirectory();
  const sink = sinkOf(directory, { flushIntervalMs: 10 });
  sink.write(record(DAY, "到期落盘"));
  await Bun.sleep(80);
  expect(lineCount(join(directory, "server-development-2026-10-24.log"))).toBe(1);
  sink.close();
});

test("单文件超过上限就滚到下一个分段，每段不超过上限太多", () => {
  const directory = temporaryDirectory();
  const sink = sinkOf(directory, { maxFileBytes: 4_000, flushIntervalMs: 60_000 });
  for (let index = 0; index < 40; index += 1) sink.write(record(DAY + index, `滚动 ${index}`));
  sink.close();
  const files = readdirSync(directory).sort();
  expect(files.length).toBeGreaterThan(2);
  expect(files[0]).toBe("server-development-2026-10-24.1.log");
  expect(files).toContain("server-development-2026-10-24.log");
  let total = 0;
  for (const file of files) {
    const size = statSync(join(directory, file)).size;
    // 一条记录不会被切成两半，所以允许超出一条的长度。
    expect(size).toBeLessThan(4_000 + 1_200);
    total += lineCount(join(directory, file));
  }
  expect(total).toBe(40);
});

test("当日分段数封顶后丢弃并只提示一次，磁盘占用有硬上限", () => {
  const directory = temporaryDirectory();
  const limits: Array<{ dropped: number }> = [];
  const sink = sinkOf(directory, {
    maxFileBytes: 2_000,
    maxSegmentsPerDay: 2,
    flushIntervalMs: 60_000,
    onLimit: (info) => limits.push(info),
  });
  for (let index = 0; index < 60; index += 1) sink.write(record(DAY + index, `封顶 ${index}`));
  sink.flush();
  for (let index = 60; index < 80; index += 1) sink.write(record(DAY + index, `封顶 ${index}`));
  sink.close();
  expect(readdirSync(directory)).toHaveLength(2);
  expect(limits).toHaveLength(1);
  const kept = readdirSync(directory).reduce(
    (sum, file) => sum + lineCount(join(directory, file)),
    0
  );
  expect(kept).toBeLessThan(80);
});

test("重启后接着写：已写满的分段不再追加，直接用下一个", () => {
  const directory = temporaryDirectory();
  const first = sinkOf(directory, { maxFileBytes: 1_000, flushIntervalMs: 60_000 });
  for (let index = 0; index < 10; index += 1) first.write(record(DAY + index, `第一轮 ${index}`));
  first.close();
  const before = readdirSync(directory).sort();
  const full = before.map((file) => statSync(join(directory, file)).size);
  const second = sinkOf(directory, { maxFileBytes: 1_000, flushIntervalMs: 60_000 });
  second.write(record(DAY + 100, "第二轮"));
  second.close();
  // 已满的分段字节数不变（没有被继续追加），新记录落在新增或仍有余量的分段里。
  for (const [index, file] of before.entries()) {
    const size = statSync(join(directory, file)).size;
    if (full[index]! >= 1_000) expect(size).toBe(full[index]!);
  }
  const all = readdirSync(directory).map((file) => readFileSync(join(directory, file), "utf8"));
  expect(all.join("")).toContain("第二轮");
});
