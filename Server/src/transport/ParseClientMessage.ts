import { type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AppError } from "../domain/Errors";

/**
 * 三个玩法共用的客户端信封解析：命令表由各自的 shared 模块给出，这里只管
 * JSON → 对象 → 命令查表 → 载荷形状 → schema 校验这条顺序与错误口径。
 *
 * 信封与载荷在命令表里一律 `additionalProperties: false`，拒绝未知字段与
 * `payload: null`；未知命令一律 UNKNOWN_MESSAGE_TYPE，不做任何宽松兜底。
 * 查表用 `Object.hasOwn`：`constructor`、`__proto__` 这类原型键不能冒充命令。
 */
export const parseClientMessage = <T>(raw: unknown, schemas: Record<string, TSchema>): T => {
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

  const schema = Object.hasOwn(schemas, type) ? schemas[type] : undefined;
  if (!schema) {
    throw new AppError("UNKNOWN_MESSAGE_TYPE", `未知消息类型: ${type}`);
  }

  // 校验 payload 是否为有效对象（杜绝 payload: null 宽松转为 {}）
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

  return parsed as T;
};
