import { randomUUID } from "node:crypto";

import type { GameRecordEvent, GameRecorder, GameRoundRecord } from "../domain/GameRecord";
import type { EventLogger } from "../infrastructure/EventLogger";
import type { GameRecordRepository } from "../infrastructure/db/GameRecordRepository";

/** 对局记录滚动保留 7 天。 */
export const GAME_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const PURGE_BATCH = 500;
/** 时间线序列化上限：超出时保留前段并追加截断标记，避免异常长局撑爆单行。 */
const TIMELINE_MAX_BYTES = 64 * 1024;
/** 数据库不可用时最多积压的待写记录数，超出直接丢弃并告警，保护进程内存。 */
const MAX_PENDING_WRITES = 200;
const NAME_MAX_LENGTH = 64;

export interface GameRecordServiceOptions {
  repository: GameRecordRepository;
  logger: EventLogger;
  now?: () => number;
}

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** 二分找出能放进上限的最长前缀，末尾补一条截断标记。 */
const capTimeline = (timeline: GameRecordEvent[]): GameRecordEvent[] => {
  if (byteLength(timeline) <= TIMELINE_MAX_BYTES) return timeline;
  let low = 0;
  let high = timeline.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(timeline.slice(0, middle)) <= TIMELINE_MAX_BYTES - 128) low = middle;
    else high = middle - 1;
  }
  const kept = timeline.slice(0, low);
  return [...kept, { at: kept.at(-1)?.at ?? 0, type: "truncated", omitted: timeline.length - low }];
};

/** `GameRecorder` 的落库实现：异步写入、失败只记日志，并定时清理过期记录。 */
export class GameRecordService implements GameRecorder {
  private readonly now: () => number;
  private readonly pending = new Set<Promise<void>>();
  private purgeTimer: ReturnType<typeof setInterval> | undefined;
  private purging: Promise<void> | undefined;

  constructor(private readonly options: GameRecordServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  record(round: GameRoundRecord): void {
    if (this.pending.size >= MAX_PENDING_WRITES) {
      this.options.logger.warn("对局记录积压过多，已丢弃", { game: round.game, roomId: round.roomId });
      return;
    }
    const write = this.options.repository.insert({
      id: randomUUID(),
      game: round.game,
      roomId: round.roomId,
      roundNumber: round.roundNumber,
      startedAt: new Date(round.startedAt),
      endedAt: new Date(round.endedAt),
      players: round.players.map((player) => ({ ...player, name: [...player.name].slice(0, NAME_MAX_LENGTH).join("") })),
      summary: round.summary,
      timeline: capTimeline(round.timeline),
    }).catch((error: unknown) => {
      this.options.logger.warn("对局记录写入失败", { game: round.game, roomId: round.roomId, error: String(error) });
    }).finally(() => {
      this.pending.delete(write);
    });
    this.pending.add(write);
  }

  /** 立即清理一次并开始每小时定时清理。 */
  start(): void {
    if (this.purgeTimer) return;
    void this.purge();
    this.purgeTimer = setInterval(() => void this.purge(), PURGE_INTERVAL_MS);
    this.purgeTimer.unref?.();
  }

  async purge(): Promise<number> {
    if (this.purging) {
      await this.purging;
      return 0;
    }
    let removed = 0;
    this.purging = (async () => {
      const before = new Date(this.now() - GAME_RECORD_RETENTION_MS);
      try {
        for (;;) {
          const count = await this.options.repository.purge(before, PURGE_BATCH);
          removed += count;
          if (count < PURGE_BATCH) break;
        }
      } catch (error) {
        this.options.logger.warn("对局记录清理失败", { error: String(error) });
      }
    })();
    try {
      await this.purging;
    } finally {
      this.purging = undefined;
    }
    return removed;
  }

  /** 停止定时清理并等待在途写入完成（进程退出前调用）。 */
  async close(): Promise<void> {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.purgeTimer = undefined;
    await Promise.allSettled([...this.pending, ...(this.purging ? [this.purging] : [])]);
  }
}
