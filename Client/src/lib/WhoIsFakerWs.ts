import { createWebSocketClient } from "@/lib/WebsocketClient";

export const whoIsFakerWsClient = createWebSocketClient("/api/whoisfaker/ws");

export const connect = () => whoIsFakerWsClient.connect();
export const waitForConnection = (timeoutMs?: number) => whoIsFakerWsClient.waitForConnection(timeoutMs);
export const send = <T extends Record<string, unknown> = Record<string, unknown>>(
  type: string,
  payload: Record<string, unknown> = {},
  options?: { roomId?: string; sessionToken?: string; timeout?: number },
) => whoIsFakerWsClient.send<T>(type, payload, options);
export const onMessage = (handler: Parameters<typeof whoIsFakerWsClient.onMessage>[0]) =>
  whoIsFakerWsClient.onMessage(handler);
export const onStatus = (handler: Parameters<typeof whoIsFakerWsClient.onStatus>[0]) =>
  whoIsFakerWsClient.onStatus(handler);
