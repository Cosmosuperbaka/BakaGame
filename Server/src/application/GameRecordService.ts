import { randomUUID } from "node:crypto";

import type {
  GameRecordEvent,
  GameRecorder,
  GameRoomEnd,
  GameRoundRecord,
  RecordedGame,
} from "../domain/GameRecord";
import type { EventLogger } from "../infrastructure/EventLogger";
import type {
  GameRecordRepository,
  StoredGameRecord,
  StoredGameRecordRound,
} from "../infrastructure/db/GameRecordRepository";

/** 单个回合的时间线序列化上限：超出时保留前段并追加截断标记，避免异常长回撑爆单行。 */
const GAME_ROUND_TIMELINE_MAX_BYTES = 64 * 1024;
/** 数据库不可用时最多积压的待写回合数，超出直接丢弃并告警，保护进程内存。 */
const MAX_QUEUED_ROUNDS = 1_000;
const NAME_MAX_LENGTH = 64;
/** 已收尾房间的记忆条数：只用于挡住迟到回合，不需要永久保留。 */
const CLOSED_KEY_MEMORY = 1_000;

export interface GameRecordServiceOptions {
  repository: GameRecordRepository;
  logger: EventLogger;
}

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** 二分找出能放进上限的最长前缀，末尾补一条截断标记。 */
export const capTimeline = (
  timeline: GameRecordEvent[],
  maxBytes = GAME_ROUND_TIMELINE_MAX_BYTES,
): GameRecordEvent[] => {
  if (byteLength(timeline) <= maxBytes) return timeline;
  let low = 0;
  let high = timeline.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(timeline.slice(0, middle)) <= maxBytes - 128) low = middle;
    else high = middle - 1;
  }
  const kept = timeline.slice(0, low);
  return [...kept, { at: kept.at(-1)?.at ?? 0, type: "truncated", omitted: timeline.length - low }];
};

const truncateName = (name: string) => [...name].slice(0, NAME_MAX_LENGTH).join("");

/** 一局（一个房间）在内存里的聚合状态；房间销毁后清出。 */
interface RoomSession {
  id: string;
  game: RecordedGame;
  roomId: string;
  startedAt: number;
  endedAt: number;
  roundCount: number;
  lastRoundNumber: number;
  players: Map<string, { userId: string | null; name: string; score: number }>;
  /** 待落库的回合；`null` 表示房间已结束，只补写一次聚合行。 */
  queue: Array<StoredGameRecordRound | null>;
  closed: boolean;
  writing?: Promise<void>;
}

const sessionKey = (room: { game: RecordedGame; roomId: string; roomCreatedAt: number }) =>
  `${room.game}:${room.roomId}:${room.roomCreatedAt}`;

/**
 * 对局记录的落库实现：按房间聚合回合，异步串行写入，失败只记日志。
 *
 * 一局从房间创建开始，回合按结算顺序追加；房间销毁时由 `finishRoom` 收尾。
 * 记录永久保留，不再按时间清理。
 */
export class GameRecordService implements GameRecorder {
  private readonly sessions = new Map<string, RoomSession>();
  private readonly pending = new Set<Promise<void>>();
  /** 已收尾的房间：迟到的回合不能重新开一局；只留最近一批，避免常驻内存无上限。 */
  private readonly closedKeys = new Set<string>();
  private readonly closedOrder: string[] = [];

  constructor(private readonly options: GameRecordServiceOptions) {}

  record(round: GameRoundRecord): void {
    const key = sessionKey(round);
    if (this.closedKeys.has(key)) {
      this.options.logger.warn("房间已结束，忽略迟到的回合记录", { game: round.game, roomId: round.roomId });
      return;
    }
    const session = this.sessions.get(key) ?? this.createSession(round);
    if (session.closed) {
      this.options.logger.warn("房间已结束，忽略迟到的回合记录", { game: round.game, roomId: round.roomId });
      return;
    }
    // 回合序号永远递增；重放或重复结算不应把同一回合记两次。
    if (round.roundNumber <= session.lastRoundNumber) {
      this.options.logger.warn("忽略重复的回合记录", {
        game: round.game, roomId: round.roomId, roundNumber: round.roundNumber,
      });
      return;
    }
    if (this.queuedRounds() >= MAX_QUEUED_ROUNDS) {
      this.options.logger.warn("对局记录积压过多，已丢弃", {
        game: round.game, roomId: round.roomId, roundNumber: round.roundNumber,
      });
      return;
    }
    session.lastRoundNumber = round.roundNumber;
    session.roundCount = round.roundNumber;
    session.endedAt = Math.max(session.endedAt, round.endedAt);
    for (const player of round.players) this.mergePlayer(session, player);
    session.queue.push({
      number: round.roundNumber,
      startedAt: new Date(round.startedAt),
      endedAt: new Date(round.endedAt),
      players: round.players.map((player) => ({ ...player, name: truncateName(player.name) })),
      summary: round.summary,
      timeline: capTimeline(round.timeline),
    });
    this.flush(key, session);
  }

  /** 房间销毁：补一次聚合行，把结束时刻推进到销毁时刻。 */
  finishRoom(room: GameRoomEnd): void {
    const key = sessionKey(room);
    const session = this.sessions.get(key);
    this.rememberClosed(key);
    // 一回合都没打的房间不是一局，不落空记录。
    if (!session || session.closed) return;
    if (session.roundCount === 0) {
      this.sessions.delete(key);
      return;
    }
    session.closed = true;
    session.endedAt = Math.max(session.endedAt, room.endedAt);
    session.queue.push(null);
    this.flush(key, session);
  }

  /** 等待所有在途写入完成（进程退出前调用）。 */
  async close(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private createSession(round: GameRoundRecord): RoomSession {
    const session: RoomSession = {
      id: randomUUID(),
      game: round.game,
      roomId: round.roomId,
      // 房间创建时刻不晚于首个回合开始；取两者较早值，异常数据也不至于把开局时间推后。
      startedAt: Math.min(round.roomCreatedAt, round.startedAt),
      endedAt: round.endedAt,
      roundCount: 0,
      lastRoundNumber: 0,
      players: new Map(),
      queue: [],
      closed: false,
    };
    this.sessions.set(sessionKey(round), session);
    return session;
  }

  private mergePlayer(session: RoomSession, player: GameRoundRecord["players"][number]): void {
    const name = truncateName(player.name);
    const existing = session.players.get(player.playerId);
    if (existing) {
      existing.score += player.score;
      existing.name = name;
      // 游客先到、登录后再结算的回合要把账号补上。
      if (!existing.userId && player.userId) existing.userId = player.userId;
      return;
    }
    session.players.set(player.playerId, { userId: player.userId, name, score: player.score });
  }

  /** 同一局的写入串行执行：回合按结算顺序落库，房间聚合行不会互相覆盖。 */
  private flush(key: string, session: RoomSession): void {
    if (session.writing) return;
    const write = (async () => {
      while (session.queue.length) {
        const round = session.queue.shift()!;
        try {
          await this.options.repository.save(this.snapshot(session, round), round ?? undefined);
        } catch (error) {
          this.options.logger.warn("对局记录写入失败", {
            game: session.game, roomId: session.roomId, roundNumber: round?.number ?? null, error: String(error),
          });
        }
      }
    })().finally(() => {
      session.writing = undefined;
      if (session.queue.length) {
        this.flush(key, session);
        return;
      }
      if (session.closed) this.sessions.delete(key);
    });
    session.writing = write;
    this.pending.add(write);
    void write.finally(() => this.pending.delete(write));
  }

  /**
   * 落库快照：`roundCount` 取本次待写回合的序号，读到的一半状态也不会出现
   * 「回合数比实际落库的回合多」。
   */
  private snapshot(session: RoomSession, round: StoredGameRecordRound | null): StoredGameRecord {
    return {
      id: session.id,
      game: session.game,
      roomId: session.roomId,
      roundCount: round?.number ?? session.roundCount,
      startedAt: new Date(session.startedAt),
      endedAt: new Date(session.endedAt),
      players: [...session.players].map(([playerId, player]) => ({ playerId, ...player })),
    };
  }

  private queuedRounds(): number {
    let total = 0;
    for (const session of this.sessions.values()) total += session.queue.length;
    return total;
  }

  private rememberClosed(key: string): void {
    if (this.closedKeys.has(key)) return;
    this.closedKeys.add(key);
    this.closedOrder.push(key);
    if (this.closedOrder.length > CLOSED_KEY_MEMORY) this.closedKeys.delete(this.closedOrder.shift()!);
  }
}
