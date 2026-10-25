import { z } from "zod";

import {
  accountProfileSchema,
  adminFeedbackDetailSchema,
  adminFeedbackSchema,
  adminOverviewSchema,
  adminRoomSchema,
  adminUserDetailSchema,
  adminUserSchema,
  apiContract,
  auditEntrySchema,
  cloudSettingsSchema,
  feedbackDetailSchema,
  feedbackReplySchema,
  feedbackSummarySchema,
  gameRecordDetailSchema,
  gameRecordItemSchema,
  musicSessionSchema,
  publicProfileSchema,
  qqLookupStatusSchema,
  sentryOverviewSchema,
  type RpcAuth,
} from "../shared/ApiContract";

type Json = Record<string, unknown>;

/**
 * oRPC 契约 → OpenAPI 片段。
 *
 * 账号 API 不经过 Elysia 的路由声明（整棵契约挂在 `POST /api/rpc/*` 上由 oRPC 自己分发），
 * 所以 `@elysiajs/swagger` 生成不到它。这里按契约树遍历补出一份等价文档，让 Postman 与
 * AI Agent 拿到与客户端调用点逐字对齐的过程清单——缺了它，对外可见的接口面就只剩打点与探活。
 */

/** 响应模型的组件名，与各 `*Schema` 导出的 TS 类型别名同名，读文档和读类型不用换名字。 */
const responseModels: ReadonlyArray<readonly [string, z.ZodType]> = [
  ["AccountProfile", accountProfileSchema],
  ["PublicProfile", publicProfileSchema],
  ["MusicSession", musicSessionSchema],
  ["CloudSettings", cloudSettingsSchema],
  ["FeedbackSummary", feedbackSummarySchema],
  ["FeedbackReply", feedbackReplySchema],
  ["FeedbackDetail", feedbackDetailSchema],
  ["AdminUser", adminUserSchema],
  ["AdminUserDetail", adminUserDetailSchema],
  ["GameRecordItem", gameRecordItemSchema],
  ["GameRecordDetail", gameRecordDetailSchema],
  ["AdminFeedback", adminFeedbackSchema],
  ["AdminFeedbackDetail", adminFeedbackDetailSchema],
  ["AdminRoom", adminRoomSchema],
  ["AdminOverview", adminOverviewSchema],
  ["SentryOverview", sentryOverviewSchema],
  ["QQLookupStatus", qqLookupStatusSchema],
  ["AuditEntry", auditEntrySchema],
];

/** 登记了 `id` 的 schema 会被 `toJSONSchema` 抽成 `$defs`，随后升格为 `components.schemas`。 */
const responseRegistry = z.registry<{ id: string }>();
for (const [name, schema] of responseModels) responseRegistry.add(schema, { id: name });

const REF_PREFIX = "#/$defs/";
const COMPONENT_REF_PREFIX = "#/components/schemas/";

const liftRefs = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(liftRefs) as unknown as T;
  if (!value || typeof value !== "object") return value;
  const node = value as Json;
  const ref = node.$ref;
  if (typeof ref === "string" && ref.startsWith(REF_PREFIX)) {
    return {
      ...node,
      $ref: `${COMPONENT_REF_PREFIX}${ref.slice(REF_PREFIX.length)}`,
    } as unknown as T;
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, item]) => [key, liftRefs(item)])
  ) as unknown as T;
};

/** 输入整段内联（请求体一眼看完）；输出把登记过的模型抽成公共组件。 */
const jsonSchemaOf = (
  schema: z.ZodType,
  io: "input" | "output"
): { node: Json; defs: Record<string, Json> } => {
  const generated = z.toJSONSchema(schema, {
    io,
    target: "draft-2020-12",
    reused: "inline",
    ...(io === "output" ? { metadata: responseRegistry } : {}),
  }) as Json;
  const defs = generated.$defs as Record<string, Json> | undefined;
  delete generated.$defs;
  delete generated.$schema;
  return { node: liftRefs(generated), defs: liftRefs(defs ?? {}) };
};

/** 过程没声明输出时的占位（当前契约每条都有输出，留着是为了生成器不依赖这个前提）。 */
const NO_SCHEMA: { node: Json; defs: Record<string, Json> } = { node: {}, defs: {} };

/** oRPC 的线格式：请求与成功响应都只有一层 `json` 包络，业务数据在里面。 */
const envelope = (schema: Json): Json => ({
  type: "object",
  properties: { json: schema },
  required: ["json"],
});

interface OrpcProcedureNode {
  readonly "~orpc": {
    readonly meta?: Record<string, unknown>;
    readonly inputSchema?: z.ZodType;
    readonly outputSchema?: z.ZodType;
  };
}

const isProcedure = (node: unknown): node is OrpcProcedureNode =>
  typeof node === "object" && node !== null && "~orpc" in node;

export interface RpcOperation {
  readonly segments: readonly string[];
  readonly operationId: string;
  readonly tag: string;
  readonly auth: RpcAuth;
  readonly description: string;
  readonly inputSchema: z.ZodType | undefined;
  readonly outputSchema: z.ZodType | undefined;
}

const TAGS: Record<string, string> = {
  site: "Site",
  account: "Account",
  settings: "Settings",
  feedback: "Feedback",
  admin: "Admin",
};

const TAG_DESCRIPTIONS: Record<string, string> = {
  Site: "站点访问打点。",
  Account: "QQ 邮箱验证码登录、账号资料与公开资料卡。",
  Settings: "跨设备云同步的偏好与音乐账号会话。",
  Feedback: "玩家提交的站内反馈。",
  Admin: "管理后台：账号、反馈、房间、对局记录、审计与统计。全部要求管理员角色。",
};

const procedureOf = (segments: readonly string[], node: OrpcProcedureNode): RpcOperation => {
  const meta = node["~orpc"].meta ?? {};
  const auth = meta.auth;
  if (auth !== "public" && auth !== "session" && auth !== "admin") {
    throw new Error(`契约过程 ${segments.join(".")} 的 meta.auth 缺失或不是 public/session/admin`);
  }
  const description = meta.description;
  if (typeof description !== "string" || description.length === 0) {
    throw new Error(`契约过程 ${segments.join(".")} 缺少 meta.description`);
  }
  return {
    segments,
    operationId: segments.join("."),
    tag: TAGS[segments[0] ?? ""] ?? "Other",
    auth,
    description,
    inputSchema: node["~orpc"].inputSchema,
    outputSchema: node["~orpc"].outputSchema,
  };
};

const walk = (node: unknown, segments: readonly string[]): RpcOperation[] => {
  if (isProcedure(node)) return [procedureOf(segments, node)];
  if (!node || typeof node !== "object") return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) =>
    walk(child, [...segments, key])
  );
};

/** 契约里的全部过程，顺序与 `ApiContract.ts` 的书写顺序一致。 */
export const rpcOperations: RpcOperation[] = walk(apiContract, []);

const ERROR_RESPONSES: Record<string, string> = {
  BadRequest:
    "请求体不合法：JSON 无法解析、缺 `json` 包络，或字段没通过契约校验（`json.data.issues` 给出具体字段）。",
  Unauthorized: "缺少或已失效的会话 Cookie。",
  Forbidden: "已登录但角色不是管理员，或账号处于封禁中。",
  RateLimited:
    "超出 RPC 前缀的额度（60 秒滑动窗口内单客户端 300 次）。响应带 `X-RateLimit-*` 与 `Retry-After`，按 `Retry-After` 等待后重试即可。",
  InternalError: "服务端内部异常，调用方无法预防。",
  AccountDisabled: "服务端未配置数据库，账号系统整体停用；前端保留入口并就地提示不可用。",
};

const RPC_ERROR_SCHEMA: Json = {
  type: "object",
  required: ["json"],
  properties: {
    json: {
      type: "object",
      required: ["defined", "code", "status", "message"],
      properties: {
        defined: {
          type: "boolean",
          const: false,
          description: "固定为 false：错误由传输层产出，不在过程的错误声明里。",
        },
        code: {
          type: "string",
          description:
            "业务错误码，客户端据此分支。常见值：BAD_REQUEST（请求体不合法）、UNAUTHORIZED（未登录）、" +
            "FORBIDDEN 与 ACCOUNT_BANNED（无权限或已封禁）、RATE_LIMITED（超额度）、ACCOUNT_DISABLED（账号系统未启用）、" +
            "INTERNAL_ERROR 与 INTERNAL_SERVER_ERROR（服务端异常）、QQ_LOOKUP_DISABLED 等 503 类依赖不可用码。",
        },
        status: { type: "integer", description: "与 HTTP 状态码一致。" },
        message: { type: "string", description: "可直接展示给玩家的中文文案。" },
        data: {
          type: "object",
          description: "部分错误附带细节，例如入参校验失败时的 `issues` 数组。",
        },
      },
    },
  },
};

const rpcResponses = (): Record<string, Json> =>
  Object.fromEntries(
    Object.entries(ERROR_RESPONSES).map(([name, description]) => [
      name,
      { description, content: { "application/json": { schema: RPC_ERROR_SCHEMA } } },
    ])
  );

const responsesOf = (auth: RpcAuth, schema: Json): Json => ({
  "200": {
    description: "调用成功；业务数据在 `json` 字段内。",
    content: { "application/json": { schema: envelope(schema) } },
  },
  "400": { $ref: "#/components/responses/BadRequest" },
  ...(auth === "public" ? {} : { "401": { $ref: "#/components/responses/Unauthorized" } }),
  ...(auth === "admin" ? { "403": { $ref: "#/components/responses/Forbidden" } } : {}),
  "429": { $ref: "#/components/responses/RateLimited" },
  "500": { $ref: "#/components/responses/InternalError" },
  "503": { $ref: "#/components/responses/AccountDisabled" },
});

const requestBodyOf = (operation: RpcOperation): Json => {
  if (!operation.inputSchema) {
    return {
      required: false,
      description: "该过程无入参：请求体给 `{}` 即可，`json` 包络可省。",
      content: { "application/json": { schema: { type: "object" } } },
    };
  }
  return {
    required: true,
    content: {
      "application/json": { schema: envelope(jsonSchemaOf(operation.inputSchema, "input").node) },
    },
  };
};

const collectSchemas = (
  operations: RpcOperation[]
): { paths: Record<string, Json>; schemas: Record<string, Json> } => {
  const defs: Record<string, Json> = {};
  const paths: Record<string, Json> = {};
  for (const operation of operations) {
    const response = operation.outputSchema
      ? jsonSchemaOf(operation.outputSchema, "output")
      : NO_SCHEMA;
    Object.assign(defs, response.defs);
    paths[operation.operationId] = {
      tags: [operation.tag],
      operationId: operation.operationId,
      summary: operation.operationId,
      description: operation.description,
      security: operation.auth === "public" ? [] : [{ sessionCookie: [] }],
      requestBody: requestBodyOf(operation),
      responses: responsesOf(operation.auth, response.node),
    };
  }
  // 组件名按登记顺序回写：同一份契约重复生成的结果稳定，不会因为遍历顺序在 diff 里漂。
  const schemas = responseModels.reduce<Record<string, Json>>((acc, [name]) => {
    const schema = defs[name];
    if (schema) acc[name] = schema;
    return acc;
  }, {});
  const missing = Object.keys(defs).filter((name) => !schemas[name]);
  if (missing.length > 0) throw new Error(`响应组件生成不完整：${missing.join(", ")}`);
  return { paths, schemas };
};

/**
 * 生成可直接并入 Elysia 文档的片段，`paths` 的键是「基址 + 点号路径换斜杠」。
 *
 * 基址由调用方传入 `RPC_BASE_PATH`，本模块不复制这个常量：常量只在一处定义，
 * 前缀改了文档跟着改，不会出现「代码挂了 `/api/rpc`、文档写着别处」的漂移。
 */
export const buildRpcOpenApiFragment = (basePath: string) => {
  const { paths, schemas } = collectSchemas(rpcOperations);
  return {
    paths: Object.fromEntries(
      Object.entries(paths).map(([operationId, operation]) => [
        `${basePath}/${operationId.replaceAll(".", "/")}`,
        { post: operation },
      ])
    ),
    components: { schemas, responses: rpcResponses() },
    tags: [...new Set(rpcOperations.map(({ tag }) => tag))].map((name) => ({
      name,
      description: TAG_DESCRIPTIONS[name] ?? "",
    })),
  };
};

/** 文档级协议说明：包络、方法、Cookie 三件事，Agent 照着它才能打通第一个请求。 */
export const RPC_PROTOCOL_NOTES = [
  "账号 API 走 oRPC：`POST /api/rpc/<过程路径>`，过程路径就是客户端调用点的点号路径换成斜杠（`account.requestLoginCode` → `/api/rpc/account/requestLoginCode`）。",
  '请求头必须带 `content-type: application/json`。请求体与成功响应都只有一层 `json` 包络：请求 `{"json": {…入参}}`，响应 `{"json": {…返回值}}`；无入参的过程请求体给 `{}`。',
  '只用 POST。GET 能匹配到过程但回 405 `METHOD_NOT_SUPPORTED`；路径拼错回 404，且用的是 HTTP 信封 `{"error": …}` 而不是 RPC 信封。',
  "标了 `security` 的过程需要登录会话 Cookie（`bakagame.session_token`，由 `/api/auth/sign-in/email-otp` 下发，HttpOnly）；`Admin` 标签下还额外要求管理员角色。",
  '失败响应见 `components.responses`，统一为 `{"json": {"defined": false, code, status, message, data?}}`；`message` 可直接展示给玩家。',
  "整个 `/api/rpc/*` 前缀限流：60 秒滑动窗口内单客户端 300 次、全局 12000 次，超限回 429 并带 `Retry-After`。",
  "三款游戏的实时对局不在本文档内，走 WebSocket：`/api/whoisfaker/ws`、`/api/songuessr/ws`、`/api/cee/ws`。",
].join("\n");
