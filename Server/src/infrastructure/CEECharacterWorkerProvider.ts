import type {
  CEECharacterSummary,
  CEECharacterView,
  CEEDirectoryResult,
  CEEImageSize,
  CEESettings,
  CEESubjectSummary,
} from "../shared/CEE";
import {
  ceeRankedTier,
  createCEERankedSettings,
  type CEERankedTierId,
} from "../shared/CEERankedValues";
import { beijingDay } from "../domain/BeijingDay";
import { isAppError } from "../domain/Errors";
import { CEE_RANKED_AIGA_OPENING_ID } from "../domain/CEERankedBot";
import { rankCEEOpenings } from "../domain/CEERankedSolver";
import type { CEERankedCandidate } from "../domain/CEERankedSolver";
import type { CEERankedPool, CEERankedPoolProvider } from "../application/CEERankedPool";
import type { CEEDataProvider, CEEDataOptions, CEERawCharacter } from "./CEEData";
import { CEECharacterRepository } from "./CEECharacterRepository";
import type { BangumiDataWorkerClient } from "./BangumiDataWorkerClient";

/** `cee.rankedPool` 的回包：题库本体与 worker 内算好的首猜排名、补充视图。 */
interface RankedPoolReply {
  candidates: CEERankedCandidate[];
  openings: CEERankedPool["openings"];
  extras: CEECharacterView[];
}

/** CEE 侧的数据门面：与猜歌共用同一个 Worker 进程（合流理由见 `BangumiDataWorker`）。 */
export class CEECharacterWorkerProvider implements CEEDataProvider, CEERankedPoolProvider {
  private readonly rankedPools = new Map<string, Promise<CEERankedPool>>();

  constructor(
    private readonly client: BangumiDataWorkerClient,
    /** 与猜歌共用的初始化 Promise：两边等的是同一次 init。 */
    private readonly ready: Promise<unknown>
  ) {}

  async searchCharacters(keyword: string, limit = 20): Promise<CEECharacterSummary[]> {
    await this.ready;
    return this.client.request({ method: "cee.searchCharacters", keyword, limit }) as Promise<
      CEECharacterSummary[]
    >;
  }
  async searchSubjects(
    keyword: string,
    limit = 20,
    types?: number[]
  ): Promise<CEESubjectSummary[]> {
    await this.ready;
    return this.client.request({ method: "cee.searchSubjects", keyword, limit, types }) as Promise<
      CEESubjectSummary[]
    >;
  }
  async getSubjectCharacters(subjectId: number, limit = 50): Promise<CEECharacterSummary[]> {
    await this.ready;
    return this.client.request({ method: "cee.getSubjectCharacters", subjectId, limit }) as Promise<
      CEECharacterSummary[]
    >;
  }
  async getSubjects(subjectIds: number[]): Promise<CEESubjectSummary[]> {
    await this.ready;
    return this.client.request({ method: "cee.getSubjects", subjectIds }) as Promise<
      CEESubjectSummary[]
    >;
  }
  async getRawCharacter(characterId: number): Promise<CEERawCharacter> {
    await this.ready;
    return this.client.request({
      method: "cee.getRawCharacter",
      characterId,
    }) as Promise<CEERawCharacter>;
  }
  async getCharacter(characterId: number, settings: CEESettings): Promise<CEECharacterView> {
    await this.ready;
    return this.client.request({
      method: "cee.getCharacter",
      characterId,
      settings,
    }) as Promise<CEECharacterView>;
  }
  async chooseRandomCharacter(
    settings: CEESettings,
    random = Math.random
  ): Promise<CEECharacterView> {
    await this.ready;
    return this.client.request({
      method: "cee.chooseRandomCharacter",
      settings,
      rolls: Array.from({ length: 4 }, () => random()),
    }) as Promise<CEECharacterView>;
  }
  /**
   * 取某档当日的排位题库。
   *
   * 按「档位 + 北京日」缓存：热度榜一天变一次，同一天里所有匹配都用同一份池，
   * 而首猜排名是池大小的平方级计算，绝不能每场重算。同一键的并发排队者共享同一个
   * Promise；失败不留缓存（下次匹配重试），换日时把该档旧键丢掉，五档最多驻留五份池。
   */
  async getRankedPool(tier: CEERankedTierId, now: number): Promise<CEERankedPool> {
    await this.ready;
    const day = beijingDay(now);
    const key = `${tier}:${day}`;
    const cached = this.rankedPools.get(key);
    if (cached) return cached;
    const settings = createCEERankedSettings(ceeRankedTier(tier), Number(day.slice(0, 4)));
    for (const stale of this.rankedPools.keys()) {
      if (!stale.endsWith(`:${day}`)) this.rankedPools.delete(stale);
    }
    const request = this.client
      .request({ method: "cee.rankedPool", settings })
      .then((value) => {
        const reply = value as RankedPoolReply;
        return { tier, settings, day, ...reply } satisfies CEERankedPool;
      })
      .catch((error: unknown) => {
        // 失败必须撤回缓存位，否则这个键当天永远拿到一个已拒绝的 Promise。
        if (this.rankedPools.get(key) === request) this.rankedPools.delete(key);
        throw error;
      });
    this.rankedPools.set(key, request);
    return request;
  }

  async importDirectory(indexId: number): Promise<CEEDirectoryResult> {
    await this.ready;
    return this.client.request({
      method: "cee.importDirectory",
      indexId,
    }) as Promise<CEEDirectoryResult>;
  }
  async resolveCharacterImage(
    characterId: number,
    size?: CEEImageSize
  ): Promise<string | undefined> {
    await this.ready;
    return this.client.request({
      method: "cee.resolveCharacterImage",
      characterId,
      size,
    }) as Promise<string | undefined>;
  }
  async resolveSubjectImage(subjectId: number, size?: CEEImageSize): Promise<string | undefined> {
    await this.ready;
    return this.client.request({ method: "cee.resolveSubjectImage", subjectId, size }) as Promise<
      string | undefined
    >;
  }

  async close(): Promise<void> {
    // Worker 由共享客户端统一关闭，门面不重复 terminate。
  }
}

/**
 * 没有 Worker 时的本地排位题库提供者（单机、离线工具与测试路径）。
 *
 * 缓存放在这个包装类上而不是 `CEECharacterRepository` 本身，是为了让契约可见：
 * **同一个实例**才共享同一份池。仓储在两侧链路里都是一次性 new 出来的，把缓存挂到
 * 仓储上等于每次都重算 —— 首猜排名是池大小的平方级计算，那样就失去缓存的意义。
 * 缓存口径与 `getRankedPool`（Worker 版）完全一致：按「档位 + 北京日」共享 Promise，
 * 失败不缓存，换日丢弃旧键。
 */
export class LocalCEERankedPoolProvider implements CEERankedPoolProvider {
  private readonly repository: CEECharacterRepository;
  private readonly pools = new Map<string, Promise<CEERankedPool>>();

  constructor(options: CEEDataOptions) {
    this.repository = new CEECharacterRepository(options);
  }

  async getRankedPool(tier: CEERankedTierId, now: number): Promise<CEERankedPool> {
    const day = beijingDay(now);
    const key = `${tier}:${day}`;
    const cached = this.pools.get(key);
    if (cached) return cached;
    const settings = createCEERankedSettings(ceeRankedTier(tier), Number(day.slice(0, 4)));
    for (const stale of this.pools.keys()) {
      if (!stale.endsWith(`:${day}`)) this.pools.delete(stale);
    }
    const request = this.repository
      .listRankedCandidates(settings)
      .then(async (candidates) => ({
        tier,
        settings,
        day,
        candidates,
        openings: rankCEEOpenings(candidates, settings),
        extras: await this.aigaOpening(settings),
      }))
      .catch((error: unknown) => {
        if (this.pools.get(key) === request) this.pools.delete(key);
        throw error;
      });
    this.pools.set(key, request);
    return request;
  }

  async close(): Promise<void> {
    await this.repository.close();
  }

  /** 丰川祥子不一定在本档题库里；数据集里没有她就退化为无补充视图，其它错误照抛（与 Worker 版同口径）。 */
  private async aigaOpening(settings: CEESettings): Promise<CEECharacterView[]> {
    try {
      return [await this.repository.getCharacter(CEE_RANKED_AIGA_OPENING_ID, settings)];
    } catch (error) {
      if (isAppError(error) && error.code === "CEE_CHARACTER_NOT_FOUND") return [];
      throw error;
    }
  }
}
