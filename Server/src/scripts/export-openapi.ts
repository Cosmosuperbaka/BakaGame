import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { readEnv } from "../config/env";
import { createVersionInfo } from "../config/version";
import { buildOpenApiDocument } from "../transport/openapi";

// ==================== 导出静态 OpenAPI 快照 ====================

const run = async () => {
  const env = readEnv();
  const versionInfo = createVersionInfo(env.gitCommit);
  const outputPath = resolve(process.cwd(), "../Agents/http-openapi.json");
  const openApiDocument = buildOpenApiDocument({
    serverUrl: env.serverUrl,
    versionInfo,
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(openApiDocument, null, 2)}\n`, "utf8");
};

await run();
