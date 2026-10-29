import { type TSchema } from "@sinclair/typebox";
import {
  CEEMessageSchemas,
  normalizeCEEEnvelope,
  type CEEClientMessage,
  type CEEClientWireMessage,
} from "../shared/CEE";
import { parseClientMessage } from "./ParseClientMessage";
export { CEEClientMessageSchema } from "../shared/CEE";

/**
 * 独立解析入口供协议单测及原生 WS 失败分支诊断；成功 WS 帧由 Elysia 校验。
 * 线路格式允许可选字段为 null，校验口径与另两个玩法同一份，通过后再统一规范化。
 */
export const parseCEEMessage = (input: unknown): CEEClientMessage =>
  normalizeCEEEnvelope(
    parseClientMessage<CEEClientWireMessage>(input, CEEMessageSchemas as Record<string, TSchema>)
  );
