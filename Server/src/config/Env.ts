import { resolve } from "node:path";

import { AppError } from "../domain/Errors";
import { QQ_NUMBER_PATTERN } from "../shared/Account";

const LOCAL_LISTEN_HOSTS = new Set(["0.0.0.0", "127.0.0.1", "localhost", "::1"]);

/**
 * 图床对外前缀：**写死，不提供环境变量开关**。
 *
 * 挂在 `/api` 下是刻意的：边缘的 SPA 兜底函数吃掉前端域名
 * 下所有非 `/api` 路径，新前缀必须落在 `/api/*` 里才能到得了源站。详见
 * `Agents/Deployment.md`。
 */
const BANGUMI_IMAGE_ROUTE = "/api/bangumi";

/**
 * 客户端安装包的固定别名地址：CI 的 `client-publish` 作业按这两个键名推 R2，
 * 名字不带版本号、永远指向最新，旧链接长期有效。默认值即发布约定，换桶才需要配环境变量。
 */
const DEFAULT_WINDOWS_PACKAGE_URL = "https://cdn.baka.website/files/BakaGame-latest-x64.exe";
const DEFAULT_ANDROID_PACKAGE_URL = "https://cdn.baka.website/files/BakaGame-latest-release.apk";

/** 通行密钥域名（relying party ID）的取值形状：裸域名，允许 `localhost` 这类单标签。 */
const RP_ID_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export interface AppEnv {
  clientUrl: string;
  serverUrl: string;
  serverListenHost: string;
  serverPort: number;
  /** TiDB 连接串；未配置时账号、云同步、后台与对局记录整体关闭（生产必填）。 */
  databaseUrl?: string;
  /** 账号系统配置：随数据库一同启用，缺数据库时为空。 */
  account?: AccountEnv;
  /** NapCat（OneBot 11）昵称来源；未配置时 QQ 昵称查询整体停用。 */
  napcat?: NapCatEnv;
  otelEndpoint?: string;
  otelHeaders?: Record<string, string>;
  otelServiceName?: string;
  otelServiceNamespace?: string;
  otelDeploymentEnvironment?: string;
  /**
   * HTTP 文档页（`/openapi`）是否挂载。缺省视为开启（测试与本地开发装配 env 时不必逐个声明），
   * 生产由 `loadEnv` 依 `DEPLOYMENT_ENVIRONMENT` 关掉。
   */
  openapiEnabled?: boolean;
  maintenanceToken?: string;
  sentryDsn?: string;
  sentryAllowedProjectIds?: string[];
  /** 管理后台概览代查 Sentry 用的只读令牌（org:read、project:read、event:read）；不配则后台显示未配置。 */
  sentryApiToken?: string;
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
  enableGeneralUnblock?: boolean;
  ceeOriginalServerUrl?: string;
  /**
   * 反作弊房接受的最低壳版本；空串 = 不设版本门槛。
   * 通道证明协议一旦破坏性变更必须抬这里，否则旧壳还能继续签名通关。
   */
  clientMinDesktopVersion?: string;
  clientMinMobileVersion?: string;
  /**
   * 客户端安装包的公开下载地址（CI 的 `client-publish` 作业推上去的固定别名）。
   * 首页下载弹窗与更新提醒都读这两条：服务端对地址发 HEAD 取回构建日期与文件大小，
   * 玩家点到的链接与这里同一处。空串 = 该平台不进列表。
   */
  clientPackageWindowsUrl?: string;
  clientPackageAndroidUrl?: string;
  /**
   * Android Key Attestation 的期望包名。不配 = 不校验证明链（带链注册只记 `degraded`）：
   * 包名是信任基准，写死默认值会让任何 APK 都能声称自己是我们的。
   */
  androidAttestationPackage?: string;
  /** 期望的 APK 签名证书摘要（base64，逗号分隔）。不配只能验包名，结论最高到 `degraded`。 */
  androidAttestationSignatureDigests?: string[];
  ceeOriginalAesSecret?: string;
  meilisearchKey?: string;
}

export interface SmtpEnv {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** 发件人，如 `BakaGame <noreply@baka.website>`；缺省用 SMTP_USER。 */
  from: string;
}

export interface AccountEnv {
  /** Better Auth 会话签名密钥（≥ 32 字符）。 */
  secret: string;
  /** 启动时提升为管理员的 QQ 号。 */
  adminQqNumbers: string[];
  /** 验证码投递：SMTP，或仅限非生产环境的控制台输出（`MAIL_DEV_CONSOLE=true`）。 */
  mail: { kind: "smtp"; smtp: SmtpEnv } | { kind: "console" } | { kind: "none" };
  /**
   * 通行密钥的 relying party 域名（裸域名）：显式 `PASSKEY_RP_ID` 优先，否则取 `CLIENT_URL`
   * 首个来源的 hostname。
   *
   * 一旦有用户注册过密钥就不能再改：密钥按域名绑定，改了等于旧密钥全部失效。
   * 想跨子域共用（`game.` 与 `www.` 都能登录）就在第一个用户注册前固定成公共注册域。
   */
  passkeyRpId: string;
}

/**
 * QQ 昵称来源：管理员自建的 NapCat 实例（OneBot 11 HTTP）。
 *
 * 网址与令牌必须成对出现：缺一个就是配置错误，不能默默降级成「查不到昵称」——
 * 那会让新号注册以「QQ 昵称不可用」为由被拒，排查时看不出是配置漏填。
 */
export interface NapCatEnv {
  /** OneBot HTTP 基址，不含结尾斜杠。 */
  apiUrl: string;
  accessToken: string;
}

// ==================== 环境变量解析 ====================

const readSmtpEnv = (): SmtpEnv | undefined => {
  const host = Bun.env.SMTP_HOST?.trim();
  const user = Bun.env.SMTP_USER?.trim();
  const pass = Bun.env.SMTP_PASS ?? "";
  if (!host && !user && !pass) return undefined;
  if (!host || !user || !pass) {
    throw new AppError("CONFIG_ERROR", "SMTP_HOST、SMTP_USER、SMTP_PASS 必须同时配置");
  }
  const rawPort = Bun.env.SMTP_PORT?.trim() || "465";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError("CONFIG_ERROR", `环境变量 SMTP_PORT 必须为合法端口号，收到: "${rawPort}"`);
  }
  return { host, port, user, pass, from: Bun.env.MAIL_FROM?.trim() || user };
};

/**
 * 通行密钥的 relying party 域名。
 *
 * `CLIENT_URL` 是逗号分隔的来源列表，而 rpID 只有一个：默认取第一个来源的 hostname，
 * 多个前端域名要共用密钥时必须显式配 `PASSKEY_RP_ID` 成它们的公共注册域。
 */
const resolvePasskeyRpId = (clientUrl: string): string => {
  const raw = Bun.env.PASSKEY_RP_ID?.trim();
  if (raw) {
    if (!RP_ID_PATTERN.test(raw)) {
      throw new AppError(
        "CONFIG_ERROR",
        `PASSKEY_RP_ID 必须是裸域名（不含协议、端口与路径），收到: "${raw}"`
      );
    }
    return raw.toLowerCase();
  }
  for (const item of clientUrl.split(",")) {
    try {
      const hostname = new URL(item.trim()).hostname;
      if (hostname) return hostname;
    } catch {
      // 非法来源由 isAllowedOrigin 那边报错，这里继续找下一个。
    }
  }
  return "localhost";
};

const readAccountEnv = (
  databaseUrl: string | undefined,
  clientUrl: string
): AccountEnv | undefined => {
  if (!databaseUrl) return undefined;
  const secret = Bun.env.BETTER_AUTH_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new AppError(
      "CONFIG_ERROR",
      "配置 DATABASE_URL 时 BETTER_AUTH_SECRET 必须为至少 32 字符的随机串"
    );
  }
  const adminQqNumbers = (Bun.env.ADMIN_QQ ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const invalidAdmin = adminQqNumbers.find((item) => !QQ_NUMBER_PATTERN.test(item));
  if (invalidAdmin) throw new AppError("CONFIG_ERROR", `ADMIN_QQ 含非法 QQ 号: "${invalidAdmin}"`);
  const smtp = readSmtpEnv();
  const devConsole = Bun.env.MAIL_DEV_CONSOLE === "true";
  return {
    secret,
    adminQqNumbers,
    mail: smtp ? { kind: "smtp", smtp } : devConsole ? { kind: "console" } : { kind: "none" },
    passkeyRpId: resolvePasskeyRpId(clientUrl),
  };
};

const readNapCatEnv = (): NapCatEnv | undefined => {
  const apiUrl = Bun.env.QQ_NAPCAT_API_URL?.trim();
  const accessToken = Bun.env.QQ_NAPCAT_ACCESS_TOKEN?.trim();
  if (!apiUrl && !accessToken) return undefined;
  if (!apiUrl || !accessToken) {
    throw new AppError("CONFIG_ERROR", "QQ_NAPCAT_API_URL 与 QQ_NAPCAT_ACCESS_TOKEN 必须同时配置");
  }
  return { apiUrl: apiUrl.replace(/\/+$/, ""), accessToken };
};

const parseOtelResourceAttributes = (raw?: string): Record<string, string> => {
  if (!raw) return {};
  const attrs: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      const key = part.slice(0, eqIdx).trim();
      let value = part.slice(eqIdx + 1).trim();
      try {
        value = decodeURIComponent(value);
      } catch {
        // fallback
      }
      attrs[key] = value;
    }
  }
  return attrs;
};

const parseOtelHeaders = (raw?: string): Record<string, string> | undefined => {
  if (!raw) return undefined;
  const headers: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      const key = part.slice(0, eqIdx).trim();
      let value = part.slice(eqIdx + 1).trim();
      try {
        value = decodeURIComponent(value);
      } catch {
        // 解码异常时退回原始值
      }
      headers[key] = value;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
};

const normalizeServerUrl = (value: string, port: number): URL => {
  const normalized = new URL(value);

  if (!normalized.port) {
    normalized.port = String(port);
  }

  normalized.pathname = "/";
  normalized.search = "";
  normalized.hash = "";

  return normalized;
};

const resolveListenHost = (serverUrl: URL): string => {
  if (Bun.env.SERVER_LISTEN_HOST) return Bun.env.SERVER_LISTEN_HOST;
  if (LOCAL_LISTEN_HOSTS.has(serverUrl.hostname) && Bun.env.SERVER_URL) {
    return serverUrl.hostname;
  }
  return "0.0.0.0";
};

const DEFAULT_CLIENT_URL = "http://localhost:5173";

const resolveDefaultBangumiEnrichmentPath = (): string => {
  if (Bun.env.BANGUMI_ENRICHMENT_PATH) {
    return resolve(process.cwd(), Bun.env.BANGUMI_ENRICHMENT_PATH);
  }
  // 放 Server/storage：可写、不进 Git、不参与部署产物。
  return resolve(import.meta.dir, "../../storage/bangumi-enrichment.sqlite");
};

export const readEnv = (): AppEnv => {
  const rawPort = Bun.env.SERVER_PORT ?? "4850";
  const serverPort = Number(rawPort);
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    throw new AppError(
      "CONFIG_ERROR",
      `环境变量 SERVER_PORT 必须为 1~65535 之间的合法端口号，收到: "${rawPort}"`
    );
  }

  const serverUrl = normalizeServerUrl(
    Bun.env.SERVER_URL ?? `http://127.0.0.1:${serverPort}`,
    serverPort
  );

  const resourceAttrs = parseOtelResourceAttributes(Bun.env.OTEL_RESOURCE_ATTRIBUTES);
  const otelServiceName =
    Bun.env.OTEL_SERVICE_NAME ?? resourceAttrs["service.name"] ?? "Bakagame-Server";
  const otelServiceNamespace =
    Bun.env.OTEL_SERVICE_NAMESPACE ?? resourceAttrs["service.namespace"] ?? "Bakagame";
  const otelDeploymentEnvironment =
    Bun.env.DEPLOYMENT_ENVIRONMENT ??
    Bun.env.OTEL_DEPLOYMENT_ENVIRONMENT ??
    resourceAttrs["deployment.environment"] ??
    Bun.env.NODE_ENV ??
    "development";

  const sentryDsn = Bun.env.SENTRY_DSN;
  let sentryAllowedProjectIds = (Bun.env.SENTRY_ALLOWED_PROJECT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentryAllowedProjectIds.length === 0 && sentryDsn) {
    try {
      const projectId = new URL(sentryDsn).pathname.match(/^\/([0-9a-zA-Z_-]+)$/)?.[1];
      if (projectId) sentryAllowedProjectIds = [projectId];
    } catch {
      /* 非法 DSN 由 Sentry 初始化阶段处理 */
    }
  }

  const sentryApiToken = Bun.env.SENTRY_API_TOKEN?.trim() || undefined;
  if (sentryApiToken && !sentryDsn)
    throw new AppError(
      "CONFIG_ERROR",
      "SENTRY_API_TOKEN 需要同时配置 SENTRY_DSN（从中读取组织与区域）"
    );

  // 显式配置成空串（CLIENT_URL=""）时必须回落到默认值，不能把空串透出去：
  // 下游 `isAllowedOrigin` 见到空串会当成「未限制来源」而放行全部 Origin。
  const clientUrl = (Bun.env.CLIENT_URL ?? "").trim() || DEFAULT_CLIENT_URL;
  const bangumiImagesDir = Bun.env.BANGUMI_IMAGES_DIR
    ? resolve(Bun.env.BANGUMI_IMAGES_DIR)
    : resolve(import.meta.dir, "../../data/images");

  const databaseUrl = Bun.env.DATABASE_URL?.trim() || undefined;

  return {
    clientUrl,
    serverUrl: serverUrl.toString().replace(/\/$/, ""),
    serverListenHost: resolveListenHost(serverUrl),
    serverPort,
    databaseUrl,
    account: readAccountEnv(databaseUrl, clientUrl),
    napcat: readNapCatEnv(),
    otelEndpoint: Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelHeaders: parseOtelHeaders(Bun.env.OTEL_EXPORTER_OTLP_HEADERS),
    otelServiceName,
    otelServiceNamespace,
    otelDeploymentEnvironment,
    // 文档页默认只在非生产挂载：生产公开整张路由表等于把 admin 端点面与内网基址白送，
    // 契约产物另有 `ExportOpenapi.ts` 离线生成，不依赖线上文档。
    openapiEnabled:
      Bun.env.OPENAPI_ENABLED !== undefined
        ? Bun.env.OPENAPI_ENABLED === "true"
        : otelDeploymentEnvironment !== "production",
    maintenanceToken: Bun.env.MAINTENANCE_TOKEN?.trim() || undefined,
    sentryDsn,
    sentryApiToken,
    sentryAllowedProjectIds,
    bangumiApiUrl: (Bun.env.BANGUMI_API_URL ?? "https://api.bgm.tv").replace(/\/+$/, ""),
    bangumiImageUrl: BANGUMI_IMAGE_ROUTE,
    // 回源没有缺省值：对外前缀是相对路径的 `/api/bangumi`，跟它回源就是自己回自己。
    bangumiImageSource: (Bun.env.BANGUMI_IMAGE_SOURCE ?? "").replace(/\/+$/, ""),
    // 分片部署下每片可以指向各自的副本（多进程共写一份库会等锁）；缺省仍是单进程那一份。
    // 相对路径按工作目录解析，与 `BANGUMI_ENRICHMENT_PATH` 同一口径。
    bangumiDbPath: Bun.env.BANGUMI_DB_PATH?.trim()
      ? resolve(process.cwd(), Bun.env.BANGUMI_DB_PATH.trim())
      : resolve(import.meta.dir, "../../data/bangumi.sqlite"),
    // 默认可写（维持单进程与现有部署的行为）；只有显式 `=false` 的片才退成只读读取者。
    bangumiDatasetWriter: Bun.env.BANGUMI_DATASET_WRITER !== "false",
    bangumiImagesDir,
    // 运行时更新器默认只在生产开启：E2E / 测试与本地开发不该打在线上上游。
    bangumiUpdaterEnabled:
      Bun.env.BANGUMI_UPDATER_ENABLED !== undefined
        ? Bun.env.BANGUMI_UPDATER_ENABLED === "true"
        : otelDeploymentEnvironment === "production",
    bangumiUpdaterMinRate: Number(Bun.env.BANGUMI_UPDATER_MIN_RATE ?? 10),
    bangumiUpdaterMaxRate: Number(Bun.env.BANGUMI_UPDATER_MAX_RATE ?? 100),
    bangumiUpdaterPlayerScale: Number(Bun.env.BANGUMI_UPDATER_PLAYER_SCALE ?? 20),
    // 不配就不跑：上游 diff 产物并不长期存在（实测 2026-10-11 仓库 outputs/ 下只有
    // id_tags.js / id_tags.json），写死默认地址只会让每次启动都报「连不上」。
    bangumiTagDiffUrl: Bun.env.BANGUMI_TAG_DIFF_URL?.trim() || undefined,
    bangumiEnrichmentPath: resolveDefaultBangumiEnrichmentPath(),
    ceeOriginalServerUrl: (Bun.env.CCB_ORIGINAL_SERVER_URL ?? "").trim().replace(/\/+$/, ""),
    clientMinDesktopVersion: Bun.env.CLIENT_MIN_DESKTOP_VERSION?.trim() || undefined,
    clientMinMobileVersion: Bun.env.CLIENT_MIN_MOBILE_VERSION?.trim() || undefined,
    // 显式配成空串 = 这个平台不发（安卓没配签名密钥时就是这个状态），不给默认地址。
    clientPackageWindowsUrl:
      Bun.env.CLIENT_PACKAGE_WINDOWS_URL?.trim() ?? DEFAULT_WINDOWS_PACKAGE_URL,
    clientPackageAndroidUrl:
      Bun.env.CLIENT_PACKAGE_ANDROID_URL?.trim() ?? DEFAULT_ANDROID_PACKAGE_URL,
    // Android Key Attestation 的期望包名：不配就不校验证明链（带链注册只记 degraded）。
    // 写死包名等于替所有 APK 定一个信任基准，必须由部署方明确给出。
    androidAttestationPackage: Bun.env.ANDROID_ATTESTATION_PACKAGE?.trim() || undefined,
    androidAttestationSignatureDigests: (Bun.env.ANDROID_ATTESTATION_SIGNATURE_DIGESTS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
    ceeOriginalAesSecret: Bun.env.CCB_ORIGINAL_AES_SECRET,
    meilisearchKey: Bun.env.MEILISEARCH_KEY?.trim() || undefined,
    enableGeneralUnblock:
      Bun.env.ENABLE_GENERAL_UNBLOCK !== undefined
        ? Bun.env.ENABLE_GENERAL_UNBLOCK === "true"
        : true,
  };
};
