import type { WhoIsFakerAck, WhoIsFakerCommand, WhoIsFakerPayload } from "@bakagame/shared";
import { attachTabSession } from "@/lib/TabSession";
import { createWebSocketClient } from "@/lib/WebsocketClient";
import { createGameWs, type CommandPolicy } from "@/lib/GameWs";

export const whoIsFakerWsClient = createWebSocketClient("/api/ws", { prelude: attachTabSession });

export type WhoIsFakerCommandMap = {
  [K in WhoIsFakerCommand]: { payload: WhoIsFakerPayload<K>; ack: WhoIsFakerAck<K> };
};

export const { connect, disconnect, waitForConnection, send, onMessage, onStatus } =
  createGameWs<WhoIsFakerCommandMap>(whoIsFakerWsClient);

/** 卧底没有回源外部上游的命令，不需要无超时发送。 */
export const WHOISFAKER_COMMAND_POLICY: CommandPolicy<WhoIsFakerCommandMap> = {};
