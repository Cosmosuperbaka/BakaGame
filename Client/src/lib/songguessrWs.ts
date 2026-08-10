import { createWebSocketClient } from "@/lib/websocketClient";

export const songGuessrWs = createWebSocketClient("/api/songguessr/ws");
