import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readEnv } from "../src/config/Env";
import { createServer } from "../src/application/CreateServer";
import { AppError } from "../src/domain/Errors";

describe("readEnv 环境变量与启动断言", () => {
  it("搜索与原版房使用独立密钥，旧 URL 和超时配置不再生效", () => {
    const keys = ["AES_SECRET", "CCB_ORIGINAL_AES_SECRET", "MEILISEARCH_KEY", "CCB_MEILISEARCH_URL", "CCB_MEILISEARCH_TIMEOUT_MS"] as const;
    const saved = Object.fromEntries(keys.map(key => [key, Bun.env[key]]));
    try {
      Bun.env.AES_SECRET = "unused";
      Bun.env.CCB_ORIGINAL_AES_SECRET = "original-secret";
      Bun.env.MEILISEARCH_KEY = "search-secret";
      Bun.env.CCB_MEILISEARCH_URL = "http://example.invalid";
      Bun.env.CCB_MEILISEARCH_TIMEOUT_MS = "invalid";
      expect(readEnv()).toMatchObject({ ccbOriginalAesSecret: "original-secret", meilisearchKey: "search-secret" });
      Bun.env.MEILISEARCH_KEY = "  other-search-secret  ";
      expect(readEnv().meilisearchKey).toBe("other-search-secret");
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete Bun.env[key];
        else Bun.env[key] = saved[key];
      }
    }
  });

  it("生产服务缺少搜索密钥时拒绝以本地搜索启动", () => {
    const options = { env: { ...readEnv(), otelDeploymentEnvironment: "production", meilisearchKey: undefined } } as Parameters<typeof createServer>[0];
    expect(() => createServer(options)).toThrow(AppError);
    expect(() => createServer(options)).toThrow(/MEILISEARCH_KEY/);
  });

  it("生产服务缺少数据库时拒绝启动", () => {
    const options = { env: { ...readEnv(), otelDeploymentEnvironment: "production", meilisearchKey: "fixture-search-key" } } as Parameters<typeof createServer>[0];
    expect(() => createServer(options)).toThrow(AppError);
    expect(() => createServer(options)).toThrow(/DATABASE_URL/);
  });

  it("SENTRY_API_TOKEN 需要 SENTRY_DSN", () => {
    const keys = ["SENTRY_DSN", "SENTRY_API_TOKEN", "SENTRY_ALLOWED_PROJECT_IDS"] as const;
    const saved = Object.fromEntries(keys.map(key => [key, Bun.env[key]]));
    try {
      for (const key of keys) delete Bun.env[key];
      expect(readEnv().sentryApiToken).toBeUndefined();
      Bun.env.SENTRY_API_TOKEN = "fixture-token";
      expect(() => readEnv()).toThrow(/SENTRY_DSN/);
      Bun.env.SENTRY_DSN = "https://key@o1.ingest.us.sentry.io/2";
      expect(readEnv()).toMatchObject({ sentryApiToken: "fixture-token", sentryAllowedProjectIds: ["2"] });
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete Bun.env[key];
        else Bun.env[key] = saved[key];
      }
    }
  });

  it("账号配置随数据库启用：密钥必填，SMTP 三项须成套，ADMIN_QQ 校验号码", () => {
    const keys = ["DATABASE_URL", "BETTER_AUTH_SECRET", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM", "MAIL_DEV_CONSOLE", "ADMIN_QQ"] as const;
    const saved = Object.fromEntries(keys.map(key => [key, Bun.env[key]]));
    try {
      for (const key of keys) delete Bun.env[key];
      expect(readEnv().account).toBeUndefined();
      Bun.env.DATABASE_URL = "mysql://fixture:fixture@db.invalid:4000/bakagame";
      expect(() => readEnv()).toThrow(/BETTER_AUTH_SECRET/);
      Bun.env.BETTER_AUTH_SECRET = "x".repeat(32);
      expect(readEnv().account).toEqual({ secret: "x".repeat(32), adminQqNumbers: [], mail: { kind: "none" } });
      Bun.env.MAIL_DEV_CONSOLE = "true";
      Bun.env.ADMIN_QQ = "10001, 123456789";
      expect(readEnv().account).toMatchObject({ adminQqNumbers: ["10001", "123456789"], mail: { kind: "console" } });
      Bun.env.SMTP_HOST = "smtp.fixture.invalid";
      expect(() => readEnv()).toThrow(/SMTP_HOST、SMTP_USER、SMTP_PASS/);
      Bun.env.SMTP_USER = "noreply@fixture.invalid";
      Bun.env.SMTP_PASS = "fixture-pass";
      expect(readEnv().account?.mail).toEqual({ kind: "smtp", smtp: { host: "smtp.fixture.invalid", port: 465, user: "noreply@fixture.invalid", pass: "fixture-pass", from: "noreply@fixture.invalid" } });
      Bun.env.ADMIN_QQ = "0123";
      expect(() => readEnv()).toThrow(/ADMIN_QQ/);
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete Bun.env[key];
        else Bun.env[key] = saved[key];
      }
    }
  });

  it("生产服务的账号系统必须配置 SMTP", () => {
    const base = { ...readEnv(), otelDeploymentEnvironment: "production", meilisearchKey: "fixture-search-key" };
    const options = { env: { ...base, account: { secret: "x".repeat(32), adminQqNumbers: [], mail: { kind: "console" } } }, database: {} } as unknown as Parameters<typeof createServer>[0];
    expect(() => createServer(options)).toThrow(/SMTP_HOST/);
  });

  it("对非法端口号抛出 CONFIG_ERROR 快速失败", () => {
    const originalPort = Bun.env.SERVER_PORT;
    try {
      Bun.env.SERVER_PORT = "invalid-port";
      expect(() => readEnv()).toThrow(AppError);
      expect(() => readEnv()).toThrow(/SERVER_PORT/);

      Bun.env.SERVER_PORT = "70000";
      expect(() => readEnv()).toThrow(AppError);

      Bun.env.SERVER_PORT = "-10";
      expect(() => readEnv()).toThrow(AppError);
    } finally {
      if (originalPort !== undefined) {
        Bun.env.SERVER_PORT = originalPort;
      } else {
        delete Bun.env.SERVER_PORT;
      }
    }
  });

  it("默认监听地址为 0.0.0.0，且支持 SERVER_LISTEN_HOST 覆盖", () => {
    const originalHost = Bun.env.SERVER_LISTEN_HOST;
    const originalUrl = Bun.env.SERVER_URL;
    try {
      delete Bun.env.SERVER_LISTEN_HOST;
      delete Bun.env.SERVER_URL;
      const env = readEnv();
      expect(env.serverListenHost).toBe("0.0.0.0");

      Bun.env.SERVER_LISTEN_HOST = "127.0.0.1";
      const customEnv = readEnv();
      expect(customEnv.serverListenHost).toBe("127.0.0.1");
    } finally {
      if (originalHost !== undefined) {
        Bun.env.SERVER_LISTEN_HOST = originalHost;
      } else {
        delete Bun.env.SERVER_LISTEN_HOST;
      }
      if (originalUrl !== undefined) {
        Bun.env.SERVER_URL = originalUrl;
      } else {
        delete Bun.env.SERVER_URL;
      }
    }
  });

  it("DATABASE_URL 修剪后为空视为未配置，非空原样保留", () => {
    const original = Bun.env.DATABASE_URL;
    const originalSecret = Bun.env.BETTER_AUTH_SECRET;
    try {
      Bun.env.DATABASE_URL = "   ";
      expect(readEnv().databaseUrl).toBeUndefined();
      // 非空分支会走进账号配置校验：测试自带密钥，不依赖本地 .env（CI 干净环境没有该文件）。
      Bun.env.BETTER_AUTH_SECRET = "fixture-secret-fixture-secret-12345678";
      Bun.env.DATABASE_URL = " mysql://fixture:fixture@db.invalid:4000/bakagame ";
      expect(readEnv().databaseUrl).toBe("mysql://fixture:fixture@db.invalid:4000/bakagame");
    } finally {
      if (original !== undefined) {
        Bun.env.DATABASE_URL = original;
      } else {
        delete Bun.env.DATABASE_URL;
      }
      if (originalSecret !== undefined) {
        Bun.env.BETTER_AUTH_SECRET = originalSecret;
      } else {
        delete Bun.env.BETTER_AUTH_SECRET;
      }
    }
  });

  it("默认 Bangumi 回填缓存与词库同放 storage，且支持 BANGUMI_ENRICHMENT_PATH 覆盖", () => {
    const originalPath = Bun.env.BANGUMI_ENRICHMENT_PATH;
    try {
      delete Bun.env.BANGUMI_ENRICHMENT_PATH;
      const env = readEnv();
      expect(env.bangumiEnrichmentPath).toContain("storage");
      expect(env.bangumiEnrichmentPath).toContain("bangumi-enrichment.sqlite");

      Bun.env.BANGUMI_ENRICHMENT_PATH = "custom/path/enrichment.sqlite";
      const customEnv = readEnv();
      expect(customEnv.bangumiEnrichmentPath).toBe(resolve(process.cwd(), "custom/path/enrichment.sqlite"));
    } finally {
      if (originalPath !== undefined) {
        Bun.env.BANGUMI_ENRICHMENT_PATH = originalPath;
      } else {
        delete Bun.env.BANGUMI_ENRICHMENT_PATH;
      }
    }
  });

  it("读取 Bangumi API 地址并移除尾斜杠，图床前缀恒为 /api/bangumi", () => {
    const keys = ["BANGUMI_API_URL", "BANGUMI_IMAGES_DIR"] as const;
    const saved = Object.fromEntries(keys.map(key => [key, Bun.env[key]]));
    const emptyDir = mkdtempSync(join(tmpdir(), "env-no-images-"));
    try {
      delete Bun.env.BANGUMI_API_URL;
      Bun.env.BANGUMI_IMAGES_DIR = emptyDir;
      expect(readEnv()).toMatchObject({
        bangumiApiUrl: "https://api.bgm.tv",
        bangumiImageUrl: "/api/bangumi",
      });

      Bun.env.BANGUMI_API_URL = "https://api.example.test///";
      expect(readEnv().bangumiApiUrl).toBe("https://api.example.test");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
      for (const key of keys) {
        if (saved[key] === undefined) delete Bun.env[key];
        else Bun.env[key] = saved[key];
      }
    }
  });

  it("图床前缀写死：图床目录空不空、有没有人想改，都只能是 /api/bangumi", () => {
    const keys = ["BANGUMI_IMAGE_URL", "BANGUMI_IMAGES_DIR"] as const;
    const saved = Object.fromEntries(keys.map(key => [key, Bun.env[key]]));
    const seededDir = mkdtempSync(join(tmpdir(), "env-images-"));
    try {
      writeFileSync(join(seededDir, "images-00.sqlite"), "");
      Bun.env.BANGUMI_IMAGES_DIR = seededDir;
      delete Bun.env.BANGUMI_IMAGE_URL;
      expect(readEnv().bangumiImageUrl).toBe("/api/bangumi");
      // 前缀可配就必然有人配出边缘不放行的路径（线上整站图片变 SPA HTML），所以不认。
      Bun.env.BANGUMI_IMAGE_URL = "https://lain.example.test/";
      expect(readEnv().bangumiImageUrl).toBe("/api/bangumi");
    } finally {
      rmSync(seededDir, { recursive: true, force: true });
      for (const key of keys) {
        if (saved[key] === undefined) delete Bun.env[key];
        else Bun.env[key] = saved[key];
      }
    }
  });

  it("图床回源没有缺省值，只能由 BANGUMI_IMAGE_SOURCE 显式指定", () => {
    const keys = ["BANGUMI_IMAGE_SOURCE"] as const;
    const saved = Object.fromEntries(keys.map(key => [key, Bun.env[key]]));
    try {
      // 对外前缀是相对路径，跟着它回源 = 自己回自己的死循环，所以缺省留空（只服务已缓存的图）。
      delete Bun.env.BANGUMI_IMAGE_SOURCE;
      expect(readEnv().bangumiImageSource).toBe("");
      Bun.env.BANGUMI_IMAGE_SOURCE = "https://upstream.example.test/";
      expect(readEnv().bangumiImageSource).toBe("https://upstream.example.test");
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete Bun.env[key];
        else Bun.env[key] = saved[key];
      }
    }
  });

  it("标签增量地址不配就不跑，配了才同步", () => {
    const saved = Bun.env.BANGUMI_TAG_DIFF_URL;
    try {
      // 上游 diff 产物并不长期存在，写死默认地址只会每次启动都报「连不上」。
      delete Bun.env.BANGUMI_TAG_DIFF_URL;
      expect(readEnv().bangumiTagDiffUrl).toBeUndefined();
      Bun.env.BANGUMI_TAG_DIFF_URL = "https://mirror.example.test/id_tags.diff.json";
      expect(readEnv().bangumiTagDiffUrl).toBe("https://mirror.example.test/id_tags.diff.json");
      Bun.env.BANGUMI_TAG_DIFF_URL = "   ";
      expect(readEnv().bangumiTagDiffUrl).toBeUndefined();
    } finally {
      if (saved === undefined) delete Bun.env.BANGUMI_TAG_DIFF_URL;
      else Bun.env.BANGUMI_TAG_DIFF_URL = saved;
    }
  });

  it("运行时更新器缺省只在生产开启，速率与玩家规模可调", () => {
    const keys = ["BANGUMI_UPDATER_ENABLED", "BANGUMI_UPDATER_MIN_RATE", "BANGUMI_UPDATER_MAX_RATE", "BANGUMI_UPDATER_PLAYER_SCALE"] as const;
    const saved = Object.fromEntries(keys.map(key => [key, Bun.env[key]]));
    try {
      for (const key of keys) delete Bun.env[key];
      // 缺省走的是「非生产不开」：E2E 与本地开发不该打线上上游。
      expect(readEnv().bangumiUpdaterEnabled).toBe(false);
      expect(readEnv()).toMatchObject({ bangumiUpdaterMinRate: 10, bangumiUpdaterMaxRate: 100, bangumiUpdaterPlayerScale: 20 });
      Bun.env.BANGUMI_UPDATER_ENABLED = "true";
      expect(readEnv().bangumiUpdaterEnabled).toBe(true);
      Bun.env.BANGUMI_UPDATER_MIN_RATE = "5";
      Bun.env.BANGUMI_UPDATER_MAX_RATE = "50";
      Bun.env.BANGUMI_UPDATER_PLAYER_SCALE = "10";
      expect(readEnv()).toMatchObject({ bangumiUpdaterMinRate: 5, bangumiUpdaterMaxRate: 50, bangumiUpdaterPlayerScale: 10 });
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete Bun.env[key];
        else Bun.env[key] = saved[key];
      }
    }
  });
});

const deploymentKeys = ["DEPLOYMENT_ENVIRONMENT", "OTEL_DEPLOYMENT_ENVIRONMENT", "OTEL_RESOURCE_ATTRIBUTES", "NODE_ENV"] as const;

it("遥测环境保留完整优先级，缺省 development，明确的 production/test 不被覆盖", () => {
  const saved = Object.fromEntries(deploymentKeys.map(key => [key, Bun.env[key]]));
  try {
    for (const key of deploymentKeys) delete Bun.env[key];
    expect(readEnv().otelDeploymentEnvironment).toBe("development");
    Bun.env.NODE_ENV = "test";
    expect(readEnv().otelDeploymentEnvironment).toBe("test");
    Bun.env.NODE_ENV = "development";
    expect(readEnv().otelDeploymentEnvironment).toBe("development");
    Bun.env.NODE_ENV = "production";
    expect(readEnv().otelDeploymentEnvironment).toBe("production");
    Bun.env.OTEL_RESOURCE_ATTRIBUTES = "service.name=fixture,deployment.environment=resource%2Dstaging";
    expect(readEnv().otelDeploymentEnvironment).toBe("resource-staging");
    Bun.env.OTEL_DEPLOYMENT_ENVIRONMENT = "otel-staging";
    expect(readEnv().otelDeploymentEnvironment).toBe("otel-staging");
    Bun.env.DEPLOYMENT_ENVIRONMENT = "production";
    expect(readEnv().otelDeploymentEnvironment).toBe("production");
    Bun.env.DEPLOYMENT_ENVIRONMENT = "preview";
    expect(readEnv().otelDeploymentEnvironment).toBe("preview");
    delete Bun.env.DEPLOYMENT_ENVIRONMENT;
    expect(readEnv().otelDeploymentEnvironment).toBe("otel-staging");
    delete Bun.env.OTEL_DEPLOYMENT_ENVIRONMENT;
    expect(readEnv().otelDeploymentEnvironment).toBe("resource-staging");
    delete Bun.env.OTEL_RESOURCE_ATTRIBUTES;
    expect(readEnv().otelDeploymentEnvironment).toBe("production");
    delete Bun.env.NODE_ENV;
    expect(readEnv().otelDeploymentEnvironment).toBe("development");
  } finally {
    for (const key of deploymentKeys) {
      if (saved[key] === undefined) delete Bun.env[key]; else Bun.env[key] = saved[key];
    }
  }
});
