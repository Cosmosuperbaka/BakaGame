import { AppError } from "../domain/Errors";
import type { CCBCharacterSummary, CCBCharacterView, CCBDirectoryResult, CCBSettings, CCBSubjectSummary } from "../shared/CCB";
import type { CCBDataInit, CCBDataProvider, CCBRawCharacter } from "./CCBData";
import type { CCBWorkerReply, CCBWorkerRequest } from "./CCBCharacterWorker";

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> };
type Payload = CCBWorkerRequest extends infer Request ? Request extends { id: number } ? Omit<Request, "id"> : never : never;

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
      const timer = setTimeout(() => this.abort(new AppError("CCB_QUERY_TIMEOUT", "角色资料查询超时")), payload.method === "importDirectory" || payload.method === "close" ? 60_000 : 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ ...payload, id });
    });
  }

  private abort(error: AppError): void {
    this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.worker.terminate();
  }
}
