import { describe, expect, test } from "bun:test";
import {
  formatStructuredLog,
  isLogLevelEnabled,
  parseLogLevel,
  resolveLogLevel,
} from "../src/infrastructure/StructuredLog";

describe("结构化运行日志", () => {
  test("等级解析：非法值回落 info，大小写与空白不影响", () => {
    expect(parseLogLevel("DEBUG")).toBe("debug");
    expect(parseLogLevel(" warn ")).toBe("warn");
    expect(parseLogLevel("verbose")).toBe("info");
    expect(parseLogLevel(undefined)).toBe("info");
    expect(resolveLogLevel("error")).toBe("error");
    expect(parseLogLevel("nope", "warn")).toBe("warn");
  });

  test("等级阈值：配置 warn 时只放行 warn 与 error", () => {
    expect(isLogLevelEnabled("info", "debug")).toBe(false);
    expect(isLogLevelEnabled("info", "info")).toBe(true);
    expect(isLogLevelEnabled("warn", "info")).toBe(false);
    expect(isLogLevelEnabled("warn", "warn")).toBe(true);
    expect(isLogLevelEnabled("debug", "debug")).toBe(true);
  });

  test("固定 time/level/msg 字段，上下文单独放在 context 且单行输出", () => {
    const line = formatStructuredLog({
      createdAt: Date.UTC(2026, 9, 22, 1, 2, 3, 4),
      level: "info",
      message: "房间已创建",
      context: { roomId: "room-1", payload: { note: "第一行\n第二行" } },
    });

    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      time: "2026-10-22T01:02:03.004Z",
      level: "info",
      msg: "房间已创建",
      context: { roomId: "room-1", payload: { note: "第一行\n第二行" } },
    });
  });

  test("上下文脱敏：cookie/token/密码不落盘，错误保留类型与堆栈", () => {
    const error = new TypeError("boom");
    const line = formatStructuredLog({
      createdAt: 0,
      level: "error",
      message: "写入失败",
      context: {
        cookie: "dummy-cookie",
        token: "dummy-token",
        password: "dummy-password",
        error,
      },
    });

    const parsed = JSON.parse(line) as {
      context: { error: { errorName: string; errorMessage: string; stack: string } };
    };
    expect(line).not.toContain("dummy-cookie");
    expect(line).not.toContain("dummy-token");
    expect(line).not.toContain("dummy-password");
    expect(parsed.context.error.errorName).toBe("TypeError");
    expect(parsed.context.error.errorMessage).toBe("boom");
    expect(parsed.context.error.stack).toContain("TypeError");
  });
});
