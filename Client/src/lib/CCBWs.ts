import { createWebSocketClient } from "@/lib/WebsocketClient";

export const CCBWs = createWebSocketClient("/api/ccb/ws");
