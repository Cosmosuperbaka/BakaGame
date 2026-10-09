import { createApp, type AppDependencies } from "../transport/App";
import { CCBService } from "./CCBService";
import { SonGuessrService } from "./SonGuessrService";
import { createBangumiData } from "../infrastructure/CreateBangumiData";
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
  // 猜歌与 CCB 共用同一个数据 Worker（写操作收口到单一线程，见 CreateBangumiData）。
  const data = createBangumiData({
    song: { songPath: env.bangumiSongDbPath!, characterPath: env.bangumiCharacterDbPath!, enrichmentPath: env.bangumiEnrichmentPath, imageBase: env.bangumiImageUrl, apiBase: env.bangumiApiUrl, meilisearch: env.meilisearchKey ? { apiKey: env.meilisearchKey } : undefined },
    ccb: { characterPath: env.bangumiCharacterDbPath!, enrichmentPath: env.bangumiEnrichmentPath, apiBase: env.bangumiApiUrl, imageBase: env.bangumiImageUrl, meilisearch: env.meilisearchKey ? { apiKey: env.meilisearchKey } : undefined },
  });
  const local = data.song;
  const music = new NeteaseMusicProvider({ logger, enableGeneralUnblock: env.enableGeneralUnblock });
  // 音乐链路预热不阻塞启动：第一位带着本机凭据进房的玩家不该替整个进程垫付接口包冷加载与首个上游建连。
  // 失败只会记一条告警，后续请求仍按惰性加载自行重试。
  void music.warmUp();
  const remote = new BangumiProvider({ apiUrl: env.bangumiApiUrl, imageUrl: env.bangumiImageUrl });
  // 生产启用 Meilisearch 时必须保持本地索引的确定性排序；搜索服务故障应显式暴露，
  // 不能静默切换到官方 API 的另一套召回和排序。未配置密钥的本地开发仍保留回源能力。
  const bangumi = env.meilisearchKey ? local : new FallbackBangumiProvider({ local, remote, logger });
  const song = new SonGuessrService({ eventLogger: logger, musicProvider: music, bangumiProvider: bangumi });
  const ccb = new CCBService({ data: data.ccb, eventLogger: logger, serverUrl: env.ccbOriginalServerUrl, aesSecret: env.ccbOriginalAesSecret });
  return createApp({ ...options, sonGuessrService: song, ccbService: ccb, disposeResources: async () => {
    const results = await Promise.allSettled([ccb.close(), data.client.close()]);
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "服务资源释放失败");
  } });
}
