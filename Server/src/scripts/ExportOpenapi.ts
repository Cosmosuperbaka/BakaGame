import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { WhoIsFakerService } from "../application/WhoIsFakerService";
import { readEnv } from "../config/Env";
import { EventLogger } from "../infrastructure/EventLogger";
import { WordBankRepository } from "../infrastructure/WordBankRepository";
import { createApp } from "../transport/App";

// ==================== 导出静态 OpenAPI 快照 ====================

const run = async () => {
  const env = readEnv();
  const logger = new EventLogger();
  const whoIsFakerService = new WhoIsFakerService({
    eventLogger: logger,
    wordBankRepository: new WordBankRepository(env.wordBankPath),
  });

  const { app } = createApp({
    env,
    whoIsFakerService,
    logger,
  });

  const response = await app.handle(new Request("http://localhost/openapi/json"));
  const openApiDocument = await response.json();

  const outputPath = resolve(import.meta.dir, "../../../Agents/http-openapi.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(openApiDocument, null, 2)}\n`, "utf8");
};

await run();
