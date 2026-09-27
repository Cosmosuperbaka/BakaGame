import { AppError } from "../domain/Errors";
import { CCBCharacterRepository } from "./CCBCharacterRepository";
import type { CCBDataInit } from "./CCBData";
import type { CCBSettings } from "../shared/CCB";

export type CCBWorkerRequest =
  | { id: number; method: "init"; options: CCBDataInit }
  | { id: number; method: "searchCharacters"; keyword: string; limit: number }
  | { id: number; method: "searchSubjects"; keyword: string; limit: number; types?: number[] }
  | { id: number; method: "getSubjectCharacters"; subjectId: number; limit: number }
  | { id: number; method: "getRawCharacter"; characterId: number }
  | { id: number; method: "getCharacter"; characterId: number; settings: CCBSettings }
  | { id: number; method: "chooseRandomCharacter"; settings: CCBSettings; rolls: number[] }
  | { id: number; method: "importDirectory"; indexId: number }
  | { id: number; method: "resolveCharacterImage"; characterId: number }
  | { id: number; method: "close" };
export type CCBWorkerReply = { id: number } & ({ ok: true; value: unknown } | { ok: false; code: string; message: string });

let repository: CCBCharacterRepository | undefined;
self.onmessage = async ({ data: request }: MessageEvent<CCBWorkerRequest>) => {
  try {
    let value: unknown;
    if (request.method === "init") {
      repository = new CCBCharacterRepository(request.options);
      await repository.initialize();
      value = true;
    } else {
      if (!repository) throw new AppError("CCB_DATA_UNAVAILABLE", "本地角色数据尚未就绪");
      switch (request.method) {
        case "searchCharacters": value = await repository.searchCharacters(request.keyword, request.limit); break;
        case "searchSubjects": value = await repository.searchSubjects(request.keyword, request.limit, request.types); break;
        case "getSubjectCharacters": value = await repository.getSubjectCharacters(request.subjectId, request.limit); break;
        case "getRawCharacter": value = await repository.getRawCharacter(request.characterId); break;
        case "getCharacter": value = await repository.getCharacter(request.characterId, request.settings); break;
        case "chooseRandomCharacter": {
          let cursor = 0;
          value = await repository.chooseRandomCharacter(request.settings, () => {
            const roll = request.rolls[cursor++];
            if (roll === undefined) throw new AppError("CCB_DATA_INVALID", "随机采样参数不完整");
            return roll;
          });
          break;
        }
        case "importDirectory": value = await repository.importDirectory(request.indexId); break;
        case "resolveCharacterImage": value = await repository.resolveCharacterImage(request.characterId); break;
        case "close": await repository.close(); repository = undefined; value = true; break;
      }
    }
    self.postMessage({ id: request.id, ok: true, value } satisfies CCBWorkerReply);
  } catch (error) {
    self.postMessage({ id: request.id, ok: false,
      code: error instanceof AppError ? error.code : "CCB_DATA_UNAVAILABLE",
      message: error instanceof AppError ? error.message : "本地角色数据读取失败",
    } satisfies CCBWorkerReply);
  }
};
