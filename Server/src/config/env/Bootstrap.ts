import { AppError } from "../../domain/Errors";
import {
  isRoomSnapshotGame,
  parseRoomSnapshotGames,
  ROOM_SNAPSHOT_GAMES,
  type RoomSnapshotGame,
} from "../../shared/RoomSnapshot";

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
  /**
   * 本进程负责的游戏（`SHARD_GAMES`）：只有这些游戏的房间会被导出与恢复。
   * 缺省 `undefined` 表示全部负责 —— 单进程部署不配它就是全量。
   *
   * 为什么必须显式声明：多个容器共用同一份代码目录、也都注册了全部三条 WS 路由，
   * 若不区分角色，只接 CEE 流量的那片启动时会把主片的房间一并恢复出来，
   * 得到一个没人连得进来、却在跑定时器、还可能写对局记录的影子房间。
   */
  shardGames?: RoomSnapshotGame[];
  /** 房间快照目录；缺省由调用方取 Server/storage。 */
  roomSnapshotDirectory?: string;
  /** Agent（MCP）接入总开关；缺省关闭，关闭时握手直接拒绝 Agent 连接。 */
  mcpEnabled?: boolean;
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
    shardGames: readShardGames(),
    roomSnapshotDirectory: (Bun.env.ROOM_SNAPSHOT_DIR ?? "").trim() || undefined,
    mcpEnabled: Bun.env.MCP_ENABLED === "true",
  };
};

/**
 * 读取片角色。写错名字直接拒绝启动：静默回落到「全部负责」会让两片都恢复全部房间，
 * 而这恰好是本变量要防的情况，出错时宁可起不来。
 */
const readShardGames = (): RoomSnapshotGame[] | undefined => {
  const raw = (Bun.env.SHARD_GAMES ?? "").trim();
  if (!raw) return undefined;
  const names = parseRoomSnapshotGames(raw);
  const unknown = names.filter((name) => !isRoomSnapshotGame(name));
  if (unknown.length) {
    throw new AppError(
      "CONFIG_ERROR",
      `环境变量 SHARD_GAMES 含未知游戏: "${unknown.join(", ")}"，可选 ${ROOM_SNAPSHOT_GAMES.join(" | ")}`
    );
  }
  return names as RoomSnapshotGame[];
};
