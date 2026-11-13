import { ValidationError } from "elysia";

import { isAppError } from "../../domain/Errors";
import { describeError, type EventLogger } from "../../infrastructure/EventLogger";
import type { ServerMessage } from "../../shared/Protocol";
import { createErrorPacket } from "../Packets";

/**
 * 解析阶段失败的诊断摘要。
 *
 * 解析失败时 `parsedType` / `parsedId` 都还是初值，日志只剩 `WS raw`，事后无从判断是哪个命令、
 * 哪条字段不合法——而这类故障恰好只会「静默」发生（客户端拿不到可匹配的 ack/error 包，
 * 请求因 `timeout: 0` 永不超时，页面只表现为卡住）。因此这里在解析失败路径上补一份
 * 类型与大小信息，让日志可定位输入边界。
 *
 * 只保留类型、长度与键数；任意键名同样可能承载秘密，不记录名称或截断样本。
 */
export const describeRawMessage = (raw: unknown): Record<string, unknown> => {
  if (typeof raw === "string") {
    return { rawKind: "string", length: raw.length, sample: "[原始消息已省略]" };
  }
  if (raw === null || typeof raw !== "object") return { rawKind: typeof raw };
  if (raw instanceof ArrayBuffer) return { rawKind: "ArrayBuffer", byteLength: raw.byteLength };
  if (ArrayBuffer.isView(raw)) return { rawKind: raw.constructor.name, byteLength: raw.byteLength };
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  return {
    rawKind: "object",
    keyCount: keys.length,
  };
};

/**
 * 从**校验失败**的原始载荷里抢救出信封身份字段（三个游戏共用）。
 *
 * 这不是为了放行非法消息，而是为了让失败可诊断、可回显：解析失败时若拿不到 `id`，
 * 网关只能用占位的 `"unknown"` 回错误包，客户端在 `pendingRequests` 里匹配不到该 id
 * 就会**静默丢弃**——请求因 `timeout: 0` 永不超时，页面只表现为一直卡住、前端无任何提示。
 * 抢救出 `id` 后，客户端至少能收到一条可归因的错误提示而不是无限等待。
 *
 * 返回值仅供错误回包与日志使用，绝不参与业务执行。
 */
export const salvageMessageIdentity = (
  input: unknown
): { id: string; type?: string; traceId?: string } | undefined => {
  let candidate = input;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || !id.length) return undefined;
  const type = typeof record.type === "string" ? record.type.slice(0, 64) : undefined;
  const traceId = typeof record.traceId === "string" ? record.traceId.slice(0, 128) : undefined;
  return { id: id.slice(0, 128), ...(type ? { type } : {}), ...(traceId ? { traceId } : {}) };
};

// Elysia 已解码普通 JSON；该补充只统一带空白 JSON / 二进制帧，校验仍归框架。
export const decodeGameFrame = (_ws: unknown, incoming: unknown): ReturnType<typeof JSON.parse> => {
  const text =
    typeof incoming === "string"
      ? incoming
      : incoming instanceof Uint8Array
        ? new TextDecoder().decode(incoming)
        : undefined;
  if (text === undefined) return undefined;
  // JSON.parse 的非可信返回值只存在于解码边界；其后仍由原生 body validator 校验。
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** route-local error 在 HTTP 全局错误钩子之前保持原有 WS 错误/关联契约。 */
export const gameSocketError =
  (logger: EventLogger, serviceName: string, parse: (raw: unknown) => unknown) =>
  ({ error }: { error: unknown }): ServerMessage => {
    const input = error instanceof ValidationError ? error.value : undefined;
    const identity = salvageMessageIdentity(input);
    let failure: unknown = error;
    if (error instanceof ValidationError) {
      try {
        parse(input);
      } catch (diagnostic) {
        failure = diagnostic;
      }
      // 仅记录类型与大小；键名及任意信封字段也可能承载秘密，不复制到日志。
      logger.warn(`${serviceName} WS 消息解析失败`, {
        ...describeRawMessage(input),
      });
    }
    if (isAppError(failure))
      return createErrorPacket(
        identity?.id ?? "unknown",
        failure.code,
        failure.message,
        undefined,
        identity?.traceId
      );
    logger.error(`${serviceName} WS 内部异常`, describeError(failure));
    return createErrorPacket(
      identity?.id ?? "unknown",
      "INTERNAL_ERROR",
      "服务器内部错误",
      undefined,
      identity?.traceId
    );
  };
