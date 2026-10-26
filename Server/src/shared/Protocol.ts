// ==================== WebSocket 协议封包类型 ====================

/** 三款游戏的稳定标识：统一 ws 入口按它分发命令，客户端与 MCP 共用同一份取值。 */
export const GAME_IDS = ["faker", "song", "cee"] as const;

export type GameId = (typeof GAME_IDS)[number];

export const isGameId = (value: unknown): value is GameId =>
  typeof value === "string" && (GAME_IDS as readonly string[]).includes(value);

/**
 * 命令信封。`game` 只在**统一入口**（`/api/ws`）上用于分发：
 * 大多数命令的类型名本身带 `song.` / `cee.` 前缀可以推断，但 `mcp.*` 这类
 * 三款游戏同名的命令必须由调用方显式声明归属。旧路径与旧客户端不带该字段。
 */
export interface ClientEnvelope<TType extends string, TPayload> {
  id: string;
  traceId?: string;
  game?: GameId;
  type: TType;
  roomId?: string;
  sessionToken?: string;
  payload: TPayload;
}

export interface AckPacket {
  type: "ack";
  id: string;
  traceId?: string;
  requestType: string;
  payload?: unknown;
}

export interface ErrorPacket {
  type: "error";
  id: string;
  traceId?: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface EventPacket {
  type: "event";
  event: string;
  payload: unknown;
}

/** RFC 6902 (JSON Patch) 标准操作定义 */
export type StatePatchOperation =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown }
  | { op: "move"; from: string; path: string }
  | { op: "copy"; from: string; path: string }
  | { op: "test"; path: string; value: unknown };

export type StateSyncPayload<T> =
  | {
      mode: "full";
      revision: number;
      state: T;
    }
  | {
      mode: "patch";
      baseRevision: number;
      revision: number;
      operations: StatePatchOperation[];
    };

export type ServerMessage = AckPacket | ErrorPacket | EventPacket;

export const SERVER_SHUTDOWN_MESSAGE =
  "服务器已关闭，这通常是因为更新导致的重启，请重新进入游戏。若长时间不可用则可能为未知Bug，请加入QQ群反馈。";
