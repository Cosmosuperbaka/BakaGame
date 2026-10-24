import { hostname } from "node:os";
import { resolve } from "node:path";

import type { AppEnv } from "../../config/Env";
import type { LogConsoleColor } from "../../config/env/Observability";
import { EventLogger, type OperationLogging } from "../EventLogger";
import type { OtlpExporter } from "../OtlpExporter";
import { ConsoleLogSink } from "./ConsoleLog";
import { FileLogSink } from "./FileLogSink";
import type { OtelResource } from "./OtelLog";

const SERVER_ROOT = resolve(import.meta.dir, "../../..");

export const resolveLogDirectory = (configured?: string): string =>
  resolve(SERVER_ROOT, configured?.trim() || "storage/logs");

export const resolveConsoleColor = (mode: LogConsoleColor | undefined): boolean => {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return process.stdout.isTTY === true;
};

const buildResource = (env: AppEnv): OtelResource => ({
  serviceName: env.otelServiceName ?? "Bakagame-Server",
  serviceNamespace: env.otelServiceNamespace ?? "Bakagame",
  deploymentEnvironment: env.otelDeploymentEnvironment ?? "development",
  hostName: hostname(),
});

/**
 * 服务端唯一日志装配点：控制台给人看，文件给 Agent 与长期排障看。
 * 两个出口共享同一条已脱敏记录；文件出口故障只降级自身，不挡业务与控制台。
 */
export const createServerLogger = (env: AppEnv, otlpExporter?: OtlpExporter): EventLogger => {
  const console = new ConsoleLogSink({ color: resolveConsoleColor(env.logConsoleColor) });
  const resource = buildResource(env);
  const file = new FileLogSink({
    directory: resolveLogDirectory(env.logDirectory),
    environment: resource.deploymentEnvironment,
    resource,
    onError: (error) =>
      console.write({
        createdAt: Date.now(),
        level: "warn",
        scope: "日志",
        message: "本地 OTel 日志文件不可用，已停止文件出口",
        fields: [["error", String(error)]],
      }),
  });
  const operationLogging: OperationLogging = env.logOperations === "all" ? "all" : "errors";
  return new EventLogger(undefined, undefined, otlpExporter, undefined, {
    console,
    sinks: [file],
    slowOperationMs: env.logSlowOperationMs ?? 1_000,
    operationLogging,
  });
};
