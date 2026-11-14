import type { SonGuessrAck, SonGuessrCommand, SonGuessrPayload } from "@bakagame/shared";
import { attachTabSession } from "@/lib/TabSession";
import { createWebSocketClient } from "@/lib/WebsocketClient";
import { createGameWs, type CommandPolicy } from "@/lib/GameWs";

export const sonGuessrWsClient = createWebSocketClient("/api/ws", { prelude: attachTabSession });

export type SonGuessrCommandMap = {
  [K in SonGuessrCommand]: { payload: SonGuessrPayload<K>; ack: SonGuessrAck<K> };
};

export const { connect, disconnect, waitForConnection, send, onMessage, onStatus } =
  createGameWs<SonGuessrCommandMap>(sonGuessrWsClient);

/** 回源取题、取详情与自动出题的耗时由上游决定，客户端超时只会制造假失败（Spec §6）。 */
export const SONGUESSR_COMMAND_POLICY: CommandPolicy<SonGuessrCommandMap> = {
  "song.game.start": { timeout: 0, pollSync: true },
  "song.game.nextRound": { timeout: 0, pollSync: true },
  "song.game.submitSong": { timeout: 0 },
  "song.game.submitAnime": { timeout: 0 },
  "song.music.detail": { timeout: 0 },
};
