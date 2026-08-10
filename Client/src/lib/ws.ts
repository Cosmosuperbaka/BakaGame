import { createWebSocketClient } from "@/lib/websocketClient";

const client = createWebSocketClient("/api/whoisfaker/ws");

export const connect = () => client.connect();
export const waitForConnection = (timeoutMs?: number) => client.waitForConnection(timeoutMs);
export const send = <T extends Record<string, unknown> = Record<string, unknown>>(
  type: string,
  payload: Record<string, unknown> = {},
  options?: { roomId?: string; sessionToken?: string; timeout?: number },
) => client.send<T>(type, payload, options);
export const onMessage = (handler: Parameters<typeof client.onMessage>[0]) =>
  client.onMessage(handler);
export const onStatus = (handler: Parameters<typeof client.onStatus>[0]) =>
  client.onStatus(handler);
