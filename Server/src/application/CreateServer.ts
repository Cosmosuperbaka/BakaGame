import { createApp, type AppDependencies } from "../transport/App";
import { CEEService } from "./CEEService";
import { SonGuessrService } from "./SonGuessrService";
import { createBangumiData } from "../infrastructure/CreateBangumiData";
import { StatusHistoryStore } from "../infrastructure/StatusHistoryStore";
import { StatusSampleStore } from "../infrastructure/StatusSampleStore";
import { BangumiProvider } from "../infrastructure/BangumiProvider";
import { FallbackBangumiProvider } from "../infrastructure/FallbackBangumiProvider";
import { NeteaseMusicProvider } from "../infrastructure/NeteaseMusicProvider";
import { BangumiImageService } from "../infrastructure/BangumiImageService";
import { QQMusicProvider } from "../infrastructure/QQMusicProvider";
import { AggregatedMusicProvider } from "../infrastructure/AggregatedMusicProvider";
import { AppError } from "../domain/Errors";
import type { Database } from "../infrastructure/db/Database";
import * as schema from "../infrastructure/db/Schema";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuth } from "../infrastructure/auth/Auth";
import { createMailer } from "../infrastructure/auth/Mailer";
import { QQAvatarService } from "../infrastructure/auth/QQAvatar";
import { QQNapCatClient } from "../infrastructure/auth/QQNapCatClient";
import { QQNicknameService } from "./QQNicknameService";
import { AccountService } from "./AccountService";
import type { GameRecordService } from "./GameRecordService";
import { UserDataService } from "./UserDataService";
import { AdminService } from "./AdminService";
import { AppSettings } from "./AppSettings";
import { DatabaseAppSettingRepository } from "../infrastructure/db/AppSettingRepository";
import { SiteStatsService } from "./SiteStatsService";
import { DatabaseSiteStatsRepository } from "../infrastructure/db/SiteStatsRepository";
import { deriveSentryApiConfig, SentryApiClient } from "../infrastructure/SentryApi";
import { DatabaseAuditLogRepository } from "../infrastructure/db/AuditLogRepository";
import { DatabaseBadgeRepository } from "../infrastructure/db/BadgeRepository";
import { DatabaseRegistrationRepository } from "../infrastructure/db/RegistrationRepository";
import { DatabaseGameRecordRepository } from "../infrastructure/db/GameRecordRepository";
import { DatabaseStatusEventRepository } from "../infrastructure/db/StatusEventRepository";
import { AntiCheatReviewRepository } from "../infrastructure/db/AntiCheatReviewRepository";
import { InMemoryAntiCheatReviewQueue, type CEEAntiCheatReviewBoard } from "./CEEAntiCheatSignals";
import { createAndroidAttestationChecker } from "../infrastructure/AndroidAttestation";
import { ClientChannel, InMemoryClientChannelStore } from "../infrastructure/ClientChannel";
import { ClientArtifacts } from "../infrastructure/ClientArtifacts";
import { ClientChannelRepository } from "../infrastructure/db/ClientChannelRepository";
import { SettingCipher } from "../infrastructure/auth/SettingCipher";
import {
  DatabaseFeedbackRepository,
  DatabaseUserSettingRepository,
} from "../infrastructure/db/UserDataRepository";
import { captureServerFeedback } from "../infrastructure/Sentry";
import { isAllowedOrigin } from "../transport/App";
import type { AppEnv } from "../config/Env";
import type { EventLogger } from "../infrastructure/EventLogger";
import type { AdminRoomControl } from "../domain/AdminRoom";
import type { RecordedGame } from "../domain/GameRecord";

/** 生产资源的唯一装配入口；文档与隔离路由测试不调用它。 */
export function createServer(
  options: Omit<AppDependencies, "sonGuessrService" | "ceeService" | "disposeResources"> & {
    database?: Database;
    gameRecords?: GameRecordService;
  }
) {
  const { env, logger, database, gameRecords, ...appOptions } = options;
  if (env.otelDeploymentEnvironment === "production" && !env.meilisearchKey) {
    throw new AppError("CONFIG_ERROR", "生产环境搜索需要 MEILISEARCH_KEY");
  }
  if (env.otelDeploymentEnvironment === "production" && !database) {
    throw new AppError("CONFIG_ERROR", "生产环境需要 DATABASE_URL");
  }
  if (env.otelDeploymentEnvironment === "production" && env.account?.mail.kind !== "smtp") {
    throw new AppError(
      "CONFIG_ERROR",
      "生产环境账号系统需要 SMTP_HOST / SMTP_USER / SMTP_PASS（且不得启用 MAIL_DEV_CONSOLE）"
    );
  }
  // 猜歌与 CEE 共用同一个数据 Worker 与同一份数据集（写操作收口到单一线程，见 CreateBangumiData）。
  // 多进程分片：只有主片（`BANGUMI_DATASET_WRITER` 未设或为 true）以可写打开数据集，
  // 其余片传 readonly —— 数据集是单一可写文件，跨进程写会等锁，备份与更新器还会互踩。
  const datasetReadonly = env.bangumiDatasetWriter === false;
  const data = createBangumiData({
    song: {
      dbPath: env.bangumiDbPath!,
      readonly: datasetReadonly,
      enrichmentPath: env.bangumiEnrichmentPath,
      imageBase: env.bangumiImageUrl,
      apiBase: env.bangumiApiUrl,
      meilisearch: env.meilisearchKey
        ? { apiKey: env.meilisearchKey, host: env.meilisearchUrl }
        : undefined,
    },
    cee: {
      dbPath: env.bangumiDbPath!,
      readonly: datasetReadonly,
      enrichmentPath: env.bangumiEnrichmentPath,
      apiBase: env.bangumiApiUrl,
      imageBase: env.bangumiImageUrl,
      meilisearch: env.meilisearchKey
        ? { apiKey: env.meilisearchKey, host: env.meilisearchUrl }
        : undefined,
    },
    imagesDir: env.bangumiImagesDir,
    tagDiff: env.bangumiTagDiffUrl
      ? { diffUrl: env.bangumiTagDiffUrl, statePath: `${env.bangumiDbPath}.tagdiff.json` }
      : undefined,
    // 更新器只在显式开启（生产默认）、有上游地址、且本进程是数据集写者时装配：
    // E2E 与本地开发不该打线上 API；非写者片装了就会去写只读连接，必然报 SQLITE_READONLY。
    updater:
      env.bangumiUpdaterEnabled && !datasetReadonly && env.bangumiApiUrl
        ? {
            base: env.bangumiApiUrl,
            imageSource: env.bangumiImageSource,
            minRate: env.bangumiUpdaterMinRate,
            maxRate: env.bangumiUpdaterMaxRate,
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
          void data.client
            .request({ method: "images.put", path, bytes: image.bytes })
            .catch((error: unknown) => {
              logger.warn("图床落库失败（本次仍正常返回）", { path, error: String(error) });
            });
        },
      })
    : undefined;
  // 运行期旋钮（T3）：值存 app_setting，环境变量项退成缺省。没有数据库时这里不接仓储，
  // 快照永远是缺省值，行为与引入本表之前逐字一致。
  const settings = new AppSettings({
    repository: database ? new DatabaseAppSettingRepository(database) : undefined,
    defaults: env,
    logger,
  });
  const local = data.song;
  const netease = new NeteaseMusicProvider({
    logger,
    // 同步取内存快照：解灰开关走 T3 运行期设置，没有库时快照就是环境变量缺省。
    enableGeneralUnblock: () => settings.boolean("enableGeneralUnblock"),
  });
  // 音乐链路预热不阻塞启动：第一位带着本机凭据进房的玩家不该替整个进程垫付接口包冷加载与首个上游建连。
  // 失败只会记一条告警，后续请求仍按惰性加载自行重试。
  void netease.warmUp();
  const qq = new QQMusicProvider({ logger });
  const music = new AggregatedMusicProvider({
    neteaseProvider: netease,
    qqProvider: qq,
    logger,
    allowAnonymousQqSearch: () => settings.boolean("enableAnonymousQqSearch"),
  });
  const remote = new BangumiProvider({ apiUrl: env.bangumiApiUrl, imageUrl: env.bangumiImageUrl });
  // 生产也保留回源兜底：Meilisearch / 本地数据集故障时，猜番至少还能靠官方 API 开局，
  // 而不是整局卡死（10-11 生产事故：sort 字段未声明导致搜索 400，猜番完全无法开局）。
  // 注意兜底只在**本地链路确实报错**时触发；正常路径仍走本地索引，召回与排序不受影响。
  const bangumi = new FallbackBangumiProvider({ local, remote, logger });
  const song = new SonGuessrService({
    eventLogger: logger,
    musicProvider: music,
    bangumiProvider: bangumi,
    gameRecorder: gameRecords,
  });
  const antiCheatReviews = database
    ? new AntiCheatReviewRepository(database, (message, context) => logger.warn(message, context))
    : new InMemoryAntiCheatReviewQueue();
  const cee = new CEEService({
    data: data.cee,
    eventLogger: logger,
    serverUrl: env.ceeOriginalServerUrl,
    aesSecret: env.ceeOriginalAesSecret,
    gameRecorder: gameRecords,
    // 复核队列：有库落库，本地与隔离测试退回内存，行为特征本身两边一致。
    // 后台读的也是这一个对象——写进去的条目只有这条队列，不存在两份口径。
    reviewQueue: antiCheatReviews,
  });
  // 状态事件的部署环境标记与仓储：与状态账本同一口径，先于账号装配创建，两边共用一个实例。
  // 标记缺省读作 development，与 `resolveDeploymentEnvironment` 的缺省一致。
  const statusEnvironment = env.otelDeploymentEnvironment ?? "development";
  const statusEvents = database ? new DatabaseStatusEventRepository(database) : undefined;
  const account = createAccount(
    env,
    database,
    logger,
    { faker: appOptions.whoIsFakerService, song, cee },
    antiCheatReviews,
    settings,
    statusEvents,
    statusEnvironment
  );
  // 通道证明按设备公钥落库；没有数据库时退回内存表，本地与 E2E 仍能跑通整条准入链路。
  const clientChannel = new ClientChannel({
    store: database ? new ClientChannelRepository(database) : new InMemoryClientChannelStore(),
    minimumVersion: (clientType) =>
      clientType === "desktop"
        ? settings.version("clientMinDesktopVersion")
        : settings.version("clientMinMobileVersion"),
    onWarn: (message, detail) => logger.warn(message, detail),
    // 没配期望包名就不装配：证明链留在设备上没被验过，注册只记 degraded，不假装 trusted。
    attestation: env.androidAttestationPackage
      ? createAndroidAttestationChecker({
          packageName: env.androidAttestationPackage,
          signatureDigests: env.androidAttestationSignatureDigests,
          onWarn: (message, detail) => logger.warn(message, { detail }),
        })
      : undefined,
  });
  // 下载弹窗标的构建日期与文件大小来自制品本身：对配置里那两条公开别名发 HEAD，结果短缓存。
  const clientArtifacts = new ClientArtifacts({
    urls: {
      windows: env.clientPackageWindowsUrl,
      android: env.clientPackageAndroidUrl,
    },
  });
  // 状态页的两本账：历史与实时样本都按部署环境标记分行，
  // 开发与生产共用一个库也互不污染——开发实例的探测读不到生产的条带，反之亦然。
  // 没库也照样在内存里记本次运行的账，页面有数据可读，只是重启后条带会空。
  const statusHistory = new StatusHistoryStore({
    environment: statusEnvironment,
    database,
    now: () => Date.now(),
  });
  const statusSamples = new StatusSampleStore({
    environment: statusEnvironment,
    database,
    now: () => Date.now(),
  });
  const app = createApp({
    ...appOptions,
    env,
    logger,
    bangumiImages: images,
    statusHistory,
    statusSamples,
    statusEvents,
    sonGuessrService: song,
    ceeService: cee,
    account,
    clientChannel,
    clientArtifacts,
    disposeResources: async () => {
      // 回读定时器不参与退出竞赛，停机时先停掉。
      settings.close();
      // 先等在途对局记录写完再关数据库连接。
      await gameRecords?.close();
      // 状态账本最后各落一次库：计数只在内存里攒着，停机不 flush 就丢掉这一段。
      await statusHistory.flush();
      await statusSamples.flush();
      await account?.visits.close();
      const results = await Promise.allSettled([
        cee.close(),
        data.client.close(),
        Promise.resolve().then(() => images?.close()),
        Promise.resolve().then(() => database?.close()),
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length) throw new AggregateError(failures, "服务资源释放失败");
    },
  });
  return {
    ...app,
    /** 状态账本：启动时读回窗口、运行期定时 flush，由 Index 掌握节奏。 */
    statusHistory,
    statusSamples,
    /**
     * 把在线玩家数报给数据 Worker：更新器据此调整上游速率（没人玩就慢慢更新）。
     * 上报失败无所谓 —— 顶多这一分钟按旧速率跑。
     */
    reportBangumiLoad: (players: number): void => {
      void data.client.request({ method: "updater.reportLoad", players }).catch(() => {});
    },
  };
}

/** 账号系统随数据库启用；`readEnv` 已保证有数据库时账号配置齐备。 */
const createAccount = (
  env: AppEnv,
  database: Database | undefined,
  logger: EventLogger,
  rooms: Record<RecordedGame, AdminRoomControl>,
  reviews: CEEAntiCheatReviewBoard,
  settings: AppSettings,
  statusEvents: DatabaseStatusEventRepository | undefined,
  statusEnvironment: string
) => {
  if (!database || !env.account) return undefined;
  const mailer = createMailer(env.account.mail, logger);
  // 建号钩子要解析 QQ 昵称、补系统徽章，而两个服务都在 auth 之后创建：用闭包延迟绑定。
  let resolveNickname: ((qqNumber: string) => Promise<string | null>) | null = null;
  let accountCreated: ((user: { id: string; qqNumber?: string | null }) => Promise<void>) | null =
    null;
  const auth = createAuth({
    database: drizzleAdapter(database.db, {
      provider: "mysql",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        passkey: schema.passkey,
      },
    }),
    secret: env.account.secret,
    baseURL: env.serverUrl,
    isTrustedOrigin: (origin) => isAllowedOrigin(origin, env.clientUrl),
    secureCookies: env.otelDeploymentEnvironment === "production",
    adminQqNumbers: env.account.adminQqNumbers,
    passkeyRpId: env.account.passkeyRpId,
    mailer,
    resolveNickname: (qqNumber) =>
      resolveNickname ? resolveNickname(qqNumber) : Promise.resolve(null),
    onUserCreated: async (user) => {
      try {
        await accountCreated?.(user);
      } catch (error) {
        logger.warn("建号后自动授予徽章失败", { userId: user.id, error: String(error) });
      }
    },
  });
  // 昵称来源是管理员自建的 NapCat（OneBot 11）：没配实例就不装配昵称服务，
  // 新号发码与建号会因取不到昵称而拒绝（老号不受影响），后台 `admin.qq.*` 回 503。
  const nicknames = env.napcat
    ? new QQNicknameService({ auth, client: new QQNapCatClient(env.napcat), logger })
    : null;
  resolveNickname = (qqNumber) =>
    nicknames ? nicknames.resolveNickname(qqNumber) : Promise.resolve(null);
  const badges = new DatabaseBadgeRepository(database);
  const registrations = new DatabaseRegistrationRepository(database);
  const service = new AccountService({
    auth,
    mailer,
    avatars: new QQAvatarService(),
    badges,
    registrations,
    ownerQqNumber: env.account.ownerQqNumber,
    nicknames,
    logger,
  });
  accountCreated = (user) => service.afterRegistration(user);
  const adminQqNumbers = env.account.adminQqNumbers;
  // 徽章目录是授予关系的外键目标：先补齐目录，再补齐注册序号与系统徽章；失败只记错误，不挡启动。
  void database.ready
    .then(() => badges.ensureCatalog())
    .then(() => service.ensureAutomaticBadges())
    .catch((error: unknown) => logger.error("徽章自动授予失败", { error: String(error) }));
  // 管理员引导只提升不降级：之后的角色变更在后台完成，不被环境变量反复覆盖。
  void database.ready
    .then(() => service.promoteAdmins(adminQqNumbers))
    .catch((error: unknown) => logger.error("管理员引导失败", { error: String(error) }));
  const feedback = new DatabaseFeedbackRepository(database);
  const userData = new UserDataService({
    settings: new DatabaseUserSettingRepository(database),
    feedback,
    cipher: new SettingCipher(env.account.secret),
    nameOf: (userId) => service.nameOf(userId),
    feedbackSink: captureServerFeedback,
    logger,
  });
  const siteStats = new DatabaseSiteStatsRepository(database);
  const admin = new AdminService({
    auth,
    feedback,
    gameRecords: new DatabaseGameRecordRepository(database),
    audit: new DatabaseAuditLogRepository(database),
    reviews,
    rooms,
    siteStats,
    badges,
    settings,
    qq: nicknames,
    statusEvents,
    environment: statusEnvironment,
    sentry:
      env.sentryApiToken && env.sentryDsn
        ? new SentryApiClient(
            deriveSentryApiConfig(
              env.sentryDsn,
              env.sentryAllowedProjectIds ?? [],
              env.sentryApiToken
            ),
            logger
          )
        : null,
  });
  const visits = new SiteStatsService({
    repository: siteStats,
    secret: env.account.secret,
    logger,
  });
  visits.start();
  return { auth, service, userData, admin, visits, ready: database.ready };
};
