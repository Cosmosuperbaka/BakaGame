import { AppError } from "../domain/Errors";
import type { AnimeAutoFilters, BangumiSubjectDetails, BangumiSubjectSearchResult } from "../shared/Index";
import type { BangumiDataProvider } from "./LocalBangumiProvider";

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> };

export class BangumiWorkerProvider implements BangumiDataProvider {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private readonly ready: Promise<unknown>;
  private closed = false;

  constructor(songPath: string, characterPath: string, imageBase?: string, apiBase?: string) {
    this.worker = new Worker(new URL("./BangumiWorker.ts", import.meta.url).href);
    this.worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; value?: unknown; error?: { code: string; message: string } }>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new AppError(response.error!.code, response.error!.message));
    };
    this.worker.onerror = () => this.failAll(new AppError("BANGUMI_DATA_UNAVAILABLE", "本地 Bangumi 查询线程异常"));
    this.ready = this.request({ method: "init", songPath, characterPath, imageBase, apiBase });
    // 初始化失败通过业务请求返回，不产生无人接收的 Promise 拒绝。
    void this.ready.catch(() => {});
  }

  async searchSubjects(keyword: string, limit = 20, filters: AnimeAutoFilters = {}): Promise<BangumiSubjectSearchResult[]> {
    await this.ready;
    return this.request({ method: "searchSubjects", keyword, limit, filters }) as Promise<BangumiSubjectSearchResult[]>;
  }

  async getSubject(subjectId: string): Promise<BangumiSubjectDetails> {
    await this.ready;
    return this.request({ method: "getSubject", subjectId }) as Promise<BangumiSubjectDetails>;
  }

  async chooseRandomSubject(filters: AnimeAutoFilters = {}, random = Math.random): Promise<BangumiSubjectDetails> {
    const rows = await this.searchSubjects("", Math.min(filters.subjectLimit ?? 50, 50), filters);
    if (!rows.length) throw new AppError("BANGUMI_NO_SUBJECT", "选不到符合条件的番剧");
    return this.getSubject(rows[Math.min(rows.length - 1, Math.floor(random() * rows.length))].id);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new AppError("BANGUMI_DATA_UNAVAILABLE", "本地 Bangumi 查询已关闭"));
    this.worker.terminate();
  }

  private request(payload: object): Promise<unknown> {
    if (this.closed) return Promise.reject(new AppError("BANGUMI_DATA_UNAVAILABLE", "本地 Bangumi 查询已关闭"));
    if (this.pending.size >= 64) return Promise.reject(new AppError("BANGUMI_RATE_LIMITED", "Bangumi 查询排队过多，请稍后重试"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError("BANGUMI_QUERY_TIMEOUT", "本地番剧查询超时"));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ ...payload, id });
    });
  }

  private failAll(error: AppError) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
