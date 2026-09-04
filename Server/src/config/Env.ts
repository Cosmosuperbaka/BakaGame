import { resolve } from "node:path";

const LOCAL_LISTEN_HOSTS = new Set(["0.0.0.0", "127.0.0.1", "localhost", "::1"]);

export interface AppEnv {
  clientUrl: string;
  serverUrl: string;
  serverListenHost: string;
  serverPort: number;
  wordBankPath: string;
  otelEndpoint?: string;
  otelHeaders?: Record<string, string>;
  otelServiceName?: string;
}

// ==================== 环境变量解析 ====================

const parseOtelHeaders = (raw?: string): Record<string, string> | undefined => {
  if (!raw) return undefined;
  const headers: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      const key = part.slice(0, eqIdx).trim();
      let value = part.slice(eqIdx + 1).trim();
      try {
        value = decodeURIComponent(value);
      } catch {
        // 解码异常时退回原始值
      }
      headers[key] = value;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
};

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
    wordBankPath: resolve(process.cwd(), "storage/word-bank.json"),
    otelEndpoint: Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelHeaders: parseOtelHeaders(Bun.env.OTEL_EXPORTER_OTLP_HEADERS),
    otelServiceName: Bun.env.OTEL_SERVICE_NAME ?? "bakagame-server",
  };
};
