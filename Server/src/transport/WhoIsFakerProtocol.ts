import { type TSchema } from "@sinclair/typebox";
import { WhoIsFakerMessageSchemas, type WhoIsFakerClientMessage } from "../shared/WhoIsFaker";
import { parseClientMessage } from "./ParseClientMessage";

export type { WhoIsFakerClientMessage };
export { WhoIsFakerClientMessageSchema } from "../shared/WhoIsFaker";

/** 严格解析卧底客户端消息；顺序与错误口径见 `parseClientMessage`。 */
export const parseWhoIsFakerMessage = (raw: unknown): WhoIsFakerClientMessage =>
  parseClientMessage(raw, WhoIsFakerMessageSchemas as Record<string, TSchema>);
