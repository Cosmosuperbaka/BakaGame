/**
 * 环境变量的唯一清单与分层归属。
 *
 * `.env.example` 由本文件生成（`bun run docs:env`），`test/EnvRegistry.test.ts` 会把
 * `Server/src`、`Server/scripts`、`Server/integration` 里读到的每一个环境变量名与这里
 * 对照 —— 读到没登记的名字，或 `.env.example` 与生成结果不一致，直接报红。
 * 新增变量因此必须先在分层上表态，清单不可能再和代码脱节。
 *
 * 分层判据（写在 `Agents/Conventions.md` §5）：
 * - `T0` 进程拓扑：描述「我在哪、谁可信」，改了必须重启。
 * - `T1` 引导与密钥：建数据库连接之前就得有值，或本身是凭据。永不进 `app_setting`。
 * - `T2` 部署期可调：缺省即正确，只在特殊部署形态下覆盖；装配时定一次。
 * - `T3` 运行期旋钮：运维想在停机窗口外改，且改了只影响后续行为 → 存 `app_setting`，
 *   环境变量值退成缺省。
 * - `DEV` 脚本、测试与 CI 专用，不属于线上配置面。
 * - `DEAD` 已废弃，只由回归测试守着「设了也不生效」。
 */

export type EnvLayer = "T0" | "T1" | "T2" | "T3" | "DEV" | "DEAD";

export interface EnvEntry {
  /** 环境变量名。 */
  name: string;
  layer: EnvLayer;
  /**
   * 是否进 `.env.example`。判据不是「它存在」，而是「配一台新实例时运维需要知道它」：
   * 缺省即正确、一年覆盖不了一次的项不进，清单因此只装真正要做决定的项。
   */
  documented?: boolean;
  /** 是否凭据：示例值一律留空，注释不描述取值来源之外的细节。 */
  secret?: boolean;
  /** 示例值（只用虚构占位符，真实值与现网名不进被追踪文件）。 */
  sample?: string;
  /** 写在变量上方的说明行；长理由退回各领域文档，不在此复述。 */
  note?: string[];
}

/** 分层的展示标题；顺序即 `.env.example` 的分组顺序。 */
export const LAYER_TITLES: Record<EnvLayer, string> = {
  T0: "进程拓扑（改了必须重启）",
  T1: "引导与凭据（缺失即安全失败，不可热更）",
  T2: "部署期可调（缺省即正确，特殊形态才覆盖）",
  T3: "运行期旋钮（存 app_setting，环境变量值只是缺省）",
  DEV: "",
  DEAD: "",
};

const DOCUMENTED_ORDER: EnvLayer[] = ["T0", "T1", "T2", "T3"];

export const ENV_ENTRIES: EnvEntry[] = [
  // ==================== T0 进程拓扑 ====================
  {
    name: "CLIENT_URL",
    layer: "T0",
    documented: true,
    sample: "http://localhost:5173",
    note: [
      "前端可信来源（逗号分隔列表），同时是 CORS 与 WebSocket 的准入名单；留空取本地缺省。",
      "链路是同源还是跨域属部署口径，见 Agents/Deployment.md §3。",
    ],
  },
  {
    name: "SERVER_URL",
    layer: "T0",
    documented: true,
    sample: "http://localhost:4850",
    note: ["本服务对外基址；缺省取回环加 SERVER_PORT。"],
  },
  {
    name: "SERVER_PORT",
    layer: "T0",
    documented: true,
    sample: "4850",
    note: ["监听端口，1~65535 之外直接拒绝启动。"],
  },
  {
    name: "SERVER_LISTEN_HOST",
    layer: "T0",
    documented: true,
    sample: "",
    note: [
      "监听网卡，缺省为全网卡。它不是防火墙：公网入口收口靠部署侧的网络访问控制与端口发布范围，见 Agents/Deployment.md §1。",
    ],
  },
  {
    name: "DEPLOYMENT_ENVIRONMENT",
    layer: "T0",
    documented: true,
    sample: "",
    note: [
      "部署环境标记（production / development）：显式设为 production 时启动强制要求 MEILISEARCH_KEY，",
      "否则服务拒绝启动；未设置时按 NODE_ENV → development 解析。搜索服务未就绪前勿设 production。",
    ],
  },
  {
    name: "NODE_ENV",
    layer: "T0",
    note: ["只作 DEPLOYMENT_ENVIRONMENT 的兜底；生产必须显式注入环境标记，不按操作系统猜环境。"],
  },
  {
    name: "OTEL_DEPLOYMENT_ENVIRONMENT",
    layer: "T0",
    note: ["DEPLOYMENT_ENVIRONMENT 的 OTel 惯例别名，只在未显式标记部署环境时参与兜底。"],
  },
  {
    name: "PASSKEY_RP_ID",
    layer: "T0",
    documented: true,
    sample: "",
    note: [
      "通行密钥（WebAuthn）的 relying party 域名：留空取 CLIENT_URL 首个来源的 hostname。",
      "只填裸域名（如 example.com，不带协议与端口）。已有用户注册过密钥后**不得再改**：",
      "域名写在凭据里，改了等于旧密钥全部失效。多个前端域名要共用密钥时才需要显式配置。",
    ],
  },
  {
    name: "ANDROID_ATTESTATION_PACKAGE",
    layer: "T0",
    secret: true,
    note: [
      "APK 包名是证明链的信任基准，必须由部署方明确给出；写死默认值等于任何 APK 都能自称是我们的。",
    ],
  },
  {
    name: "SENTRY_ALLOWED_PROJECT_IDS",
    layer: "T0",
    documented: true,
    sample: "0000000",
    note: ["入站事件放行的项目号；留空时从 SENTRY_DSN 推导。"],
  },
  {
    name: "SHARD_GAMES",
    layer: "T0",
    documented: true,
    sample: "faker,song",
    note: [
      "本进程负责的游戏（逗号分隔，可选 faker/song/cee）：只有这些游戏的房间快照会被保存与恢复。",
      "留空 = 全部负责，单进程部署就是这种情形；多进程共用代码目录时必须显式区分，",
      "否则只接一款流量的进程会把别的游戏的房间一并恢复成无人可连的影子房间。",
      "写错名字拒绝启动 —— 静默回落会让这条防线失效。",
    ],
  },

  // ==================== T1 引导与凭据 ====================
  {
    name: "DATABASE_URL",
    layer: "T1",
    documented: true,
    secret: true,
    sample: "mysql://user:password@db.example.com:4000/example",
    note: [
      "数据库连接串（MySQL 协议），必须带库名；生产必填，留空则账号、云同步、后台与对局记录关闭。",
    ],
  },
  {
    name: "BETTER_AUTH_SECRET",
    layer: "T1",
    documented: true,
    secret: true,
    sample: "",
    note: [
      "账号会话签名密钥：配置 DATABASE_URL 时必填，至少 32 字符（openssl rand -hex 32）；更换会使全部登录失效。",
    ],
  },
  {
    name: "ADMIN_QQ",
    layer: "T1",
    documented: true,
    sample: "",
    note: ["管理员 QQ 号（逗号分隔）：建号即为管理员，启动时提升已注册账号；只提升不降级。"],
  },
  {
    name: "SMTP_HOST",
    layer: "T1",
    documented: true,
    sample: "",
    note: ["登录验证码发信（生产必填）。主机与端口按所用邮箱服务商填写。"],
  },
  { name: "SMTP_PORT", layer: "T1", documented: true, sample: "465" },
  { name: "SMTP_USER", layer: "T1", documented: true, sample: "" },
  {
    name: "SMTP_PASS",
    layer: "T1",
    documented: true,
    secret: true,
    sample: "",
    note: ["SMTP_PASS 为该邮箱的客户端专用密码；与 HOST、USER 必须成套，缺一个即拒绝启动。"],
  },
  {
    name: "MAIL_FROM",
    layer: "T1",
    documented: true,
    sample: "",
    note: ["发件人显示，如 Example <noreply@example.com>；缺省为 SMTP_USER。"],
  },
  {
    name: "QQ_NAPCAT_API_URL",
    layer: "T1",
    documented: true,
    sample: "",
    note: ["QQ 昵称来源（OneBot 11 HTTP）；与访问令牌成套，不配则昵称查询整体停用。"],
  },
  { name: "QQ_NAPCAT_ACCESS_TOKEN", layer: "T1", secret: true },
  {
    name: "MAINTENANCE_TOKEN",
    layer: "T1",
    documented: true,
    secret: true,
    sample: "",
    note: [
      "部署停机预告令牌：部署流水线以 Bearer 鉴权调用停机通知端点。",
      "任意随机串（如 openssl rand -hex 32 生成），trim 后非空且不含换行；缺失将中止部署（安全失败）。",
      "必须由实例创建环境注入：重启不更新环境变量，且部署侧不读本文件。",
    ],
  },
  {
    name: "SENTRY_DSN",
    layer: "T1",
    documented: true,
    secret: true,
    sample: "https://examplePublicKey@o000000.ingest.sentry.io/0000000",
  },
  {
    name: "SENTRY_API_TOKEN",
    layer: "T1",
    documented: true,
    secret: true,
    sample: "",
    note: ["管理后台概览代查 Sentry 的只读令牌（org:read、project:read、event:read），可不配"],
  },
  {
    name: "BETTERSTACK_API_KEY",
    layer: "T1",
    documented: true,
    secret: true,
    sample: "",
    note: ["Better Stack Uptime 只读 API 令牌；不配则公开状态页的外部监测显示未知。"],
  },
  {
    name: "STATUS_FRONTEND_URL",
    layer: "T1",
    documented: true,
    secret: false,
    sample: "https://example.com/",
    note: ["公开状态页「前端」一格的探测地址；不配则该组件显示未知。"],
  },
  {
    name: "OTEL_EXPORTER_OTLP_ENDPOINT",
    layer: "T1",
    documented: true,
    sample: "",
    note: ["OTLP 导出端点；不配则不导出链路。"],
  },
  { name: "OTEL_EXPORTER_OTLP_HEADERS", layer: "T1", secret: true },
  {
    name: "MEILISEARCH_KEY",
    layer: "T1",
    documented: true,
    secret: true,
    sample: "",
    note: [
      "搜索服务的 master key（与服务进程的 MEILISEARCH_KEY 一致）；生产环境必填，CEE 与 SonGuessr 共用。",
      "搜索服务必须对本进程可达，见下面 MEILISEARCH_URL 的说明。",
    ],
  },
  {
    name: "CCB_ORIGINAL_AES_SECRET",
    layer: "T1",
    documented: true,
    secret: true,
    sample: "",
    note: ["原版兼容房密钥；与地址任一留空则不提供兼容入口。"],
  },
  {
    name: "ANDROID_ATTESTATION_SIGNATURE_DIGESTS",
    layer: "T1",
    secret: true,
    note: ["期望的 APK 签名证书摘要（base64，逗号分隔）；不配只能验包名，结论最高到 degraded。"],
  },

  // ==================== T2 部署期可调 ====================
  {
    name: "LOG_LEVEL",
    layer: "T2",
    documented: true,
    sample: "info",
    note: [
      "运行日志等级（debug / info / warn / error），缺省 info。",
      "debug 只进入本地结构化文件，不送 Sentry 与 OTLP；控制台始终不打印 debug。",
    ],
  },
  {
    name: "LOG_DIR",
    layer: "T2",
    documented: true,
    sample: "",
    note: [
      "本地 OTel JSONL 日志目录；缺省为 Server/storage/logs，相对路径按 Server 根目录解析。",
      "文件名带部署环境，开发与生产不会写进同一个文件；磁盘轮转与清理由部署侧负责。",
    ],
  },
  {
    name: "LOG_OPERATIONS",
    layer: "T2",
    documented: true,
    sample: "errors",
    note: [
      "结构化日志中的操作范围：errors（缺省，只记失败与慢操作）或 all（记录每次请求与命令）。",
      "控制台不受此项影响，始终不会逐条打印成功操作。",
    ],
  },
  {
    name: "LOG_CONSOLE_COLOR",
    layer: "T2",
    documented: true,
    sample: "auto",
    note: ["控制台颜色：auto（仅 TTY 着色）/ always / never；容器日志建议 auto 或 never。"],
  },
  {
    name: "LOG_SLOW_OPERATION_MS",
    layer: "T2",
    note: ["操作慢于该毫秒数时进入结构化日志并显示在控制台；缺省 1000。"],
  },
  {
    name: "MCP_ENABLED",
    layer: "T2",
    documented: true,
    sample: "false",
    note: ["Agent（MCP）接入总开关，缺省关闭；关闭时握手直接拒绝声明为 Agent 的连接。"],
  },
  {
    name: "MCP_AGENT_NAME",
    layer: "T2",
    documented: true,
    sample: "BakaAgent",
    note: ["MCP Agent 在房间内使用的默认昵称；缺省 BakaAgent。"],
  },
  {
    name: "BANGUMI_API_URL",
    layer: "T2",
    sample: "https://api.bgm.tv",
    note: ["上游数据源地址；缺省即官方站，只有换镜像或走代理时才覆盖。"],
  },
  {
    name: "BANGUMI_IMAGE_SOURCE",
    layer: "T2",
    documented: true,
    sample: "",
    note: [
      "图片对外前缀固定为站内图床路径（不可配）；下面这项只决定图床缺图时去哪补，留空 = 只服务已缓存的图。",
    ],
  },
  { name: "BANGUMI_ENRICHMENT_PATH", layer: "T2" },
  {
    name: "ROOM_SNAPSHOT_DIR",
    layer: "T2",
    note: [
      "房间快照目录，缺省为 Server/storage。隔离冒烟与多实例测试指向临时目录，",
      "避免把测试数据写进源码树的持久化目录。",
    ],
  },
  { name: "BANGUMI_DB_PATH", layer: "T2" },
  { name: "BANGUMI_IMAGES_DIR", layer: "T2" },
  {
    name: "BANGUMI_DATASET_WRITER",
    layer: "T2",
    documented: true,
    sample: "",
    note: ["多进程分片时只有主片保持可写；其余片设 false 以只读打开数据集，更新器与备份不装配。"],
  },
  {
    name: "BANGUMI_UPDATER_ENABLED",
    layer: "T2",
    documented: true,
    sample: "",
    note: ["运行时更新器：缺省只在生产开启，E2E 与本地开发不该打线上上游。"],
  },
  {
    name: "BANGUMI_UPDATER_MIN_RATE",
    layer: "T2",
    note: ["更新器速率下限（req/s），在线人数为 0 时按它跑。"],
  },
  { name: "BANGUMI_UPDATER_MAX_RATE", layer: "T2", note: ["速率上限（req/s）。"] },
  {
    name: "BANGUMI_UPDATER_PLAYER_SCALE",
    layer: "T2",
    note: ["达到该在线人数即按上限跑；区间内线性插值（SubjectUpdater.currentRate）。"],
  },
  {
    name: "BANGUMI_TAG_DIFF_URL",
    layer: "T2",
    documented: true,
    sample: "",
    note: ["CCB-TagsCI 的角色标签增量地址；不配就不跑增量同步（上游不保证这条产物长期存在）。"],
  },
  {
    name: "MEILISEARCH_URL",
    layer: "T2",
    documented: true,
    sample: "",
    note: [
      "搜索服务地址：未设置时取代码里的回环默认值，要求搜索服务与本进程在同一网络命名空间。",
      "搜索服务独立部署时回环地址不可达，必须设为对本进程可达的地址，",
      "否则搜索与出题链路初始化失败（不降级）。",
    ],
  },
  { name: "OTEL_SERVICE_NAME", layer: "T2" },
  { name: "OTEL_SERVICE_NAMESPACE", layer: "T2" },
  { name: "OTEL_RESOURCE_ATTRIBUTES", layer: "T2" },
  {
    name: "SENTRY_TRACES_SAMPLE_RATE",
    layer: "T2",
    note: ["链路采样率：只认 0–1 之间的数，其余（含写错）一律按缺省执行。"],
  },
  {
    name: "CLIENT_PACKAGE_WINDOWS_URL",
    layer: "T2",
    documented: true,
    sample: "",
    note: [
      "桌面安装包公开下载地址（CI 推上去的固定别名）；留空取代码里的发布约定缺省，显式空串 = 该平台不进列表。",
    ],
  },
  { name: "CLIENT_PACKAGE_ANDROID_URL", layer: "T2", documented: true, sample: "" },
  {
    name: "CCB_ORIGINAL_SERVER_URL",
    layer: "T2",
    documented: true,
    sample: "",
    note: ["原版兼容房地址；与密钥任一留空则不提供兼容入口。"],
  },
  {
    name: "OPENAPI_ENABLED",
    layer: "T2",
    documented: true,
    sample: "",
    note: [
      "HTTP 文档页（/openapi）是否挂载。未设置时按部署环境推导：非生产开启、production 关闭 ——",
      "文档页把全部路由与管理端点面列成可直接照打的清单，不该随生产镜像对外提供。",
      "契约产物由 Server 的 OpenAPI 导出脚本离线生成，不依赖线上文档。",
      "线上排障需要临时看文档时显式设为 true，不必改代码重出镜像。",
    ],
  },
  {
    name: "MAIL_DEV_CONSOLE",
    layer: "T2",
    documented: true,
    sample: "",
    note: ["仅本地：未配 SMTP 时设 true，把验证码打印到服务日志；生产设置即拒绝启动。"],
  },

  // ==================== T3 运行期旋钮 ====================
  {
    name: "CLIENT_MIN_DESKTOP_VERSION",
    layer: "T3",
    documented: true,
    sample: "",
    note: [
      "桌面壳的最低准入版本；空串 = 不设门槛。通道证明协议破坏性变更时必须抬它。",
      "这里是缺省值，线上生效值存 app_setting（发版抬门槛不该要求重建容器）。",
    ],
  },
  { name: "CLIENT_MIN_MOBILE_VERSION", layer: "T3", documented: true, sample: "" },
  {
    name: "ENABLE_GENERAL_UNBLOCK",
    layer: "T3",
    documented: true,
    sample: "true",
    note: ["网易云全局解灰（默认开启）：缺省值，线上开关存 app_setting，改动只影响后续请求。"],
  },
  {
    name: "ENABLE_ANONYMOUS_QQ_SEARCH",
    layer: "T3",
    documented: true,
    sample: "true",
    note: [
      "QQ 音乐匿名补充检索（默认开启）：没有 QQ 账号的房间用匿名通道补充免费曲；",
      "上游限流时可关闭止损，系统连续失败后也会自动熔断。",
    ],
  },

  // ==================== DEV 脚本与 CI 专用 ====================
  { name: "NETEASE_COOKIE", layer: "DEV", secret: true },
  { name: "SENTRY_RELEASE", layer: "DEV" },
  { name: "GITHUB_SHA", layer: "DEV" },
  { name: "GIT_DIR", layer: "DEV" },
  { name: "GIT_WORK_TREE", layer: "DEV" },
  { name: "BAKAGAME_TEST_OWNER", layer: "DEV" },
  { name: "FIXTURE_ENV_MARKER", layer: "DEV" },
  { name: "LOADTEST_METRICS_PORT", layer: "DEV" },
  { name: "LOADTEST_WS_MAX_CONNECTIONS", layer: "DEV" },
  { name: "SONG_PROBE_LIVE_ATTEMPTS", layer: "DEV" },
  { name: "SONG_PROBE_LIVE_ROUNDS", layer: "DEV" },
  { name: "SONG_PROBE_REPLAY_ROOMS", layer: "DEV" },
  // 部署链路的两个脚本入参：探针就绪预算由 deploy.yml 注入，容器侧版本门读期望清单。
  // 它们只服务脚本，不进 .env.example，也不属于线上应用配置面。
  { name: "DEPLOY_PROBE_BUDGET_MS", layer: "DEV" },
  { name: "NPM_PINS", layer: "DEV" },
  { name: "NPM_MODULES", layer: "DEV" },

  // ==================== DEAD 已废弃 ====================
  { name: "AES_SECRET", layer: "DEAD" },
  { name: "BANGUMI_IMAGE_URL", layer: "DEAD" },
  { name: "CEE_MEILISEARCH_URL", layer: "DEAD" },
  { name: "CEE_MEILISEARCH_TIMEOUT_MS", layer: "DEAD" },
];

/** 只取会进 `.env.example` 的项，按分层分组。 */
export const documentedEntries = (): { layer: EnvLayer; entries: EnvEntry[] }[] =>
  DOCUMENTED_ORDER.map((layer) => ({
    layer,
    entries: ENV_ENTRIES.filter((entry) => entry.documented && entry.layer === layer),
  })).filter((group) => group.entries.length > 0);

const renderEntry = (entry: EnvEntry): string[] => [
  ...(entry.note ?? []).map((line) => `# ${line}`),
  `${entry.name}=${entry.sample ?? ""}`,
];

/** 渲染 `.env.example` 全文；测试用它与已提交文件逐字节比对，产物落后即报红。 */
export const renderEnvExample = (): string => {
  const lines: string[] = [
    "# 由 Server/src/config/env/Registry.ts 生成（bun run docs:env）；不要手改本文件。",
    "# 变量名、分层、缺省与校验的唯一来源都在代码里，判据见 Agents/Conventions.md §5。",
    "# 真实凭据、私有域名与生产配置一律不进被追踪文件：示例值只用 example.com 之类的虚构占位符。",
    "",
  ];
  for (const group of documentedEntries()) {
    lines.push(`# ==================== ${LAYER_TITLES[group.layer]} ====================`, "");
    for (const entry of group.entries) lines.push(...renderEntry(entry));
    lines.push("");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
};
