import { createApp, type AppDependencies } from "../transport/App";
import { CCBService } from "./CCBService";
import { SonGuessrService } from "./SonGuessrService";
import { BangumiWorkerProvider } from "../infrastructure/BangumiWorkerProvider";
import { BangumiProvider } from "../infrastructure/BangumiProvider";
import { FallbackBangumiProvider } from "../infrastructure/FallbackBangumiProvider";
import { CCBCharacterWorkerProvider } from "../infrastructure/CCBCharacterWorkerProvider";
import { NeteaseMusicProvider } from "../infrastructure/NeteaseMusicProvider";
import { AppError } from "../domain/Errors";

/** 生产资源的唯一装配入口；文档与隔离路由测试不调用它。 */
export function createServer(options: Omit<AppDependencies, "sonGuessrService" | "ccbService" | "disposeResources">) {
  const { env, logger } = options;
  if (env.otelDeploymentEnvironment === "production" && !env.meilisearchKey) {
    throw new AppError("CONFIG_ERROR", "生产环境搜索需要 MEILISEARCH_KEY");
  }
  const local = new BangumiWorkerProvider({ songPath: env.bangumiSongDbPath!, characterPath: env.bangumiCharacterDbPath!, enrichmentPath: env.bangumiEnrichmentPath, imageBase: env.bangumiImageUrl, apiBase: env.bangumiApiUrl, meilisearch: env.meilisearchKey ? { apiKey: env.meilisearchKey } : undefined });
  const music = new NeteaseMusicProvider({ logger, enableGeneralUnblock: env.enableGeneralUnblock });
  // 音乐链路预热不阻塞启动：第一位带着本机凭据进房的玩家不该替整个进程垫付接口包冷加载与首个上游建连。
  // 失败只会记一条告警，后续请求仍按惰性加载自行重试。
  void music.warmUp();
  const song = new SonGuessrService({ eventLogger: logger, musicProvider: music, bangumiProvider: new FallbackBangumiProvider({ local, remote: new BangumiProvider({ apiUrl: env.bangumiApiUrl, imageUrl: env.bangumiImageUrl }), logger }) });
  const ccb = new CCBService({ data: new CCBCharacterWorkerProvider({
    characterPath: env.bangumiCharacterDbPath!, enrichmentPath: env.bangumiEnrichmentPath,
    apiBase: env.bangumiApiUrl, imageBase: env.bangumiImageUrl,
    meilisearch: env.meilisearchKey ? { apiKey: env.meilisearchKey } : undefined,
  }), eventLogger: logger, serverUrl: env.ccbOriginalServerUrl, aesSecret: env.ccbOriginalAesSecret });
  return createApp({ ...options, sonGuessrService: song, ccbService: ccb, disposeResources: async () => {
    const results = await Promise.allSettled([ccb.close(), local.close()]);
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "服务资源释放失败");
  } });
}
