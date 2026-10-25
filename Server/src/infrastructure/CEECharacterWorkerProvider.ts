import type {
  CEECharacterSummary,
  CEECharacterView,
  CEEDirectoryResult,
  CEEImageSize,
  CEESettings,
  CEESubjectSummary,
} from "../shared/CEE";
import type { CEEDataProvider, CEERawCharacter } from "./CEEData";
import type { BangumiDataWorkerClient } from "./BangumiDataWorkerClient";

/** CEE 侧的数据门面：与猜歌共用同一个 Worker 进程（合流理由见 `BangumiDataWorker`）。 */
export class CEECharacterWorkerProvider implements CEEDataProvider {
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
