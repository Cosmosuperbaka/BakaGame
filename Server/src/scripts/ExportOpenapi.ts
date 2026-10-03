import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Elysia } from "elysia";
import { createSwaggerPlugin } from "../transport/Openapi";
import { systemRoutes } from "../transport/routes/System";
import { sentryTunnelRoutes } from "../transport/routes/SentryTunnel";

/** 只装配 HTTP 契约，不构造游戏服务、SQLite Worker 或遥测出口。 */
export function createDocumentationApp(serverUrl = "http://localhost:4850") {
  return new Elysia({ normalize: false }).use(createSwaggerPlugin({ serverUrl }))
    .use(systemRoutes({})).use(sentryTunnelRoutes({}));
}

if (import.meta.main) {
  const app = createDocumentationApp(process.env.SERVER_URL || "http://localhost:4850");
  const response = await app.handle(new Request("http://localhost/openapi/json"));
  if (!response.ok) throw new Error("HTTP 契约生成失败");
  const document = await response.json();
  if (!document.paths?.["/readyz"]) throw new Error("生成文档遗漏就绪契约");
  const outputPath = resolve(import.meta.dir, "../../../Agents/http-openapi.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}
