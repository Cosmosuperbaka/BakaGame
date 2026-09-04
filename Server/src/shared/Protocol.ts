

// ==================== WebSocket 协议封包类型 ====================

export interface ClientEnvelope<TType extends string, TPayload> {
  id: string;
  traceId?: string;
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

export type StatePathSegment = string | number;

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
