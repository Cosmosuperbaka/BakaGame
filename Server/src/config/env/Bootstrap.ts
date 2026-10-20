import { AppError } from "../../domain/Errors";

/** 只有这些主机名说明服务在本地回环上，监听地址才跟随 `SERVER_URL` 的 hostname。 */
const LOCAL_LISTEN_HOSTS = new Set(["0.0.0.0", "127.0.0.1", "localhost", "::1"]);

const DEFAULT_CLIENT_URL = "http://localhost:5173";

/**
 * 进程拓扑（T0）：描述「我在哪、谁可信」，改了必须重启，不能热更。
 * 分层口径见 `Agents/Conventions.md` §5。
 */
export interface EnvBootstrap {
  /** `CLIENT_URL`：逗号分隔的可信来源列表，同时是 CORS 与 WebSocket 的准入名单。 */
  clientUrl: string;
  serverUrl: string;
  serverListenHost: string;
  serverPort: number;
}

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

const resolveListenHost = (serverUrl: URL): string => {
  if (Bun.env.SERVER_LISTEN_HOST) return Bun.env.SERVER_LISTEN_HOST;
  if (LOCAL_LISTEN_HOSTS.has(serverUrl.hostname) && Bun.env.SERVER_URL) {
    return serverUrl.hostname;
  }
  return "0.0.0.0";
};

export const readBootstrapEnv = (): EnvBootstrap => {
  const rawPort = Bun.env.SERVER_PORT ?? "4850";
  const serverPort = Number(rawPort);
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    throw new AppError(
      "CONFIG_ERROR",
      `环境变量 SERVER_PORT 必须为 1~65535 之间的合法端口号，收到: "${rawPort}"`
    );
  }

  const serverUrl = normalizeServerUrl(
    Bun.env.SERVER_URL ?? `http://127.0.0.1:${serverPort}`,
    serverPort
  );

  // 显式配置成空串（CLIENT_URL=""）时必须回落到默认值，不能把空串透出去：
  // 下游 `isAllowedOrigin` 见到空串会当成「未限制来源」而放行全部 Origin。
  const clientUrl = (Bun.env.CLIENT_URL ?? "").trim() || DEFAULT_CLIENT_URL;

  return {
    clientUrl,
    serverUrl: serverUrl.toString().replace(/\/$/, ""),
    serverListenHost: resolveListenHost(serverUrl),
    serverPort,
  };
};
