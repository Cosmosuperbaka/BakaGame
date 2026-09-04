import type {
  AckPacket,
  ErrorPacket,
  EventPacket,
  ServerMessage,
} from "../shared/Index";

export type { AckPacket, ErrorPacket, EventPacket, ServerMessage };

export const createAck = <TMessage extends { id: string; type: string; traceId?: string }>(
  message: TMessage,
  payload?: unknown,
): AckPacket => ({
  type: "ack",
  id: message.id,
  traceId: message.traceId,
  requestType: message.type,
  payload,
});

export const createErrorPacket = (
  id: string,
  code: string,
  message: string,
  details?: unknown,
  traceId?: string,
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
