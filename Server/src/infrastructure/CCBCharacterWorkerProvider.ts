import type { CCBCharacterSummary, CCBCharacterView, CCBDirectoryResult, CCBImageSize, CCBSettings, CCBSubjectSummary } from "../shared/CCB";
import type { CCBDataProvider, CCBRawCharacter } from "./CCBData";
import type { BangumiDataWorkerClient } from "./BangumiDataWorkerClient";

/**
 * CCB 侧的数据门面：与猜歌共用同一个 Worker 进程（见 `BangumiDataWorkerClient`）。
 *
 * 曾经这里自己起一个 `CCBCharacterWorker`。数据集改为可写后，两个进程同写一个库文件
 * 会出现写写冲突，所以收口到共享 Worker，写操作天然串行。
 */
export class CCBCharacterWorkerProvider implements CCBDataProvider {
  constructor(
    private readonly client: BangumiDataWorkerClient,
    /** 与猜歌共用的初始化 Promise：两边等的是同一次 init。 */
    private readonly ready: Promise<unknown>,
  ) {}

  async searchCharacters(keyword: string, limit = 20): Promise<CCBCharacterSummary[]> {
    await this.ready;
    return this.client.request({ method: "ccb.searchCharacters", keyword, limit }) as Promise<CCBCharacterSummary[]>;
  }
  async searchSubjects(keyword: string, limit = 20, types?: number[]): Promise<CCBSubjectSummary[]> {
    await this.ready;
    return this.client.request({ method: "ccb.searchSubjects", keyword, limit, types }) as Promise<CCBSubjectSummary[]>;
  }
  async getSubjectCharacters(subjectId: number, limit = 50): Promise<CCBCharacterSummary[]> {
    await this.ready;
    return this.client.request({ method: "ccb.getSubjectCharacters", subjectId, limit }) as Promise<CCBCharacterSummary[]>;
  }
  async getSubjects(subjectIds: number[]): Promise<CCBSubjectSummary[]> {
    await this.ready;
    return this.client.request({ method: "ccb.getSubjects", subjectIds }) as Promise<CCBSubjectSummary[]>;
  }
  async getRawCharacter(characterId: number): Promise<CCBRawCharacter> {
    await this.ready;
    return this.client.request({ method: "ccb.getRawCharacter", characterId }) as Promise<CCBRawCharacter>;
  }
  async getCharacter(characterId: number, settings: CCBSettings): Promise<CCBCharacterView> {
    await this.ready;
    return this.client.request({ method: "ccb.getCharacter", characterId, settings }) as Promise<CCBCharacterView>;
  }
  async chooseRandomCharacter(settings: CCBSettings, random = Math.random): Promise<CCBCharacterView> {
    await this.ready;
    return this.client.request({ method: "ccb.chooseRandomCharacter", settings, rolls: Array.from({ length: 4 }, () => random()) }) as Promise<CCBCharacterView>;
  }
  async importDirectory(indexId: number): Promise<CCBDirectoryResult> {
    await this.ready;
    return this.client.request({ method: "ccb.importDirectory", indexId }) as Promise<CCBDirectoryResult>;
  }
  async resolveCharacterImage(characterId: number, size?: CCBImageSize): Promise<string | undefined> {
    await this.ready;
    return this.client.request({ method: "ccb.resolveCharacterImage", characterId, size }) as Promise<string | undefined>;
  }
  async resolveSubjectImage(subjectId: number, size?: CCBImageSize): Promise<string | undefined> {
    await this.ready;
    return this.client.request({ method: "ccb.resolveSubjectImage", subjectId, size }) as Promise<string | undefined>;
  }

  async close(): Promise<void> {
    // Worker 由共享客户端统一关闭，门面不重复 terminate。
  }
}
