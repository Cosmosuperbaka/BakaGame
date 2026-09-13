import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveServerBase, resolveServerUrl } from "./ServerEndpoint";
import { DEFAULT_SERVER_URL } from "@/config/Constants";

describe("resolveServerBase 接口基址解析", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("显式声明同源（/）时返回空串，走相对路径", () => {
    vi.stubEnv("VITE_SERVER_URL", "/");
    expect(resolveServerBase()).toBe("");
  });

  it("显式声明同源（same-origin）时返回空串", () => {
    vi.stubEnv("VITE_SERVER_URL", "same-origin");
    expect(resolveServerBase()).toBe("");
  });

  it("开发环境未配置时兜底到本地后端端口", () => {
    vi.stubEnv("VITE_SERVER_URL", "");
    vi.stubEnv("DEV", true);
    expect(resolveServerBase()).toBe(DEFAULT_SERVER_URL);
  });

  it("生产构建未配置时返回空串（由边缘中间件反代）", () => {
    vi.stubEnv("VITE_SERVER_URL", "");
    vi.stubEnv("DEV", false);
    expect(resolveServerBase()).toBe("");
  });

  it("显式配置的地址去除末尾斜杠后原样返回", () => {
    vi.stubEnv("VITE_SERVER_URL", "http://localhost:4850/");
    expect(resolveServerBase()).toBe("http://localhost:4850");
  });

  it("options 传入的地址优先于环境变量", () => {
    vi.stubEnv("VITE_SERVER_URL", "http://from-env:1");
    expect(resolveServerBase("http://from-arg:2")).toBe("http://from-arg:2");
  });
});

describe("resolveServerUrl 基址与路径拼接", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("基址为空时返回相对路径本身", () => {
    vi.stubEnv("VITE_SERVER_URL", "/");
    expect(resolveServerUrl("/api/monitoring/telemetry")).toBe("/api/monitoring/telemetry");
  });

  it("基址非空时拼接为绝对地址", () => {
    vi.stubEnv("VITE_SERVER_URL", "http://localhost:4850");
    expect(resolveServerUrl("/api/monitoring/telemetry")).toBe(
      "http://localhost:4850/api/monitoring/telemetry",
    );
  });
});
