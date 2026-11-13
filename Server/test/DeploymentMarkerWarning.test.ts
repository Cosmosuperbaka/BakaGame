import { expect, test } from "bun:test";

import type { AppEnv } from "../src/config/Env";
import { EventLogger } from "../src/infrastructure/EventLogger";
import type { OtelLogRecord } from "../src/infrastructure/logging/OtelLog";
import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import { createTestApp } from "./AppFixtures";

const MARKER_WARNING = "未显式注入部署环境标记";

const envOf = (overrides: Partial<AppEnv>): AppEnv =>
  ({
    serverUrl: "http://127.0.0.1:4850",
    serverListenHost: "127.0.0.1",
    serverPort: 0,
    bangumiApiUrl: "https://api.bgm.tv",
    bangumiImageUrl: "",
    ...overrides,
  }) as AppEnv;

const boot = (env: AppEnv, logger: EventLogger) =>
  createTestApp({
    env,
    logger,
    games: { faker: new WhoIsFakerService({ eventLogger: logger }) },
  });

const captureLogger = () => {
  const records: OtelLogRecord[] = [];
  const logger = new EventLogger(undefined, undefined, undefined, undefined, {
    sinks: [{ write: (record) => records.push(record) }],
  });
  return {
    logger,
    markerWarnings: () =>
      records.filter((record) => JSON.stringify(record.body).includes(MARKER_WARNING)),
  };
};

test("配了数据库却缺显式环境标记：启动照常成功，只记一条告警", () => {
  const { logger, markerWarnings } = captureLogger();
  const env = envOf({
    databaseUrl: "mysql://u:p@db.example.com/app",
    deploymentMarkerExplicit: false,
  });
  expect(() => boot(env, logger)).not.toThrow();
  boot(env, logger);
  expect(markerWarnings()).toHaveLength(1);
  expect(JSON.stringify(markerWarnings()[0].body)).toContain("DEPLOYMENT_ENVIRONMENT");
});

test("标记齐全，或没有生产凭据的本地启动：不出告警", () => {
  const explicit = captureLogger();
  boot(
    envOf({ databaseUrl: "mysql://u:p@db.example.com/app", deploymentMarkerExplicit: true }),
    explicit.logger
  );
  expect(explicit.markerWarnings()).toHaveLength(0);

  const local = captureLogger();
  boot(envOf({ deploymentMarkerExplicit: false }), local.logger);
  expect(local.markerWarnings()).toHaveLength(0);
});
