import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import ts from "typescript";

export const indexSourcePath = path.resolve(import.meta.dir, "../../src/Index.ts");
export const finalStages = ["notify.faker", "notify.song", "notify.ccb", "buffer", "drain", "stop", "dispose", "otlp", "sentry.flush", "sentry.close"] as const;
export type Stage = typeof finalStages[number];

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** 执行完整真实 Index 源码，仅在模块边界注入隔离替身；不 import 应用、不 readEnv、不打开端口。 */
export async function createIndexShutdownHarness(options: {
  source?: string;
  failures?: Partial<Record<Stage, "throw" | "false">>;
  hold?: Stage[];
  otlpEnabled?: boolean;
} = {}) {
  const calls: string[] = [];
  const exits: number[] = [];
  const logs: { level: string; message: string; details: unknown }[] = [];
  const gates = new Map((options.hold ?? []).map(stage => [stage, { started: deferred(), release: deferred() }]));
  const intervals: { ms: number; unrefed: boolean; cleared: number }[] = [];
  const timeouts: { ms: number; unrefed: boolean; cleared: number; fire: () => void }[] = [];
  const signals = Object.assign(new EventEmitter(), { exit: (code: number) => { exits.push(code); } });
  let configuration!: { isShuttingDown: () => boolean; onTriggerShutdown: () => Promise<void> };
  const execute = async (stage: Stage, argument?: number | boolean) => {
    calls.push(`${stage}:start${argument === undefined ? "" : `:${argument}`}`);
    const gate = gates.get(stage);
    if (gate) {
      gate.started.resolve();
      await gate.release.promise;
    }
    if (options.failures?.[stage] === "throw") throw new Error(`injected:${stage}`, { cause: new Error("injected cause") });
    calls.push(`${stage}:end`);
    return options.failures?.[stage] !== "false";
  };
  const snapshot = () => ({ onlinePlayerCount: 0, roomCount: 0, connectionCount: 0 });
  const service = (game: "faker" | "song" | "ccb") => ({
    notifyShutdown: () => execute(`notify.${game}`),
    getHealthSnapshot: snapshot,
    drainPendingWrites: () => execute("drain"),
  });
  class Logger {
    warn(message: string, details?: unknown) { logs.push({ level: "warn", message, details }); }
    info(message: string, details?: unknown) { logs.push({ level: "info", message, details }); }
    error(message: string, details?: unknown) { logs.push({ level: "error", message, details }); }
  }
  const modules: Record<string, unknown> = {
    "./config/Env": { readEnv: () => ({ otelEndpoint: options.otlpEnabled === false ? undefined : "fixture://no-network", serverPort: 1, serverListenHost: "127.0.0.1" }) },
    "./application/WhoIsFakerService": { WhoIsFakerService: class { constructor() { return service("faker"); } } },
    "./infrastructure/WordBankRepository": { WordBankRepository: class {} },
    "./infrastructure/EventLogger": { EventLogger: Logger, describeError: (error: Error) => ({ name: error.name, message: error.message, stack: error.stack, cause: error.cause }) },
    "./infrastructure/OtlpExporter": { OtlpExporter: class {
      sendHeartbeatTrace() { return Promise.resolve(); }
      shutdown() { return execute("otlp"); }
    } },
    "./infrastructure/Sentry": {
      initServerSentry() {}, captureServerCheckIn() {}, gaugeServerMetric() {}, SERVER_HEARTBEAT_INTERVAL_MS: 60_000,
      flushServerSentry: (ms: number) => execute("sentry.flush", ms),
      closeServerSentry: (ms: number) => execute("sentry.close", ms),
    },
    "./application/CreateServer": { createServer: (input: typeof configuration) => {
      configuration = input;
      return {
        app: { listen: () => ({ server: { hostname: "127.0.0.1", port: 1 } }), stop: (force: boolean) => execute("stop", force) },
        dispose: () => execute("dispose"), sonGuessrService: service("song"), ccbService: service("ccb"),
        // 真实装配下它把玩家数报给数据 Worker（更新器限速用）；这里只是空转。
        reportBangumiLoad: () => {},
      };
    } },
  };
  const context = createContext({
    exports: {}, require: (id: string) => {
      if (!(id in modules)) throw new Error(`未登记的真实模块加载: ${id}`);
      return modules[id];
    },
    process: signals,
    Bun: { sleep: (ms: number) => execute("buffer", ms) },
    setInterval: (_callback: () => void, ms: number) => {
      const timer = { ms, unrefed: false, cleared: 0, unref() { this.unrefed = true; } };
      intervals.push(timer);
      return timer;
    },
    clearInterval: (timer: typeof intervals[number]) => { timer.cleared++; },
    setTimeout: (callback: () => void, ms: number) => {
      const timer = { ms, unrefed: false, cleared: 0, fire: callback, unref() { this.unrefed = true; } };
      timeouts.push(timer);
      return timer;
    },
    clearTimeout: (timer: typeof timeouts[number]) => { timer.cleared++; },
  });
  const source = options.source ?? await readFile(indexSourcePath, "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInContext(compiled, context, { filename: indexSourcePath, timeout: 1_000 });
  return {
    calls, exits, logs, intervals, timeouts,
    isShuttingDown: () => configuration.isShuttingDown(),
    preNotify: () => configuration.onTriggerShutdown(),
    signal: (signal = "SIGTERM") => signals.emit(signal),
    fatal: (error: Error) => signals.emit("uncaughtException", error),
    shutdown: runInContext("shutdown", context) as (signal?: string) => Promise<void>,
    get task() { return runInContext("shutdownTask", context) as Promise<void> | undefined; },
    async started(stage: Stage) { await gates.get(stage)!.started.promise; },
    release(stage: Stage) { gates.get(stage)!.release.resolve(); },
  };
}
