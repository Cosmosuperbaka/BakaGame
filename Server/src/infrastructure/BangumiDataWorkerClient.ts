import { AppError } from "../domain/Errors";
import type {
  BangumiDataLogFrame,
  BangumiDataReply,
  BangumiDataRequest,
  BangumiDataFrame,
  BangumiErrorContext,
} from "./BangumiDataWorker";

/**
 * 主线程日志出口的最小形状；`EventLogger` 结构上直接满足。
 *
 * Worker 线程里没有 Sentry / OTLP，日志唯一的观测路径就是桥回主线程，注入方就是
 * 那个出口（见 `CreateBangumiData` 的 `logger` 参数）。
 */
export interface BangumiWorkerLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/** 跨线程回传的栈里已经带着 worker 侧文件名与行号，拼接时留一行边界说明。 */
const WORKER_STACK_MARKER = "    ← 以上为 Bangumi 数据 Worker 线程栈（跨线程回传）";

/** 按 worker 侧上下文重建错误链：name / message / stack 全部保留，Sentry 才按栈聚得起来。 */
const reviveWorkerError = (context: BangumiErrorContext): Error => {
  const revived = new Error(`${context.name}: ${context.message}`);
  revived.name = context.name;
  if (context.stack) revived.stack = context.stack;
  if (context.cause) revived.cause = reviveWorkerError(context.cause);
  return revived;
};

/** 崩溃事件里可能直接带 Error 对象（Bun 会把 worker 未捕获异常交到这里）。 */
const contextFromError = (error: unknown): BangumiErrorContext | undefined =>
  error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
        ...(error.cause instanceof Error
          ? { cause: { name: error.cause.name, message: error.cause.message } }
          : {}),
      }
    : undefined;

/**
 * 把 worker 侧的栈与 cause 挂回主线程错误对象。
 *
 * `postMessage` 是结构化克隆，Error 的栈过不去：主线程 `new` 出来的错误只有请求侧栈。
 * 这里把 worker 栈拼在前面、原错误作为 cause，异常才第一次变得**可归因**。
 */
const applyWorkerContext = (error: Error, context?: BangumiErrorContext): void => {
  if (!context) return;
  error.cause = reviveWorkerError(context);
  if (!context.stack) return;
  const localStack = error.stack ?? "";
  if (!localStack.includes(context.stack)) {
    error.stack = `${context.stack}\n${WORKER_STACK_MARKER}\n${localStack}`;
  }
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};
/**
 * 请求体（去掉由本类分配的 id）。
 *
 * `Omit` 作用在联合类型上不会分布到各成员，会把每个请求各自的字段全部抹掉，
 * 所以这里显式写成分发形式。
 */
export type BangumiDataCall = BangumiDataRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, "id">
    : never
  : never;

/**
 * 初始化窗口取 CEE 那侧更长的口径（1 小时）：索���重建（首次部署或数据变更后向
 * Meilisearch 全量写入数十万文档）耗时为分钟级，必须独立于查询超时 —— 若与查询共用
 * 短窗口，ready 被拒后**所有后续查询永久失败**（猜番链路线上踩过同款坑）。
 */
const INIT_TIMEOUT_MS = 3_600_000;
/** 查询超时：索引构建期间查询会排队等待，与 CEE/猜番同取 20s。 */
const QUERY_TIMEOUT_MS = 20_000;
/** 目录导入涉及远程分页拉取，单独放宽。 */
const DIRECTORY_TIMEOUT_MS = 60_000;

const timeoutFor = (method: BangumiDataCall["method"]) => {
  if (method === "init") return INIT_TIMEOUT_MS;
  if (method === "cee.importDirectory" || method === "close") return DIRECTORY_TIMEOUT_MS;
  return QUERY_TIMEOUT_MS;
};

/** 崩溃恢复参数：默认值是生产口径，测试注入极小值以免真等。 */
export interface BangumiWorkerRecovery {
  /** 首次重启前的等待，之后每连续崩溃一次翻倍。 */
  baseDelayMs: number;
  /** 退避上限。 */
  maxDelayMs: number;
  /** 连续崩溃超过这个次数就停止重启，请求快速失败，避免崩溃循环。 */
  maxRestarts: number;
  /** 重启并完成初始化后，稳定运行满这么久才清零连续崩溃计数。 */
  stableMs: number;
}

const DEFAULT_RECOVERY: BangumiWorkerRecovery = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxRestarts: 5,
  stableMs: 60_000,
};

/** 交给门面的就绪承诺：首次初始化成功才落定，崩溃重启不会让它作废。 */
interface ReadyDeferred {
  settled: boolean;
  resolve(): void;
  reject(error: unknown): void;
}

/**
 * 猜歌与 CEE 共享的**同一个** Worker 进程；两个门面都经它发请求，写操作在单线程内天然串行。
 *
 * 线程崩溃（未捕获异常）后：在途请求立刻以 `BANGUMI_DATA_UNAVAILABLE` 落定；退避期内的新请求
 * 快速失败（让降级链路接管而不是挂到查询超时）；退避结束后重新起线程并重放 init，重放完成前
 * 的查询排队等待。连续崩溃超过上限后不再重启，请求持续快速失败。
 */
export class BangumiDataWorkerClient {
  private worker: Worker | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly recovery: BangumiWorkerRecovery;
  private nextId = 0;
  private closing = false;
  private closed = false;
  private broken = false;
  private restarts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  /** 重放用的 init 载荷；首次 init 时记下。 */
  private initPayload: BangumiDataCall | undefined;
  /** 当前这一代线程的初始化进度；落定前普通请求在此排队。 */
  private initGate: Promise<void> | undefined;
  private readyDeferred: ReadyDeferred | undefined;

  constructor(
    private readonly logger?: BangumiWorkerLogger,
    recovery: Partial<BangumiWorkerRecovery> = {}
  ) {
    this.recovery = { ...DEFAULT_RECOVERY, ...recovery };
    this.spawn();
  }

  private spawn(): Worker {
    const worker = new Worker(new URL("./BangumiDataWorker.ts", import.meta.url).href);
    this.worker = worker;
    // 旧线程的迟到事件（崩溃后又回包、或被 terminate 前的最后一帧）一律忽略。
    worker.onmessage = ({ data }: MessageEvent<BangumiDataFrame>) => {
      if (this.worker === worker) this.handleFrame(data);
    };
    // ErrorEvent 的 message/filename/lineno 是唯一标着 worker 侧崩溃位置的字段，
    // 整体丢弃后只剩「线程异常」四个字，分不清是启动失败还是运行期崩、崩在哪一行。
    worker.onerror = (event: ErrorEvent) => this.handleCrash(worker, this.threadFailure(event));
    worker.onmessageerror = () =>
      this.handleCrash(
        worker,
        new AppError("BANGUMI_DATA_UNAVAILABLE", "Bangumi 数据线程消息无法解析")
      );
    return worker;
  }

  /** 线程已不可用：拒绝在途请求、回收旧线程，并按退避安排重启。 */
  private handleCrash(worker: Worker, error: AppError): void {
    if (this.worker !== worker || this.closed) return;
    this.worker = undefined;
    this.initGate = undefined;
    clearTimeout(this.stableTimer);
    worker.terminate();
    this.abort(error);
    if (!this.closing) this.scheduleRestart();
  }

  private scheduleRestart(): void {
    this.restarts += 1;
    if (this.restarts > this.recovery.maxRestarts) {
      this.broken = true;
      this.logger?.error("Bangumi 数据 Worker 连续崩溃，已停止自动重启", {
        restarts: this.restarts - 1,
      });
      this.readyDeferred?.reject(
        new AppError("BANGUMI_DATA_UNAVAILABLE", "Bangumi 数据线程反复崩溃，已停止重启")
      );
      return;
    }
    const delay = Math.min(
      this.recovery.baseDelayMs * 2 ** (this.restarts - 1),
      this.recovery.maxDelayMs
    );
    this.logger?.warn("Bangumi 数据 Worker 将重新启动", { attempt: this.restarts, delayMs: delay });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.closing) return;
      const worker = this.spawn();
      if (this.initPayload) this.beginInit(worker, this.initPayload);
    }, delay);
  }

  /** 在指定线程上发起（重放）初始化，并登记为这一代线程的就绪门。 */
  private beginInit(worker: Worker, payload: BangumiDataCall): void {
    this.initGate = this.send(payload, false).then(
      () => {
        if (this.worker !== worker) return;
        this.readyDeferred?.resolve();
        // 稳定运行满一段时间才清零：否则「起来就崩」会以最短退避无限循环。
        clearTimeout(this.stableTimer);
        this.stableTimer = setTimeout(() => {
          this.restarts = 0;
        }, this.recovery.stableMs);
        this.stableTimer.unref?.();
      },
      (error: unknown) => {
        // 线程已被替换说明是崩溃导致的拒绝，恢复由 handleCrash 负责。
        if (this.worker !== worker || this.closing) return;
        if (this.readyDeferred && !this.readyDeferred.settled) {
          this.readyDeferred.reject(error);
          return;
        }
        // 重放失败：线程没有数据却会接请求，必须当作崩溃处理，否则查询全落到未初始化的线程上。
        this.logger?.error("Bangumi 数据 Worker 重放初始化失败", { error });
        this.handleCrash(
          worker,
          new AppError("BANGUMI_DATA_UNAVAILABLE", "Bangumi 数据线程重放初始化失败")
        );
      }
    );
  }

  private handleFrame(frame: BangumiDataFrame): void {
    if (frame.type === "log") {
      this.forwardLog(frame);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (frame.ok) pending.resolve(frame.value);
    else pending.reject(this.workerFailure(frame));
  }

  /** 失败回包 → 带 worker 侧栈与 cause 的 AppError（业务码与消息口径不变）。 */
  private workerFailure(reply: Extract<BangumiDataReply, { ok: false }>): AppError {
    const error = new AppError(reply.code, reply.message, reply.error);
    applyWorkerContext(error, reply.error);
    return error;
  }

  private threadFailure(event: ErrorEvent): AppError {
    const where = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : "";
    const detail = [event.message, where].filter(Boolean).join(" @ ");
    const error = new AppError(
      "BANGUMI_DATA_UNAVAILABLE",
      detail ? `Bangumi 数据线程异常：${detail}` : "Bangumi 数据线程异常",
      { message: event.message, filename: event.filename, lineno: event.lineno, colno: event.colno }
    );
    const context = contextFromError(event.error);
    if (context) {
      error.stack = `${context.stack ?? ""}\n${WORKER_STACK_MARKER}\n${error.stack ?? ""}`;
      error.cause = reviveWorkerError(context);
    }
    // 线程崩溃没有回包可走，主线程是它唯一的观测点：不报出去就等于没发生。
    this.logger?.error("Bangumi 数据 Worker 线程崩溃", { error });
    return error;
  }

  /**
   * worker 日志桥：结构化出口只有注入的 `EventLogger` 这一个。
   * 未注入时退回 stderr（本机仍可见，但不进观测平台），所以装配处必须把它接上。
   */
  private forwardLog(frame: BangumiDataLogFrame): void {
    const message = `Bangumi 数据 Worker｜${frame.source}：${frame.message}`;
    if (!this.logger) {
      const detail = frame.error ? `（${frame.error.name}: ${frame.error.message}）` : "";
      process.stderr.write(`${message}${detail}\n`);
      return;
    }
    this.logger[frame.level](message, {
      workerSource: frame.source,
      ...(frame.error ? { error: reviveWorkerError(frame.error) } : {}),
    });
  }

  /** 初始化失败通过业务请求返回，不产生无人接收的 Promise 拒绝。 */
  init(payload: BangumiDataCall): Promise<unknown> {
    this.initPayload = payload;
    const deferred = { settled: false } as ReadyDeferred;
    const ready = new Promise<void>((resolve, reject) => {
      deferred.resolve = () => {
        deferred.settled = true;
        resolve();
      };
      deferred.reject = (error) => {
        deferred.settled = true;
        reject(error as Error);
      };
    });
    void ready.catch(() => {});
    this.readyDeferred = deferred;
    if (this.worker) this.beginInit(this.worker, payload);
    return ready;
  }

  request(payload: BangumiDataCall): Promise<unknown> {
    return this.send(payload, true);
  }

  /** `gated` 为真时，请求要等这一代线程的初始化完成后才投递（init 与 close 自己不排队）。 */
  private send(payload: BangumiDataCall, gated: boolean): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new AppError("BANGUMI_DATA_UNAVAILABLE", "Bangumi 数据服务已关闭"));
    if (this.broken)
      return Promise.reject(
        new AppError("BANGUMI_DATA_UNAVAILABLE", "Bangumi 数据线程反复崩溃，已停止重启")
      );
    const worker = this.worker;
    if (!worker)
      return Promise.reject(
        new AppError("BANGUMI_DATA_UNAVAILABLE", "Bangumi 数据线程崩溃，正在重启")
      );
    if (this.pending.size >= 64)
      return Promise.reject(
        new AppError("BANGUMI_RATE_LIMITED", "Bangumi 查询排队过多，请稍后重试")
      );
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 超时只拒绝这一个请求，不动 Worker：重建仍在后台跑完并写入 revision。
        reject(new AppError("BANGUMI_QUERY_TIMEOUT", "本地番剧查询超时"));
      }, timeoutFor(payload.method));
      this.pending.set(id, { resolve, reject, timer });
      const post = () => {
        // 排队期间若线程崩溃，请求已随 abort 落定，这里不再向新线程补发。
        if (this.pending.has(id) && this.worker === worker) worker.postMessage({ ...payload, id });
      };
      const gate = gated ? this.initGate : undefined;
      if (gate) void gate.then(post);
      else post();
    });
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.stableTimer);
    const worker = this.worker;
    try {
      // 线程已崩溃（或正在退避重启）时没有谁会回包，直接回收，不白等 close 请求的超时。
      if (worker) await this.send({ method: "close" }, false);
    } finally {
      this.closed = true;
      this.worker = undefined;
      this.abort(new AppError("BANGUMI_DATA_UNAVAILABLE", "Bangumi 数据服务已关闭"));
      worker?.terminate();
    }
  }

  private abort(error: AppError) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
