import { AppError } from "../domain/Errors";
import type { BangumiDataReply, BangumiDataRequest } from "./BangumiDataWorker";

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> };
/**
 * 请求体（去掉由本类分配的 id）。
 *
 * `Omit` 作用在联合类型上不会分布到各成员，会把每个请求各自的字段全部抹掉，
 * 所以这里显式写成分发形式。
 */
export type BangumiDataCall = BangumiDataRequest extends infer Request
  ? Request extends { id: number } ? Omit<Request, "id"> : never
  : never;

/**
 * 初始化窗口取 CCB 那侧更长的口径（1 小时）：索���重建（首次部署或数据变更后向
 * Meilisearch 全量写入数十万文档）耗时为分钟级，必须独立于查询超时 —— 若与查询共用
 * 短窗口，ready 被拒后**所有后续查询永久失败**（猜番链路线上踩过同款坑）。
 */
const INIT_TIMEOUT_MS = 3_600_000;
/** 查询超时：索引构建期间查询会排队等待，与 CCB/猜番同取 20s。 */
const QUERY_TIMEOUT_MS = 20_000;
/** 目录导入涉及远程分页拉取，单独放宽。 */
const DIRECTORY_TIMEOUT_MS = 60_000;

const timeoutFor = (method: BangumiDataCall["method"]) => {
  if (method === "init") return INIT_TIMEOUT_MS;
  if (method === "ccb.importDirectory" || method === "close") return DIRECTORY_TIMEOUT_MS;
  return QUERY_TIMEOUT_MS;
};

/**
 * 猜歌与 CCB 共享的**同一个** Worker 进程。
 *
 * 两个 facade（`BangumiWorkerProvider` / `CCBCharacterWorkerProvider`）都通过它发请求，
 * 于是 SQLite 与 Meilisearch 的写操作收口在单一线程里天然串行。
 */
export class BangumiDataWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;

  constructor() {
    this.worker = new Worker(new URL("./BangumiDataWorker.ts", import.meta.url).href);
    this.worker.onmessage = ({ data }: MessageEvent<BangumiDataReply>) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(data.id);
      if (data.ok) pending.resolve(data.value);
      else pending.reject(new AppError(data.code, data.message));
    };
    this.worker.onerror = () => this.abort(new AppError("BANGUMI_DATA_UNAVAILABLE", "Bangumi 数据线程异常"));
  }

  /** 初始化失败通过业务请求返回，不产生无人接收的 Promise 拒绝。 */
  init(payload: BangumiDataCall): Promise<unknown> {
    const request = this.request(payload);
    void request.catch(() => {});
    return request;
  }

  request(payload: BangumiDataCall): Promise<unknown> {
    if (this.closed) return Promise.reject(new AppError("BANGUMI_DATA_UNAVAILABLE", "Bangumi 数据服务已关闭"));
    if (this.pending.size >= 64) return Promise.reject(new AppError("BANGUMI_RATE_LIMITED", "Bangumi 查询排队过多，请稍后重试"));
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
