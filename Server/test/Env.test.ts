import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

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

  it("默认词库基于模块目录稳定寻址，且支持 WORD_BANK_PATH 环境变量覆盖", () => {
    const originalPath = Bun.env.WORD_BANK_PATH;
    try {
      delete Bun.env.WORD_BANK_PATH;
      const env = readEnv();
      expect(env.wordBankPath).toContain("storage");
      expect(env.wordBankPath).toContain("word-bank.json");

      Bun.env.WORD_BANK_PATH = "custom/path/bank.json";
      const customEnv = readEnv();
      expect(customEnv.wordBankPath).toBe(resolve(process.cwd(), "custom/path/bank.json"));
    } finally {
      if (originalPath !== undefined) {
        Bun.env.WORD_BANK_PATH = originalPath;
      } else {
        delete Bun.env.WORD_BANK_PATH;
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

  it("读取 Bangumi API 与图床镜像地址并移除尾斜杠", () => {
    const originalApiUrl = Bun.env.BANGUMI_API_URL;
    const originalImageUrl = Bun.env.BANGUMI_IMAGE_URL;
    try {
      delete Bun.env.BANGUMI_API_URL;
      delete Bun.env.BANGUMI_IMAGE_URL;
      expect(readEnv()).toMatchObject({
        bangumiApiUrl: "https://api.bgm.tv",
        bangumiImageUrl: "",
      });

      Bun.env.BANGUMI_API_URL = "https://api.example.test///";
      Bun.env.BANGUMI_IMAGE_URL = "https://lain.example.test/";
      expect(readEnv()).toMatchObject({
        bangumiApiUrl: "https://api.example.test",
        bangumiImageUrl: "https://lain.example.test",
      });
    } finally {
      if (originalApiUrl !== undefined) Bun.env.BANGUMI_API_URL = originalApiUrl;
      else delete Bun.env.BANGUMI_API_URL;
      if (originalImageUrl !== undefined) Bun.env.BANGUMI_IMAGE_URL = originalImageUrl;
      else delete Bun.env.BANGUMI_IMAGE_URL;
    }
  });

  it("图床回源缺省跟随绝对地址的对外前缀，切到自建图床时必须显式指定", () => {
    const keys = ["BANGUMI_IMAGE_URL", "BANGUMI_IMAGE_SOURCE"] as const;
    const saved = Object.fromEntries(keys.map(key => [key, Bun.env[key]]));
    try {
      delete Bun.env.BANGUMI_IMAGE_SOURCE;
      // 对外前缀是反代：它本身就是最佳回源。
      Bun.env.BANGUMI_IMAGE_URL = "https://mirror.example.test/";
      expect(readEnv().bangumiImageSource).toBe("https://mirror.example.test");
      // 切到自建图床后不能再拿它当回源（否则自己回自己的死循环）。
      Bun.env.BANGUMI_IMAGE_URL = "/bangumi-images";
      expect(readEnv().bangumiImageSource).toBe("");
      delete Bun.env.BANGUMI_IMAGE_URL;
      expect(readEnv().bangumiImageSource).toBe("");
      // 显式指定永远优先。
      Bun.env.BANGUMI_IMAGE_SOURCE = "https://upstream.example.test/";
      expect(readEnv().bangumiImageSource).toBe("https://upstream.example.test");
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete Bun.env[key];
        else Bun.env[key] = saved[key];
      }
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
