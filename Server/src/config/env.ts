import { resolve } from "node:path";

const LOCAL_LISTEN_HOSTS = new Set(["0.0.0.0", "127.0.0.1", "localhost", "::1"]);

export interface AppEnv {
  clientUrl: string;
  serverUrl: string;
  serverListenHost: string;
  serverPort: number;
  gitCommit: string;
  wordBankPath: string;
}

// ==================== 环境变量解析 ====================

const normalizeServerUrl = (value: string, port: number): URL => {
  const normalized = new URL(value);

  if (!normalized.port) {
    normalized.port = String(port);
  }

  normalized.pathname = "/";
  normalized.search = "";
  normalized.hash = "";

  return normalized;
};

const resolveListenHost = (serverUrl: URL): string =>
  LOCAL_LISTEN_HOSTS.has(serverUrl.hostname) ? serverUrl.hostname : "0.0.0.0";

export const readEnv = (): AppEnv => {
  const serverPort = Number(Bun.env.SERVER_PORT ?? 4850);
  const serverUrl = normalizeServerUrl(
    Bun.env.SERVER_URL ?? `http://127.0.0.1:${serverPort}`,
    serverPort,
  );

  return {
    clientUrl: Bun.env.CLIENT_URL ?? "http://localhost:5173",
    serverUrl: serverUrl.toString().replace(/\/$/, ""),
    serverListenHost: resolveListenHost(serverUrl),
    serverPort,
    gitCommit: Bun.env.GIT_COMMIT ?? "dev",
    wordBankPath: resolve(process.cwd(), "storage/word-bank.json"),
  };
};
