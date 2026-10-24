import { describe, expect, test } from "bun:test";

import {
  isLogLevelEnabled,
  parseLogLevel,
  resolveLogLevel,
} from "../src/infrastructure/StructuredLog";

describe("结构化运行日志等级", () => {
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
});
