import { createWebSocketClient } from "@/lib/WebsocketClient";

export const sonGuessrWs = createWebSocketClient("/api/songuessr/ws");
