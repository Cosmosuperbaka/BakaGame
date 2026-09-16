import { LocalBangumiProvider } from "./LocalBangumiProvider";
import { AppError } from "../domain/Errors";
import type { AnimeAutoFilters } from "../shared/Index";
import type { BangumiProviderInit } from "./LocalBangumiProvider";

type Request =
  | { id: number; method: "init"; options: BangumiProviderInit }
  | { id: number; method: "searchSubjects"; keyword: string; limit?: number; filters?: AnimeAutoFilters }
  | { id: number; method: "getSubject"; subjectId: string }
  | { id: number; method: "resolveCharacterImage"; characterId: number }
  | { id: number; method: "close" };

let provider: LocalBangumiProvider | undefined;
self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    let value: unknown;
    if (request.method === "init") {
      provider = new LocalBangumiProvider(request.options);
      value = true;
    } else if (!provider) {
      throw new AppError("BANGUMI_DATA_UNAVAILABLE", "本地 Bangumi 数据尚未就绪");
    } else if (request.method === "searchSubjects") {
      value = await provider.searchSubjects(request.keyword, request.limit, request.filters);
    } else if (request.method === "getSubject") {
      value = await provider.getSubject(request.subjectId);
    } else if (request.method === "resolveCharacterImage") {
      value = await provider.resolveCharacterImage(request.characterId);
    } else {
      provider.close();
      provider = undefined;
      value = true;
    }
    self.postMessage({ id: request.id, ok: true, value });
  } catch (error) {
    console.error("Bangumi worker query failed", error);
    self.postMessage({ id: request.id, ok: false, error: error instanceof AppError
      ? { code: error.code, message: error.message }
      : { code: "BANGUMI_DATA_UNAVAILABLE", message: "本地 Bangumi 数据读取失败" } });
  }
};
