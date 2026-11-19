import type { AckPacket, ErrorPacket, EventPacket } from "../shared/Index";

export type { AckPacket, ErrorPacket, EventPacket };

export const createAck = <TMessage extends { id: string; type: string; traceId?: string }>(
  message: TMessage,
  payload?: unknown
): AckPacket => ({
  type: "ack",
  id: message.id,
  traceId: message.traceId,
  requestType: message.type,
  payload,
  // 服务端时刻只随确认帧下发：事件与快照帧走公共封包，不能为时间戳破坏一次封包多处复用。
  serverNow: Date.now(),
});

export const createErrorPacket = (
  id: string,
  code: string,
  message: string,
  details?: unknown,
  traceId?: string
): ErrorPacket => ({
  type: "error",
  id,
  traceId,
  error: {
    code,
    message,
    details,
  },
});

export const createEvent = (event: string, payload: unknown): EventPacket => ({
  type: "event",
  event,
  payload,
});
