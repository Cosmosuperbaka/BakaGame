import type { ServerMessage } from "../../shared/Protocol";

export const sendPacket = (
  ws: { send: (data: ServerMessage) => unknown },
  payload: ServerMessage
) => {
  ws.send(payload);
};
