import { createApp, type AppDependencies } from "../transport/App";
import { CCBService } from "./CCBService";
import { SonGuessrService } from "./SonGuessrService";
import { createBangumiData } from "../infrastructure/CreateBangumiData";
import { BangumiProvider } from "../infrastructure/BangumiProvider";
import { FallbackBangumiProvider } from "../infrastructure/FallbackBangumiProvider";
import { NeteaseMusicProvider } from "../infrastructure/NeteaseMusicProvider";
import { BangumiImageService } from "../infrastructure/BangumiImageService";
import { QQMusicProvider } from "../infrastructure/QQMusicProvider";
import { AggregatedMusicProvider } from "../infrastructure/AggregatedMusicProvider";
import { AppError } from "../domain/Errors";
import type { Database } from "../infrastructure/db/Database";

/** 生产资源的唯一装配入口；文档与隔离路由测试不调用它。 */
export function createServer(options: Omit<AppDependencies, "sonGuessrService" | "ccbService" | "disposeResources"> & { database?: Database }) {
  const { env, logger, database, ...appOptions } = options;
  if (env.otelDeploymentEnvironment === "production" && !env.meilisearchKey) {
    throw new AppError("CONFIG_ERROR", "生产环境搜索需要 MEILISEARCH_KEY");
  }
  if (env.otelDeploymentEnvironment === "production" && !database) {
    throw new AppError("CONFIG_ERROR", "生产环境需要 DATABASE_URL");
  }
  // 猜歌与 CCB 共用同一个数据 Worker 与同一份数据集（写操作收口到单一线程，见 CreateBangumiData）。
  const data = createBangumiData({
    song: { dbPath: env.bangumiDbPath!, enrichmentPath: env.bangumiEnrichmentPath, imageBase: env.bangumiImageUrl, apiBase: env.bangumiApiUrl, meilisearch: env.meilisearchKey ? { apiKey: env.meilisearchKey } : undefined },
    ccb: { dbPath: env.bangumiDbPath!, enrichmentPath: env.bangumiEnrichmentPath, apiBase: env.bangumiApiUrl, imageBase: env.bangumiImageUrl, meilisearch: env.meilisearchKey ? { apiKey: env.meilisearchKey } : undefined },
    imagesDir: env.bangumiImagesDir,
    tagDiff: env.bangumiTagDiffUrl
      ? { diffUrl: env.bangumiTagDiffUrl, statePath: `${env.bangumiDbPath}.tagdiff.json` }
      : undefined,
    // 更新器只在显式开启（生产默认）且有上游地址时装配：E2E 与本地开发不该打线上 API。
    updater: env.bangumiUpdaterEnabled && env.bangumiApiUrl
      ? {
          base: env.bangumiApiUrl, imageSource: env.bangumiImageSource,
          minRate: env.bangumiUpdaterMinRate, maxRate: env.bangumiUpdaterMaxRate,
          playerScale: env.bangumiUpdaterPlayerScale,
        }
      : undefined,
  });
  // 自建图床读取侧：对外前缀写死 `/api/bangumi`（`Env.BANGUMI_IMAGE_ROUTE`），路径与
  // 源站一致所以业务侧的 URL 改写零改动。主线程只读分片，新抓到的图转交数据 Worker 落库（单写者）。
  const images = env.bangumiImagesDir
    ? new BangumiImageService({
        directory: env.bangumiImagesDir,
        sourceBase: env.bangumiImageSource,
        logger,
        persist: (path, image) => {
          void data.client.request({ method: "images.put", path, bytes: image.bytes })
            .catch((error: unknown) => { logger.warn("图床落库失败（本次仍正常返回）", { path, error: String(error) }); });
        },
      })
    : undefined;
  const local = data.song;
  const netease = new NeteaseMusicProvider({ logger, enableGeneralUnblock: env.enableGeneralUnblock });
  // 音乐链路预热不阻塞启动：第一位带着本机凭据进房的玩家不该替整个进程垫付接口包冷加载与首个上游建连。
  // 失败只会记一条告警，后续请求仍按惰性加载自行重试。
  void netease.warmUp();
  const qq = new QQMusicProvider({ logger });
  const music = new AggregatedMusicProvider({ neteaseProvider: netease, qqProvider: qq, logger });
  const remote = new BangumiProvider({ apiUrl: env.bangumiApiUrl, imageUrl: env.bangumiImageUrl });
  // 生产也保留回源兜底：Meilisearch / 本地数据集故障时，猜番至少还能靠官方 API 开局，
  // 而不是整局卡死（10-11 生产事故：sort 字段未声明导致搜索 400，猜番完全无法开局）。
  // 注意兜底只在**本地链路确实报错**时触发；正常路径仍走本地索引，召回与排序不受影响。
  const bangumi = new FallbackBangumiProvider({ local, remote, logger });
  const song = new SonGuessrService({ eventLogger: logger, musicProvider: music, bangumiProvider: bangumi });
  const ccb = new CCBService({ data: data.ccb, eventLogger: logger, serverUrl: env.ccbOriginalServerUrl, aesSecret: env.ccbOriginalAesSecret });
  const app = createApp({ ...appOptions, env, logger, bangumiImages: images, sonGuessrService: song, ccbService: ccb, disposeResources: async () => {
    const results = await Promise.allSettled([ccb.close(), data.client.close(), Promise.resolve().then(() => images?.close()), Promise.resolve().then(() => database?.close())]);
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "服务资源释放失败");
  } });
  return {
    ...app,
    /**
     * 把在线玩家数报给数据 Worker：更新器据此调整上游速率（没人玩就慢慢更新）。
     * 上报失败无所谓 —— 顶多这一分钟按旧速率跑。
     */
    reportBangumiLoad: (players: number): void => {
      void data.client.request({ method: "updater.reportLoad", players }).catch(() => {});
    },
  };
}
