import { LRUCache } from "lru-cache";

import { isAppError } from "../../domain/Errors";
import { describeError, type EventLogger } from "../../infrastructure/EventLogger";
import type { ServerMessage } from "../../shared/Protocol";
import { createAck, createErrorPacket } from "../Packets";
import { statusOfAppError } from "../routes/Account";
import { sendPacket } from "./ConnectionRecord";

type InFlightOutcome = { success: true; payload: unknown } | { success: false; error: unknown };

/** 一条 WS 命令的去重入参。 */
export interface DedupRunInput {
  ws: { send: (data: ServerMessage) => unknown };
  connectionId: string;
  parsed: { id: string; type: string; traceId?: string };
  startTime: number;
  execute: () => Promise<unknown>;
  serviceName?: string;
}

export interface CommandDeduplicatorOptions {
  /** 已完成命令的 ACK 回放窗口。 */
  ackTtlMs: number;
  ackMax: number;
  /** 飞行中表的容量上限，见下方注释。 */
  inFlightMax: number;
  logger: EventLogger;
}

/**
 * WS 命令幂等：去重表归实例所有，随应用构造、随停机清理，测试之间互不串状态。
 * 表键是 `${connectionId}:${messageId}`，连接号每条 socket 唯一，所以同 id 跨连接互不命中，
 * 断线重连后也不会回放旧连接上的结果。
 */
export const createCommandDeduplicator = ({
  ackTtlMs,
  ackMax,
  inFlightMax,
  logger,
}: CommandDeduplicatorOptions) => {
  const messageAckCache = new LRUCache<string, object>({
    max: ackMax,
    ttl: ackTtlMs,
  });

  /**
   * 飞行中请求的去重表，按 `${connectionId}:${messageId}` 记。
   *
   * 必须封顶：大量连接持续发新 ID 时，无上限的 Map 会一直堆积，
   * 挤占正常条目所属的堆内存，也让"还在飞"的判定失去意义。
   * 超过上限时丢弃最旧的条目——它要么已完成（早已被 delete），
   * 要么属于长时间卡住的连接，此时不再为其提供去重反而是更安全的行为。
   */
  const inFlightOperations = new Map<string, Promise<InFlightOutcome>>();

  const rememberInFlight = (key: string, promise: Promise<InFlightOutcome>) => {
    if (inFlightOperations.size >= inFlightMax) {
      const oldest = inFlightOperations.keys().next().value;
      if (oldest !== undefined) inFlightOperations.delete(oldest);
    }
    inFlightOperations.set(key, promise);
  };

  const run = async ({
    ws,
    connectionId,
    parsed,
    startTime,
    execute,
    serviceName,
  }: DedupRunInput) => {
    const parsedId = parsed.id;
    const parsedType = parsed.type;
    const traceId = parsed.traceId;
    const dedupKey = `${connectionId}:${parsedId}`;

    // 1. 已有完成缓存：直接回放 ACK
    if (messageAckCache.has(dedupKey)) {
      sendPacket(ws, createAck(parsed, messageAckCache.get(dedupKey)));
      return;
    }

    // 2. 正在飞行中：等待其结果并回放响应，避免网络重传被静默丢弃
    const inFlight = inFlightOperations.get(dedupKey);
    if (inFlight) {
      const outcome = await inFlight;
      const durationMs = performance.now() - startTime;
      if (outcome.success) {
        logger.logOperation({
          status: 200,
          durationMs,
          identifier: connectionId,
          action: `WS ${parsedType} (replay)`,
          traceId,
        });
        sendPacket(ws, createAck(parsed, outcome.payload));
      } else if (isAppError(outcome.error)) {
        logger.logOperation({
          status: statusOfAppError(outcome.error.code),
          durationMs,
          identifier: connectionId,
          action: `WS ${parsedType} (replay)`,
          traceId,
        });
        sendPacket(
          ws,
          createErrorPacket(
            parsedId,
            outcome.error.code,
            outcome.error.message,
            outcome.error.details,
            traceId
          )
        );
      } else {
        logger.logOperation({
          status: 500,
          durationMs,
          identifier: connectionId,
          action: `WS ${parsedType} (replay)`,
          traceId,
        });
        sendPacket(
          ws,
          createErrorPacket(parsedId, "INTERNAL_ERROR", "服务器内部错误", undefined, traceId)
        );
      }
      return;
    }

    // 3. 首次执行：启动执行并缓存 Promise
    const executePromise = (async (): Promise<InFlightOutcome> => {
      try {
        const payload = await execute();
        return { success: true, payload };
      } catch (error) {
        return { success: false, error };
      }
    })();

    rememberInFlight(dedupKey, executePromise);
    let outcome: InFlightOutcome;
    try {
      outcome = await executePromise;
    } finally {
      inFlightOperations.delete(dedupKey);
    }

    const durationMs = performance.now() - startTime;
    if (outcome.success) {
      messageAckCache.set(dedupKey, (outcome.payload as object) ?? {});
      logger.logOperation({
        status: 200,
        durationMs,
        identifier: connectionId,
        action: `WS ${parsedType}`,
        traceId,
      });
      sendPacket(ws, createAck(parsed, outcome.payload));
    } else {
      const error = outcome.error;
      if (isAppError(error)) {
        logger.logOperation({
          status: statusOfAppError(error.code),
          durationMs,
          identifier: connectionId,
          action: `WS ${parsedType}`,
          traceId,
        });
        sendPacket(
          ws,
          createErrorPacket(parsedId, error.code, error.message, error.details, traceId)
        );
        return;
      }

      const logPrefix = serviceName ? `${serviceName} ` : "";
      logger.error(`${logPrefix}WS 内部异常 [${parsedType}]`, {
        ...describeError(error),
        connectionId,
        traceId,
        parsedId,
      });

      logger.logOperation({
        status: 500,
        durationMs,
        identifier: connectionId,
        action: `WS ${parsedType}`,
        traceId,
      });
      sendPacket(
        ws,
        createErrorPacket(parsedId, "INTERNAL_ERROR", "服务器内部错误", undefined, traceId)
      );
    }
  };

  /** 停机时清空两张表。 */
  const clear = (): void => {
    messageAckCache.clear();
    inFlightOperations.clear();
  };

  return { run, clear };
};

export type CommandDeduplicator = ReturnType<typeof createCommandDeduplicator>;
