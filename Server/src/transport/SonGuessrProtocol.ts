import { type TSchema } from "@sinclair/typebox";
import { SonGuessrMessageSchemas, type SonGuessrClientMessage } from "../shared/SonGuessr";
import { parseClientMessage } from "./ParseClientMessage";

export { SonGuessrClientMessageSchema } from "../shared/SonGuessr";

/** 严格解析猜歌客户端消息；顺序与错误口径见 `parseClientMessage`。 */
export const parseSonGuessrMessage = (raw: unknown): SonGuessrClientMessage =>
  parseClientMessage(raw, SonGuessrMessageSchemas as Record<string, TSchema>);
