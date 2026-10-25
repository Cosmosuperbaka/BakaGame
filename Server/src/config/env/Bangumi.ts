import { resolve } from "node:path";

/**
 * 图床对外前缀：**写死，不提供环境变量开关**。
 *
 * 挂在 `/api` 下是刻意的：后端新增路径必须落在前端托管不会吞掉的前缀里，
 * 否则请求到不了源站，`<img>` 就是裂图。口径见 `Agents/Deployment.md` §2。
 */
const BANGUMI_IMAGE_ROUTE = "/api/bangumi";

/** 搜索服务的回环缺省地址：独立部署时由 `MEILISEARCH_URL` 覆盖为对本进程可达的地址。 */
const DEFAULT_MEILISEARCH_URL = "http://127.0.0.1:7700";

/**
 * 数据集、图床与搜索（T2）：每一项都有正确缺省，只在特殊部署形态下才需要覆盖。
 * 分层口径见 `Agents/Conventions.md` §5。
 */
export interface EnvBangumi {
  bangumiApiUrl: string;
  /**
   * 对外图片前缀：恒为 `/api/bangumi`，即自建图床。
   *
   * 路径与 Bangumi 源站一致，所以 URL 改写逻辑零改动；不提供环境变量开关 ——
   * 前缀一旦可配，就必然有人配出边缘不放行的路径（线上踩过一次，整站图片变
   * SPA HTML）。详见 `Server/docs/BangumiApi.md`。
   */
  bangumiImageUrl: string;
  /**
   * 图床回源前缀：`/api/bangumi` 缺失时从这里抓 avif。
   *
   * 必须能与 Bangumi 的图床路径（`/pic/cover/...`、`/r/200/...`）拼接，且支持
   * `Accept: image/avif`。**缺省为空**（只服务已缓存的图）：对外前缀是相对路径，
   * 跟着它回源会变成自己回自己的死循环。需要缺图自愈时才配，仓库里不落任何远端地址。
   */
  bangumiImageSource?: string;
  /** 本地数据集路径：猜歌与 CEE 共用同一个库。 */
  bangumiDbPath?: string;
  /**
   * 本进程是不是数据集的**唯一写者**。多进程分片时只有主片为 true：数据集是单一可写文件，
   * 跨进程并发写会互相等锁，而每日备份的 `VACUUM INTO` 与更新器落库还会互相踩。
   * 为 false 时数据集以只读打开，且更新器/备份/新条目发现全部不装配（见 `BangumiDataWorker`）。
   */
  bangumiDatasetWriter?: boolean;
  /** 自建图床分片目录（`/api/bangumi` 路由与更新器共用）；缺省跟随数据集目录。 */
  bangumiImagesDir?: string;
  /** 运行时更新器（阶段 6）：缺省只在生产开启。 */
  bangumiUpdaterEnabled?: boolean;
  /**
   * 更新器速率下限/上限与生效所需玩家数：装配 Worker 时定一次。
   * 速率本身随在线人数在区间内自适应（`SubjectUpdater.currentRate`），所以这几个是
   * **调好就基本不动**的部署参数，不做热更（要改的是 Worker 装配，不是运行中的循环）。
   */
  bangumiUpdaterMinRate?: number;
  bangumiUpdaterMaxRate?: number;
  bangumiUpdaterPlayerScale?: number;
  /**
   * CCB-TagsCI 的角色标签增量地址；**不给就不跑增量同步**（不配 = 不拉）。
   *
   * 上游并不保证这条产物长期存在（仓库 `outputs/` 下只稳定发布 `id_tags.js` /
   * `id_tags.json`，diff 产物会随 CI 调整消失），写死默认地址只会在每次启动后
   * 打一条连不上的告警，所以这里留空由运维按当时可用的地址显式开启。
   */
  bangumiTagDiffUrl?: string;
  /** Bangumi API 回填缓存（可写）。只读数据集不能落盘，这里存 API 取到的补充字段。 */
  bangumiEnrichmentPath?: string;
  /** 搜索服务地址：未配置时调用方取回环缺省，要求搜索服务与本进程在同一网络命名空间。 */
  meilisearchUrl?: string;
  meilisearchKey?: string;
}

const resolveDefaultBangumiEnrichmentPath = (): string => {
  if (Bun.env.BANGUMI_ENRICHMENT_PATH) {
    return resolve(process.cwd(), Bun.env.BANGUMI_ENRICHMENT_PATH);
  }
  // 放 Server/storage：可写、不进 Git、不参与部署产物。
  return resolve(import.meta.dir, "../../../storage/bangumi-enrichment.sqlite");
};

export const readBangumiEnv = (deploymentEnvironment: string): EnvBangumi => ({
  bangumiApiUrl: (Bun.env.BANGUMI_API_URL ?? "https://api.bgm.tv").replace(/\/+$/, ""),
  bangumiImageUrl: BANGUMI_IMAGE_ROUTE,
  // 回源没有缺省值：对外前缀是相对路径的 `/api/bangumi`，跟它回源就是自己回自己。
  bangumiImageSource: (Bun.env.BANGUMI_IMAGE_SOURCE ?? "").replace(/\/+$/, ""),
  // 分片部署下每片可以指向各自的副本（多进程共写一份库会等锁）；缺省仍是单进程那一份。
  // 相对路径按工作目录解析，与 `BANGUMI_ENRICHMENT_PATH` 同一口径。
  bangumiDbPath: Bun.env.BANGUMI_DB_PATH?.trim()
    ? resolve(process.cwd(), Bun.env.BANGUMI_DB_PATH.trim())
    : resolve(import.meta.dir, "../../../data/bangumi.sqlite"),
  // 默认可写（维持单进程与现有部署的行为）；只有显式 `=false` 的片才退成只读读取者。
  bangumiDatasetWriter: Bun.env.BANGUMI_DATASET_WRITER !== "false",
  bangumiImagesDir: Bun.env.BANGUMI_IMAGES_DIR
    ? resolve(Bun.env.BANGUMI_IMAGES_DIR)
    : resolve(import.meta.dir, "../../../data/images"),
  // 运行时更新器默认只在生产开启：E2E / 测试与本地开发不该打在线上上游。
  bangumiUpdaterEnabled:
    Bun.env.BANGUMI_UPDATER_ENABLED !== undefined
      ? Bun.env.BANGUMI_UPDATER_ENABLED === "true"
      : deploymentEnvironment === "production",
  bangumiUpdaterMinRate: Number(Bun.env.BANGUMI_UPDATER_MIN_RATE ?? 10),
  bangumiUpdaterMaxRate: Number(Bun.env.BANGUMI_UPDATER_MAX_RATE ?? 100),
  bangumiUpdaterPlayerScale: Number(Bun.env.BANGUMI_UPDATER_PLAYER_SCALE ?? 20),
  // 不配就不跑：上游 diff 产物并不长期存在（仓库只稳定发布 id_tags.js / id_tags.json），
  // 写死默认地址只会让每次启动都报「连不上」。
  bangumiTagDiffUrl: Bun.env.BANGUMI_TAG_DIFF_URL?.trim() || undefined,
  bangumiEnrichmentPath: resolveDefaultBangumiEnrichmentPath(),
  // 容器部署时 Meilisearch 可能与 app 不在同一网络命名空间（回环地址不通）：
  // 用 MEILISEARCH_URL 覆盖为容器可达地址。
  meilisearchUrl: (Bun.env.MEILISEARCH_URL?.trim() || DEFAULT_MEILISEARCH_URL).replace(/\/+$/, ""),
  meilisearchKey: Bun.env.MEILISEARCH_KEY?.trim() || undefined,
});
