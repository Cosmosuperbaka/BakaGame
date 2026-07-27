import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { RoomService } from "../application/room-service";
import { readEnv } from "../config/env";
import { createVersionInfo } from "../config/version";
import { EventLogger } from "../infrastructure/event-logger";
import { WordBankRepository } from "../infrastructure/word-bank-repository";
import { createApp } from "../transport/app";

// ==================== 导出静态 OpenAPI 快照 ====================

const run = async () => {
  const env = readEnv();
  const versionInfo = createVersionInfo(env.gitCommit);
  const logger = new EventLogger();
  const roomService = new RoomService({
    eventLogger: logger,
    wordBankRepository: new WordBankRepository(env.wordBankPath),
  });

  const { app } = createApp({
    env,
    roomService,
    versionInfo,
    logger,
  });

  const response = await app.handle(new Request("http://localhost/openapi/json"));
  const openApiDocument = await response.json();

  const outputPath = resolve(process.cwd(), "../Agents/http-openapi.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(openApiDocument, null, 2)}\n`, "utf8");
};

await run();
