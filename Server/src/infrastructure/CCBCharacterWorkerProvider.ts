import { AppError } from "../domain/Errors";
import type { CCBCharacterSummary, CCBCharacterView, CCBDirectoryResult, CCBSettings, CCBSubjectSummary } from "../shared/CCB";
import type { CCBDataInit, CCBDataProvider, CCBRawCharacter } from "./CCBData";
import type { CCBWorkerReply, CCBWorkerRequest } from "./CCBCharacterWorker";

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> };
type Payload = CCBWorkerRequest extends infer Request ? Request extends { id: number } ? Omit<Request, "id"> : never : never;

/**
 * 初始化超时：索引重建（首次部署或数据变更后向 Meilisearch 全量写入数十万文档）
 * 耗时为分钟级（线上实测全量重建约 19 分钟），必须独立于查询超时且留足余量——
 * 若与查询共用短窗口，ready 被拒后**所有后续查询永久失败**（猜番链路线上踩过
 * 同款坑，见 BangumiWorkerProvider 注释）。窗口取 1 小时，覆盖数据量继续增长后的重建。
 */
const INIT_TIMEOUT_MS = 3_600_000;
/** 查询超时：Meilisearch 索引构建期间查询会排队等待，与猜番查询同取 20s。 */
const QUERY_TIMEOUT_MS = 20_000;
/** 目录导入与关闭涉及远程拉取和收尾，单独放宽。 */
const DIRECTORY_TIMEOUT_MS = 60_000;

export class CCBCharacterWorkerProvider implements CCBDataProvider {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private readonly ready: Promise<unknown>;
  private nextId = 0;
  private closed = false;

  constructor(options: CCBDataInit) {
    this.worker = new Worker(new URL("./CCBCharacterWorker.ts", import.meta.url).href);
    this.worker.onmessage = ({ data }: MessageEvent<CCBWorkerReply>) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(data.id);
      if (data.ok) pending.resolve(data.value);
      else pending.reject(new AppError(data.code, data.message));
    };
    this.worker.onerror = () => this.abort(new AppError("CCB_DATA_UNAVAILABLE", "角色查询线程异常"));
    this.ready = this.request({ method: "init", options });
    void this.ready.catch(() => {});
  }

  async searchCharacters(keyword: string, limit = 20): Promise<CCBCharacterSummary[]> {
    await this.ready;
    return this.request({ method: "searchCharacters", keyword, limit }) as Promise<CCBCharacterSummary[]>;
  }
  async searchSubjects(keyword: string, limit = 20, types?: number[]): Promise<CCBSubjectSummary[]> {
    await this.ready;
    return this.request({ method: "searchSubjects", keyword, limit, types }) as Promise<CCBSubjectSummary[]>;
  }
  async getSubjectCharacters(subjectId: number, limit = 50): Promise<CCBCharacterSummary[]> {
    await this.ready;
    return this.request({ method: "getSubjectCharacters", subjectId, limit }) as Promise<CCBCharacterSummary[]>;
  }
  async getSubjects(subjectIds: number[]): Promise<CCBSubjectSummary[]> {
    await this.ready;
    return this.request({ method: "getSubjects", subjectIds }) as Promise<CCBSubjectSummary[]>;
  }
  async getRawCharacter(characterId: number): Promise<CCBRawCharacter> {
    await this.ready;
    return this.request({ method: "getRawCharacter", characterId }) as Promise<CCBRawCharacter>;
  }
  async getCharacter(characterId: number, settings: CCBSettings): Promise<CCBCharacterView> {
    await this.ready;
    return this.request({ method: "getCharacter", characterId, settings }) as Promise<CCBCharacterView>;
  }
  async chooseRandomCharacter(settings: CCBSettings, random = Math.random): Promise<CCBCharacterView> {
    await this.ready;
    return this.request({ method: "chooseRandomCharacter", settings, rolls: Array.from({ length: 4 }, () => random()) }) as Promise<CCBCharacterView>;
  }
  async importDirectory(indexId: number): Promise<CCBDirectoryResult> {
    await this.ready;
    return this.request({ method: "importDirectory", indexId }) as Promise<CCBDirectoryResult>;
  }
  async resolveCharacterImage(characterId: number): Promise<string | undefined> {
    await this.ready;
    return this.request({ method: "resolveCharacterImage", characterId }) as Promise<string | undefined>;
  }
  async resolveSubjectImage(subjectId: number): Promise<string | undefined> {
    await this.ready;
    return this.request({ method: "resolveSubjectImage", subjectId }) as Promise<string | undefined>;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.ready;
      await this.request({ method: "close" });
    } finally {
      this.abort(new AppError("CCB_DATA_UNAVAILABLE", "本地角色查询已关闭"));
    }
  }

  private request(payload: Payload): Promise<unknown> {
    if (this.closed) return Promise.reject(new AppError("CCB_DATA_UNAVAILABLE", "本地角色查询已关闭"));
    if (this.pending.size >= 64) return Promise.reject(new AppError("CCB_RATE_LIMITED", "角色查询排队过多，请稍后重试"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = payload.method === "init" ? INIT_TIMEOUT_MS : payload.method === "importDirectory" || payload.method === "close" ? DIRECTORY_TIMEOUT_MS : QUERY_TIMEOUT_MS;
      const timer = setTimeout(() => {
        // 超时只拒绝该请求本身，不终止线程（对齐 BangumiWorkerProvider）：重建等分钟级任务
        // 若因临界超时被升级为全局 abort，ready 被拒后所有查询永久失败且版本标记永远写不上，
        // 每次重启都会重复整场重建——线上事故根因即此。线程存活则重建照常跑完并落标记，
        // 下次启动跳过重建自愈。
        this.pending.delete(id);
        reject(new AppError("CCB_QUERY_TIMEOUT", "角色资料查询超时"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ ...payload, id });
    });
  }

  /** 终止线程并拒绝所有挂起请求；仅用于线程异常与关闭，普通查询超时绝不走这里。 */
  private abort(error: AppError): void {
    this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.worker.terminate();
  }
}
