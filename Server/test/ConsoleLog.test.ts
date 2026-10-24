import { describe, expect, test } from "bun:test";

import {
  ConsoleLogSink,
  displayWidth,
  formatConsoleLine,
  truncateToWidth,
} from "../src/infrastructure/logging/ConsoleLog";

const createdAt = Date.UTC(2026, 0, 1, 12, 0, 0, 0);

describe("控制台日志渲染", () => {
  test("定宽列对齐，中文按两列计宽，长正文截断", () => {
    const line = formatConsoleLine(
      {
        createdAt,
        level: "info",
        scope: "接口",
        message: "接口请求完成 GET /api/rooms/1234567890/status/very-long-path",
        fields: [
          ["status", 200],
          ["durationMs", 12.3],
          ["identifier", "127.0.0.1"],
        ],
      },
      { color: false }
    );
    expect(line.startsWith("12:00:00.000  INFO   接口  ")).toBe(true);
    expect(line).toMatch(/状态\s*=200/);
    expect(line).toMatch(/耗时\s*=12\.3ms/);
    expect(line).toContain("…");
    expect(line).not.toContain("\n");
    expect(displayWidth("接口")).toBe(4);
    expect(truncateToWidth("一二三四五", 5)).toBe("一二…");
  });

  test("错误只保留首帧，不输出完整异常栈", () => {
    const error = new Error("boom");
    error.stack = [
      "Error: boom",
      "    at handler (C:\\project\\src\\handler.ts:42:7)",
      "    at next (C:\\project\\src\\next.ts:8:3)",
    ].join("\n");
    const line = formatConsoleLine(
      {
        createdAt,
        level: "error",
        scope: "实时",
        message: "实时命令失败 room.join",
        fields: [["status", 500]],
        error: { errorName: error.name, errorMessage: error.message, stack: error.stack },
      },
      { color: false }
    );
    expect(line).toContain("ERROR");
    expect(line).toContain("异常=Error: boom");
    expect(line).toContain("位置=handler.ts:42:7");
    expect(line).not.toContain("next.ts");
    expect(line.split("\n")).toHaveLength(1);
  });

  test("URL 只显示 host，长异常只留类型，重复 Error 前缀归一", () => {
    const urlLine = formatConsoleLine(
      {
        createdAt,
        level: "info",
        scope: "系统",
        message: "服务已启动",
        fields: [["serverUrl", "http://localhost:4850/some/long/path"]],
      },
      { color: false }
    );
    expect(urlLine).toContain("地址=localhost:4850");

    const longError = formatConsoleLine(
      {
        createdAt,
        level: "error",
        scope: "数据库",
        message: "数据库迁移失败",
        error: {
          errorName: "Error",
          errorMessage: `Error: Failed query: ${"select * from very_long_table ".repeat(8)}`,
          stack: "Error\n    at migrate (db/migrate.ts:12:3)",
        },
      },
      { color: false }
    );
    expect(longError).toContain("异常=Error");
    expect(longError).not.toContain("Error: Error");
    expect(longError).not.toContain("Failed query");
    expect(longError).toContain("位置=migrate.ts:12:3");

    const shortError = formatConsoleLine(
      {
        createdAt,
        level: "error",
        scope: "系统",
        message: "操作失败",
        error: { errorName: "Error", errorMessage: "Error: boom" },
      },
      { color: false }
    );
    expect(shortError).toContain("异常=Error: boom");
    expect(shortError).not.toContain("Error: Error");
  });

  test("颜色开关只影响 ANSI 转义，不影响列宽", () => {
    const entry = {
      createdAt,
      level: "warn" as const,
      scope: "数据库",
      message: "数据库迁移重试",
      fields: [["attempt", 1]] as Array<[string, unknown]>,
    };
    const plain = formatConsoleLine(entry, { color: false });
    const colored = formatConsoleLine(entry, { color: true });
    expect(plain).not.toContain("\u001b[");
    expect(colored).toContain("\u001b[");
    expect(colored.length).toBeGreaterThan(plain.length);
    expect(colored).toContain("WARN");
    expect(colored).toContain("数据库");
  });

  test("连续重复记录在窗口内合并，窗口后带重复次数", () => {
    const output: string[] = [];
    const sink = new ConsoleLogSink({
      output: { info: (line) => output.push(line) },
      color: false,
    });
    const entry = {
      createdAt,
      level: "warn" as const,
      scope: "系统",
      message: "房间清理任务执行失败",
      fields: [] as Array<[string, unknown]>,
    };
    sink.write(entry);
    sink.write({ ...entry, createdAt: createdAt + 1_000 });
    expect(output).toHaveLength(1);
    sink.write({ ...entry, createdAt: createdAt + 6_000 });
    expect(output).toHaveLength(2);
    expect(output[1]).toMatch(/重复\s*=2/);
  });

  test("生命周期分割线带标题且可关闭颜色", () => {
    const output: string[] = [];
    const sink = new ConsoleLogSink({
      output: { info: (line) => output.push(line) },
      color: false,
    });
    sink.section("服务启动");
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("服务启动");
    expect(output[0]).toContain("──");
    expect(output[0]).not.toContain("\u001b[");
  });
});
