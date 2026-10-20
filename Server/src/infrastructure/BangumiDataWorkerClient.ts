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

/**
 * 猜歌与 CEE 共享的**同一个** Worker 进程。
 *
 * 两个 facade（`BangumiWorkerProvider` / `CEECharacterWorkerProvider`）都通过它发请求，
 * 于是 SQLite 与 Meilisearch 的写操作收口在单一线程里天然串行。
 */
export class BangumiDataWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;

  constructor(private readonly logger?: BangumiWorkerLogger) {
    this.worker = new Worker(new URL("./BangumiDataWorker.ts", import.meta.url).href);
    this.worker.onmessage = ({ data }: MessageEvent<BangumiDataFrame>) => this.handleFrame(data);
    // ErrorEvent 的 message/filename/lineno 是唯一标着 worker 侧崩溃位置的字段，
    // 整体丢弃后只剩「线程异常」四个字，分不清是启动失败还是运行期崩、崩在哪一行。
    this.worker.onerror = (event: ErrorEvent) => this.abort(this.threadFailure(event));
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
    const request = this.request(payload);
    void request.catch(() => {});
    return request;
  }

  request(payload: BangumiDataCall): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new AppError("BANGUMI_DATA_UNAVAILABLE", "Bangumi 数据服务已关闭"));
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
      this.worker.postMessage({ ...payload, id });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      // 必须在置 closed 之前发：request 见到 closed 会直接拒绝。
      await this.request({ method: "close" });
    } finally {
      this.closed = true;
      this.abort(new AppError("BANGUMI_DATA_UNAVAILABLE", "Bangumi 数据服务已关闭"));
      this.worker.terminate();
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
