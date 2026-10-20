import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import ts from "typescript";

import { HTTP_MAX_REQUEST_BODY_BYTES } from "../../src/config/Constants";

export const indexSourcePath = path.resolve(import.meta.dir, "../../src/Index.ts");
export const finalStages = [
  "notify.faker",
  "notify.song",
  "notify.cee",
  "buffer",
  // 快照必须赶在排空之前写完：排空要等对局记录收尾，而进程不能等到那时才落盘。
  "persist",
  "drain.faker",
  "drain.records",
  "stop",
  "dispose",
  "snapshot.close",
  "otlp",
  "sentry.flush",
  "sentry.close",
] as const;
export type Stage = (typeof finalStages)[number];

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 执行完整真实 Index 源码，仅在模块边界注入隔离替身；不 import 应用、不 readEnv、不打开端口。 */
export async function createIndexShutdownHarness(
  options: {
    source?: string;
    failures?: Partial<Record<Stage, "throw" | "false">>;
    hold?: Stage[];
    otlpEnabled?: boolean;
  } = {}
) {
  const calls: string[] = [];
  const exits: number[] = [];
  const logs: { level: string; message: string; details: unknown }[] = [];
  const gates = new Map(
    (options.hold ?? []).map((stage) => [stage, { started: deferred(), release: deferred() }])
  );
  const intervals: { ms: number; unrefed: boolean; cleared: number }[] = [];
  /** 真实 Index 传给 `app.listen` 的参数，用于断言监听层的载荷上限确实接上了。 */
  const listenOptions: Record<string, unknown>[] = [];
  const timeouts: { ms: number; unrefed: boolean; cleared: number; fire: () => void }[] = [];
  const signals = Object.assign(new EventEmitter(), {
    exit: (code: number) => {
      exits.push(code);
    },
  });
  let configuration!: { isShuttingDown: () => boolean; onTriggerShutdown: () => Promise<void> };
  const execute = async (stage: Stage, argument?: number | boolean) => {
    calls.push(`${stage}:start${argument === undefined ? "" : `:${argument}`}`);
    const gate = gates.get(stage);
    if (gate) {
      gate.started.resolve();
      await gate.release.promise;
    }
    if (options.failures?.[stage] === "throw")
      throw new Error(`injected:${stage}`, { cause: new Error("injected cause") });
    calls.push(`${stage}:end`);
    return options.failures?.[stage] !== "false";
  };
  /**
   * 同步版记账：`persist` 那一步 Index 是在 attempt 的回调体里直接调用快照函数，
   * 返回值不进 await；换成异步 `execute` 会让阶段顺序跟着调度漂移，断言就测不到真实串行。
   */
  const recordSync = (stage: Stage) => {
    calls.push(`${stage}:start`);
    if (options.failures?.[stage] === "throw")
      throw new Error(`injected:${stage}`, { cause: new Error("injected cause") });
    calls.push(`${stage}:end`);
  };
  const snapshot = () => ({ onlinePlayerCount: 0, roomCount: 0, connectionCount: 0 });
  const service = (game: "faker" | "song" | "cee") => ({
    notifyShutdown: () => execute(`notify.${game}`),
    getHealthSnapshot: snapshot,
    // 只有谁是卧底自带可排队写入队列；猜歌与 CEE 的落库都汇进共享的对局记录队列，
    // 因此它们没有 drainPendingWrites —— 出现即为凭空造 API。
    ...(game === "faker" ? { drainPendingWrites: () => execute("drain.faker") } : {}),
  });
  class Logger {
    warn(message: string, details?: unknown) {
      logs.push({ level: "warn", message, details });
    }
    info(message: string, details?: unknown) {
      logs.push({ level: "info", message, details });
    }
    error(message: string, details?: unknown) {
      logs.push({ level: "error", message, details });
    }
  }
  const modules: Record<string, unknown> = {
    "./config/Env": {
      readEnv: () => ({
        otelEndpoint: options.otlpEnabled === false ? undefined : "fixture://no-network",
        serverPort: 1,
        serverListenHost: "127.0.0.1",
        // 带上数据库地址：Index 才会构造对局记录服务，`drain.records` 这一步才有东西可排。
        databaseUrl: "mysql://fixture.invalid/database",
      }),
    },
    // 常量模块是叶子（无副作用、不读环境），登记它才能守住「Index 不长出新依赖」这条断言。
    "./config/Constants": { HTTP_MAX_REQUEST_BODY_BYTES },
    // 房间快照：`join` 只用来拼快照目录，恢复与保存都在停机链路两端，桩里只记账不碰文件系统。
    "node:path": { join: path.join },
    "./shared/RoomSnapshot": { ROOM_SNAPSHOT_GAMES: ["faker", "song", "cee"] },
    "./infrastructure/RoomSnapshotStore": {
      RoomSnapshotStore: class {
        constructor() {
          return { close: () => execute("snapshot.close") };
        }
      },
    },
    "./application/RoomSnapshots": {
      restoreRoomSnapshots: () => ({ restored: {}, discarded: [] }),
      saveRoomSnapshots: () => {
        recordSync("persist");
        return { saved: 0 };
      },
    },
    "./application/WhoIsFakerService": {
      WhoIsFakerService: class {
        constructor() {
          return service("faker");
        }
      },
    },
    "./infrastructure/WordBankRepository": { DatabaseWordBankRepository: class {} },
    "./infrastructure/db/Database": {
      createDatabase: () => ({
        ready: Promise.resolve(),
        db: {},
        close: () => Promise.resolve(),
      }),
    },
    "./infrastructure/db/GameRecordRepository": { DatabaseGameRecordRepository: class {} },
    "./application/GameRecordService": {
      // 三款游戏共用的对局记录队列：停机的 `drain.records` 排空的就是它（等价于 close 的等待语义）。
      GameRecordService: class {
        constructor() {
          return { close: () => execute("drain.records") };
        }
      },
    },
    "./infrastructure/EventLogger": {
      EventLogger: Logger,
      describeError: (error: Error) => ({
        name: error.name,
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      }),
    },
    "./infrastructure/OtlpExporter": {
      OtlpExporter: class {
        sendHeartbeatTrace() {
          return Promise.resolve();
        }
        shutdown() {
          return execute("otlp");
        }
      },
    },
    "./infrastructure/Sentry": {
      initServerSentry() {},
      captureServerCheckIn() {},
      gaugeServerMetric() {},
      SERVER_HEARTBEAT_INTERVAL_MS: 60_000,
      flushServerSentry: (ms: number) => execute("sentry.flush", ms),
      closeServerSentry: (ms: number) => execute("sentry.close", ms),
    },
    "./application/CreateServer": {
      createServer: (input: typeof configuration) => {
        configuration = input;
        return {
          app: {
            listen: (options: Record<string, unknown>) => {
              listenOptions.push(options);
              return { server: { hostname: "127.0.0.1", port: 1 } };
            },
            stop: (force: boolean) => execute("stop", force),
          },
          dispose: () => execute("dispose"),
          sonGuessrService: service("song"),
          ceeService: service("cee"),
          // 真实装配下它把玩家数报给数据 Worker（更新器限速用）；这里只是空转。
          reportBangumiLoad: () => {},
        };
      },
    },
  };
  const context = createContext({
    exports: {},
    require: (id: string) => {
      if (!(id in modules)) throw new Error(`未登记的真实模块加载: ${id}`);
      return modules[id];
    },
    process: signals,
    Bun: { sleep: (ms: number) => execute("buffer", ms) },
    setInterval: (_callback: () => void, ms: number) => {
      const timer = {
        ms,
        unrefed: false,
        cleared: 0,
        unref() {
          this.unrefed = true;
        },
      };
      intervals.push(timer);
      return timer;
    },
    clearInterval: (timer: (typeof intervals)[number]) => {
      timer.cleared++;
    },
    setTimeout: (callback: () => void, ms: number) => {
      const timer = {
        ms,
        unrefed: false,
        cleared: 0,
        fire: callback,
        unref() {
          this.unrefed = true;
        },
      };
      timeouts.push(timer);
      return timer;
    },
    clearTimeout: (timer: (typeof timeouts)[number]) => {
      timer.cleared++;
    },
  });
  const raw = options.source ?? (await readFile(indexSourcePath, "utf8"));
  // 夹具把源码转成 CommonJS 再放进 vm，而 `import.meta` 只在 ESM 里合法；这里按真实取值就地
  // 替换成 Index.ts 所在目录，路径与生产一致。取值本身由停机冒烟脚本在真实 Bun 进程里验证。
  const source = raw.replace(
    /\bimport\.meta\.dir\b/g,
    JSON.stringify(path.dirname(indexSourcePath))
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInContext(compiled, context, { filename: indexSourcePath, timeout: 1_000 });
  return {
    calls,
    exits,
    logs,
    intervals,
    timeouts,
    listenOptions,
    /** 真实 Index 的停机总预算常量：断言看门狗与它同源，而不是各自抄一个数字。 */
    budgetMs: runInContext("exports.SHUTDOWN_BUDGET_MS", context) as number,
    isShuttingDown: () => configuration.isShuttingDown(),
    preNotify: () => configuration.onTriggerShutdown(),
    signal: (signal = "SIGTERM") => signals.emit(signal),
    fatal: (error: Error) => signals.emit("uncaughtException", error),
    shutdown: runInContext("shutdown", context) as (signal?: string) => Promise<void>,
    get task() {
      return runInContext("shutdownTask", context) as Promise<void> | undefined;
    },
    async started(stage: Stage) {
      await gates.get(stage)!.started.promise;
    },
    release(stage: Stage) {
      gates.get(stage)!.release.resolve();
    },
  };
}
