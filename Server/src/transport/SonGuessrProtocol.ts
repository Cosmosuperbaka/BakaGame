import { type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AppError } from "../domain/Errors";
import { SonGuessrMessageSchemas, type SonGuessrClientMessage } from "../shared/SonGuessr";

export { SonGuessrClientMessageSchema } from "../shared/SonGuessr";

/**
 * 严格类型校验与解析 SonGuessr 客户端消息。
 * 信封与载荷一律 `additionalProperties: false`（见 shared/SonGuessr.ts 的命令表），
 * 拒绝未知字段与 `payload: null`；未知命令一律 UNKNOWN_MESSAGE_TYPE，不做任何宽松兜底。
 */
export const parseSonGuessrMessage = (raw: unknown): SonGuessrClientMessage => {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AppError("INVALID_MESSAGE", "消息必须为合法 JSON 字符串");
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AppError("INVALID_MESSAGE", "消息必须为 JSON 对象");
  }

  const msgObj = parsed as Record<string, unknown>;
  const type = msgObj.type;
  if (typeof type !== "string") {
    throw new AppError("INVALID_MESSAGE", "消息类型 type 必须为字符串");
  }

  const schema = Object.hasOwn(SonGuessrMessageSchemas, type)
    ? (SonGuessrMessageSchemas as Record<string, TSchema>)[type]
    : undefined;
  if (!schema) {
    throw new AppError("UNKNOWN_MESSAGE_TYPE", `未知消息类型: ${type}`);
  }

  if (
    msgObj.payload === null ||
    typeof msgObj.payload !== "object" ||
    Array.isArray(msgObj.payload)
  ) {
    throw new AppError("INVALID_MESSAGE", "消息载荷 payload 必须为对象");
  }

  const errors = [...Value.Errors(schema, parsed)];
  if (errors.length > 0) {
    const first = errors[0];
    const path = first.path ? ` (${first.path})` : "";
    throw new AppError("INVALID_MESSAGE", `消息校验失败${path}: ${first.message}`);
  }

  return parsed as SonGuessrClientMessage;
};
