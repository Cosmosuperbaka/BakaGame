import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { RPC_BASE_PATH } from "../src/transport/routes/Account";
import { RPC_PROTOCOL_NOTES, buildRpcOpenApiFragment, rpcOperations, type RpcOperation } from "../src/scripts/RpcOpenapi";
import { DOC_SERVER_URL, OPENAPI_DOC_PATH, renderOpenApiDocument } from "../src/scripts/ExportOpenapi";
import { createAccountTestApp } from "./AccountFixtures";

type Json = Record<string, unknown>;

/**
 * 路径清单钉在这里：新增过程没写 `meta` 会在生成器里抛错，写漏在文档里则在这里报红。
 * 这些点号路径就是客户端的调用点（`client.account.me()` → `/api/rpc/account/me`）。
 */
const EXPECTED_OPERATIONS = [
  "site.visit",
  "account.requestLoginCode",
  "account.me",
  "account.updateProfile",
  "account.publicProfile",
  "settings.get",
  "settings.savePreferences",
  "settings.saveMusicSession",
  "feedback.create",
  "feedback.listMine",
  "feedback.get",
  "admin.users.list",
  "admin.users.get",
  "admin.users.ban",
  "admin.users.unban",
  "admin.users.setRole",
  "admin.users.revokeSessions",
  "admin.feedback.list",
  "admin.feedback.get",
  "admin.feedback.reply",
  "admin.feedback.setStatus",
  "admin.rooms.list",
  "admin.rooms.close",
  "admin.rooms.kick",
  "admin.games.list",
  "admin.games.get",
  "admin.audit.list",
  "admin.qq.status",
  "admin.qq.refreshNames",
  "admin.stats.overview",
  "admin.stats.sentry",
];

/** Elysia 自己声明的那几条 HTTP 路径：打点、探活、优雅停机、Sentry 隧道。 */
const HTTP_PATH_COUNT = 6;

const pathOf = (operationId: string): string => `${RPC_BASE_PATH}/${operationId.replaceAll(".", "/")}`;

const collectRefs = (node: unknown, found: string[] = []): string[] => {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found);
    return found;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") found.push(value);
      else collectRefs(value, found);
    }
  }
  return found;
};

const postOf = (paths: Json, operationId: string): Json => (paths[pathOf(operationId)] as Json).post as Json;

const mediaSchema = (content: unknown): Json => ((content as Json)["application/json"] as Json).schema as Json;

const fragment = buildRpcOpenApiFragment(RPC_BASE_PATH);
const byId = new Map<string, RpcOperation>(rpcOperations.map((operation) => [operation.operationId, operation]));

test("每个过程都带机器可读的说明，路径清单不漂移", () => {
  expect(rpcOperations.map(({ operationId }) => operationId).sort()).toEqual([...EXPECTED_OPERATIONS].sort());
  expect(Object.keys(fragment.paths).sort()).toEqual(EXPECTED_OPERATIONS.map(pathOf).sort());
  for (const operation of rpcOperations) {
    expect(operation.description.length).toBeGreaterThan(0);
    expect(["public", "session", "admin"]).toContain(operation.auth);
  }
});

test("文档标注的 security 与真实路由套用的鉴权层级一致", async () => {
  const { rpc, signIn } = createAccountTestApp();
  const { cookie } = await signIn("246813579");

  for (const { operationId, auth } of rpcOperations) {
    const slashPath = operationId.replaceAll(".", "/");
    // 未登录：受保护的过程必须 401，公开的过程不能 401。
    const anonymous = await rpc(slashPath);
    expect(anonymous.status === 401).toBe(auth !== "public");
    // 普通玩家：管理员过程必须 403，其余不能因为角色被拒。
    const signedIn = await rpc(slashPath, undefined, cookie);
    expect(signedIn.status === 403).toBe(auth === "admin");
  }
});

test("生成的路径在真实路由上打得通：POST 命中、GET 回 405、拼错回 404 的 HTTP 信封", async () => {
  const { app, rpc } = createAccountTestApp();

  const me = await rpc("account/me");
  expect(me.status).toBe(200);
  expect(me.body).toBeNull();

  // 有入参的过程不给 `json` 包络时按 oRPC 口径回 400，不能被当成无入参放过。
  const noEnvelope = await app.handle(new Request(`http://localhost${pathOf("site.visit")}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: "{}",
  }));
  expect(noEnvelope.status).toBe(400);

  const get = await app.handle(new Request(`http://localhost${pathOf("account.me")}`, {
    method: "GET",
    headers: { origin: "http://localhost:5173" },
  }));
  expect(get.status).toBe(405);
  expect(((await get.json()) as { json: Json }).json.code).toBe("METHOD_NOT_SUPPORTED");

  expect((await rpc("account/no-such-procedure")).status).toBe(404);
});

test("请求与响应都包在 json 包络里，失败体共用 RPC 错误信封", () => {
  for (const operationId of EXPECTED_OPERATIONS) {
    const post = postOf(fragment.paths, operationId);
    const requestBody = post.requestBody as Json;
    const requestSchema = mediaSchema(requestBody.content);
    if (byId.get(operationId)!.inputSchema === undefined) {
      expect(requestBody.required).toBe(false);
      expect(requestSchema).toEqual({ type: "object" });
    } else {
      expect(requestBody.required).toBe(true);
      expect(Object.keys(requestSchema.properties as Json)).toEqual(["json"]);
    }

    const response = (post.responses as Json)["200"] as Json;
    expect(Object.keys(mediaSchema(response.content).properties as Json)).toEqual(["json"]);
  }

  expect(Object.keys(fragment.components.responses)).toEqual([
    "BadRequest", "Unauthorized", "Forbidden", "RateLimited", "InternalError", "AccountDisabled",
  ]);
  expect(Object.keys(postOf(fragment.paths, "admin.users.ban").responses as Json))
    .toEqual(["200", "400", "401", "403", "429", "500", "503"]);
  expect(Object.keys(postOf(fragment.paths, "account.me").responses as Json))
    .toEqual(["200", "400", "429", "500", "503"]);
});

test("合并后的文档版本取自更新日志，且每个 $ref 都解析得到", async () => {
  const document = await renderOpenApiDocument(DOC_SERVER_URL);

  expect(String((document.info as Json).version)).toMatch(/^\d+\.\d+\.\d+$/);
  expect(String((document.info as Json).description)).toContain(RPC_PROTOCOL_NOTES.slice(0, 24));
  expect((document.components as Json).securitySchemes).toEqual({
    sessionCookie: expect.objectContaining({ type: "apiKey", in: "cookie", name: "bakagame.session_token" }),
  });

  const paths = Object.keys(document.paths as Json);
  expect(paths).toContain("/readyz");
  expect(paths).toContain("/api/monitoring/telemetry");
  expect(paths).toContain(pathOf("settings.get"));
  expect(paths).toHaveLength(EXPECTED_OPERATIONS.length + HTTP_PATH_COUNT);

  const components = document.components as Json;
  for (const ref of collectRefs(document)) {
    const [kind, name] = ref.replace("#/components/", "").split("/");
    expect(kind).toBeOneOf(["schemas", "responses"]);
    expect(((components[kind === "responses" ? "responses" : "schemas"] as Json)[name])).toBeObject();
  }
});

test("提交在库的契约文档与当前代码一致：改了契约要重跑 docs:openapi", async () => {
  const committed = JSON.parse(await readFile(OPENAPI_DOC_PATH, "utf8")) as Json;
  const paths = committed.paths as Json;
  const components = committed.components as Json;

  // 只比契约决定的那部分：Elysia 自己那几条 HTTP 路由的 schema 会随同进程里先装配过哪个
  // 完整应用而漂移（TypeBox 的全局注册表是共享的），拿它做等值断言会假红。
  expect(Object.keys(paths).filter((path) => path.startsWith(`${RPC_BASE_PATH}/`)).sort())
    .toEqual(Object.keys(fragment.paths).sort());
  for (const [path, operation] of Object.entries(fragment.paths)) expect(paths[path]).toEqual(operation);

  const schemas = components.schemas as Json;
  for (const [name, schema] of Object.entries(fragment.components.schemas)) expect(schemas[name]).toEqual(schema);
  expect(components.responses).toEqual(fragment.components.responses);
  expect(committed.tags).toEqual(expect.arrayContaining(fragment.tags));
  expect(String((committed.info as Json).version)).toMatch(/^\d+\.\d+\.\d+$/);
  expect(String((committed.info as Json).description)).toContain(RPC_PROTOCOL_NOTES.slice(0, 24));
  // 产物提交在库，基址只能是本地占位：部署主机名（可能是内网名）不该进仓库。
  expect(committed.servers).toEqual([{ url: DOC_SERVER_URL }]);
});
