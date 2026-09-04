import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

import { readEnv } from "../src/config/Env";
import { AppError } from "../src/domain/Errors";

describe("readEnv 环境变量与启动断言", () => {
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
});
