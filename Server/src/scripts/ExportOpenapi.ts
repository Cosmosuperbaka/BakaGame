import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Elysia } from "elysia";

import { compareDottedVersion } from "../shared/ModelValues";
import { createOpenapiPlugin } from "../transport/Openapi";
import { RPC_BASE_PATH } from "../transport/routes/Account";
import type { AppEnv } from "../config/Env";
import { EventLogger } from "../infrastructure/EventLogger";
import { StatusHistoryStore } from "../infrastructure/StatusHistoryStore";
import { StatusSampleStore } from "../infrastructure/StatusSampleStore";
import type { StatusEventRepository } from "../infrastructure/db/StatusEventRepository";
import { RemoteMcpSessions } from "../mcp/Remote";
import { createHttpRoutes } from "../transport/HttpRoutes";
import { createStatusAggregator } from "../transport/routes/Status";
import { SitePages } from "../transport/SitePages";
import { RPC_PROTOCOL_NOTES, buildRpcOpenApiFragment } from "./RpcOpenapi";

type Json = Record<string, unknown>;

/**
 * 契约产物的基址固定用本地占位：产物提交在库，读 `SERVER_URL` 等于把部署主机名（可能是内网名）
 * 写进仓库文件。线上文档页的 `servers.url` 由 `transport/App.ts` 那侧的配置决定，两者互不影响。
 */
export const DOC_SERVER_URL = "http://localhost:4850";

/** 状态事件接口只需要存在：文档导出从不读它。 */
const NO_STATUS_EVENTS: StatusEventRepository = {
  list: async () => ({ items: [], total: 0 }),
  get: async () => null,
  create: () => Promise.reject(new Error("文档装配不写状态事件")),
  update: () => Promise.reject(new Error("文档装配不写状态事件")),
  remove: () => Promise.reject(new Error("文档装配不写状态事件")),
};

/**
 * 只装配 HTTP 契约，不构造游戏服务、SQLite Worker 或遥测出口。
 * 路由集合与运行时同源（`createHttpRoutes`）：账本类依赖传入空实例，保证按依赖有无才注册的路由全部出现在文档里。
 */
export function createDocumentationApp(serverUrl = DOC_SERVER_URL) {
  const env = {
    clientUrl: serverUrl,
    serverUrl,
    serverListenHost: "127.0.0.1",
    serverPort: 0,
    bangumiApiUrl: "",
    bangumiImageUrl: "",
  } satisfies AppEnv;
  const logger = new EventLogger(() => undefined);
  const environment = "documentation";
  const statusHistory = new StatusHistoryStore({ environment });
  return new Elysia({ normalize: false }).use(createOpenapiPlugin({ serverUrl })).use(
    createHttpRoutes({
      env,
      logger,
      statusAggregator: createStatusAggregator({
        isServiceAvailable: () => true,
        roomsAvailable: true,
        history: statusHistory,
      }),
      statusHistory,
      statusSamples: new StatusSampleStore({ environment }),
      statusEvents: NO_STATUS_EVENTS,
      remoteMcpSessions: new RemoteMcpSessions(logger, { selfUrl: serverUrl, siteUrl: serverUrl }),
      sitePages: new SitePages(),
    })
  );
}

// ==================== 产品版本 ====================

/** 更新日志是产品版本的唯一真相源（见 `Agents/Commitment.md`）；包清单里的 `0.0.0` 不是版本。 */
const CHANGELOG_PATH = resolve(import.meta.dir, "../../../Client/src/data/changelog.json");

const productVersion = async (): Promise<string> => {
  const { entries } = JSON.parse(await readFile(CHANGELOG_PATH, "utf8")) as { entries?: unknown };
  const versions = (Array.isArray(entries) ? entries : [])
    .map((entry) => (entry as { version?: unknown }).version)
    .filter(
      (version): version is string => typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)
    );
  const latest = versions.sort(compareDottedVersion).at(-1);
  if (!latest) throw new Error(`读不到版本号：${CHANGELOG_PATH} 里没有可用的 semver`);
  return latest;
};

// ==================== 合并 oRPC 契约 ====================

const sessionCookieScheme = (): Json => ({
  type: "apiKey",
  in: "cookie",
  name: "bakagame.session_token",
  description:
    "登录后由 `/api/auth/sign-in/email-otp` 下发的 HttpOnly 会话 Cookie。登出或封禁后失效，受保护的过程回 401。",
});

/** Elysia 只认得自己那几条 HTTP 路由，账号 API 的线格式说明在这里补上。 */
const mergedDescription = (description: unknown): string =>
  [
    typeof description === "string" ? description.trim() : "",
    "## 账号 API（oRPC）",
    RPC_PROTOCOL_NOTES,
  ]
    .filter(Boolean)
    .join("\n\n");

/**
 * 把账号 API（oRPC 契约）并进 Elysia 生成的 HTTP 文档。
 *
 * 两份产物合成一个文件是有意的：Postman 与 AI Agent 只会导入一次，分成两份就得自己猜
 * 「哪些接口不在这里」，而 `/api/rpc/*` 恰好是账号、后台、反馈的全部接口面。
 */
export const withRpcContract = async (document: Json): Promise<Json> => {
  const fragment = buildRpcOpenApiFragment(RPC_BASE_PATH);
  const info = { ...(document.info as Json) };
  const components = { ...(document.components as Json | undefined) } as Json;
  info.version = await productVersion();
  info.description = mergedDescription(info.description);
  return {
    ...document,
    info,
    tags: [...((document.tags as Json[] | undefined) ?? []), ...fragment.tags],
    paths: { ...(document.paths as Json | undefined), ...fragment.paths },
    components: {
      ...components,
      schemas: { ...(components.schemas as Json | undefined), ...fragment.components.schemas },
      responses: fragment.components.responses,
      securitySchemes: { sessionCookie: sessionCookieScheme() },
    },
  };
};

/** 契约产物的落点：`test/RpcOpenapi.test.ts` 用它比对提交在库的文档，路径只有这一处定义。 */
export const OPENAPI_DOC_PATH = resolve(import.meta.dir, "../../docs/http-openapi.json");

/** 离线渲染整份文档；`serverUrl` 只决定 `servers`，不影响接口面。 */
export const renderOpenApiDocument = async (serverUrl: string): Promise<Json> => {
  const response = await createDocumentationApp(serverUrl).handle(
    new Request("http://localhost/openapi/json")
  );
  if (!response.ok) throw new Error("HTTP 契约生成失败");
  return withRpcContract((await response.json()) as Json);
};

if (import.meta.main) {
  const document = await renderOpenApiDocument(DOC_SERVER_URL);
  const paths = document.paths as Json;
  if (!paths["/readyz"]) throw new Error("生成文档遗漏就绪契约");
  if (!paths["/api/status"]) throw new Error("生成文档遗漏状态页契约");
  if (!paths["/api/client/register"]) throw new Error("生成文档遗漏客户端通道契约");
  if (!paths["/api/mcp"]) throw new Error("生成文档遗漏远程 MCP 契约");
  if (!paths[`${RPC_BASE_PATH}/account/me`]) throw new Error("生成文档遗漏账号 RPC 契约");
  await mkdir(dirname(OPENAPI_DOC_PATH), { recursive: true });
  await writeFile(OPENAPI_DOC_PATH, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}
