import type { CEERoom } from "../domain/CEEModel";
import type { GameRecorder } from "../domain/GameRecord";
import { isCEEAntiCheatRoom } from "../shared/Index";
import {
  ceeAntiCheatReviews,
  type CEEAntiCheatReviewQueue,
  type CEEGuessSignal,
} from "./CEEAntiCheatSignals";

/**
 * 增强房的对局记录与反作弊复核采集。
 * 猜测信号的生命周期（登记、结算时消费、关房时丢弃）收在这一处，不再散落在房间容器里。
 */
export class CEERoomRecording {
  /** 已交给对局记录的结算摘要：结算后的多次发布只记一次。 */
  private readonly recordedSummaries = new WeakSet<object>();
  /**
   * 本回合每条猜测的服务端可观测切片（`guessId → 信号`）。
   * 不进协议类型：反作弊特征只落库与进复核队列，绝不下发给客户端。
   */
  private readonly guessSignals = new Map<string, Map<string, CEEGuessSignal>>();
  constructor(
    private readonly now: () => number,
    private readonly gameRecorder: GameRecorder,
    private readonly reviewQueue: CEEAntiCheatReviewQueue
  ) {}
  /** 提交猜测时由服务层登记：那里才拿得到连接（平台类型与检索台账）。 */
  noteGuessSignal(roomId: string, signal: CEEGuessSignal): void {
    let held = this.guessSignals.get(roomId);
    if (!held) {
      held = new Map();
      this.guessSignals.set(roomId, held);
    }
    held.set(signal.guessId, signal);
  }
  recordSettled(room: CEERoom): void {
    const { round, summary } = room;
    if (!round || !summary || this.recordedSummaries.has(summary)) return;
    this.recordedSummaries.add(summary);
    const signals = this.guessSignals.get(room.id) ?? new Map<string, CEEGuessSignal>();
    const nameOf = (playerId: string) => room.players.get(playerId)?.name ?? playerId;
    this.gameRecorder.record({
      game: "cee",
      roomId: room.id,
      roomCreatedAt: room.createdAt,
      roundNumber: room.roundNumber,
      startedAt: round.startedAt,
      endedAt: this.now(),
      players: summary.scores.map((score) => ({
        playerId: score.playerId,
        userId: room.players.get(score.playerId)?.account?.userId ?? null,
        name: score.playerName,
        score: score.score,
      })),
      summary: {
        answer: { id: summary.answer.id, name: summary.answer.name, nameCn: summary.answer.nameCn },
        setter: room.setterPlayerId ? nameOf(room.setterPlayerId) : null,
        winners: summary.winners.map((winner) => ({
          name: nameOf(winner.playerId),
          rank: winner.rank,
          score: winner.score,
        })),
        mode: {
          sync: round.settings.syncMode,
          nonstop: round.settings.nonstopMode,
          answer: round.settings.answerMode,
        },
      },
      timeline: summary.guesses.map((guess) => {
        const signal = signals.get(guess.id);
        return {
          at: guess.createdAt,
          type: "guess",
          name: guess.playerName,
          character: guess.character.nameCn || guess.character.name,
          correct: guess.correct,
          partial: guess.partial,
          ...(signal
            ? {
                attempts: signal.attempts,
                clientType: signal.clientType,
                searchedAt: signal.searchedAt,
                searchMatched: signal.searchMatched,
              }
            : {}),
        };
      }),
    });
    this.collectReviews(room, summary.guesses, signals);
    this.guessSignals.delete(room.id);
  }
  /**
   * 采集覆盖全部增强房对局，判定只发生在反作弊房：普通房的特征不参与打分、不对外呈现，
   * 只作为难度调优与后续建模的语料。条目只进队列，不触发任何自动处置。
   */
  private collectReviews(
    room: CEERoom,
    guesses: { id: string; correct: boolean }[],
    signals: ReadonlyMap<string, CEEGuessSignal>
  ): void {
    if (!isCEEAntiCheatRoom(room.settings) || signals.size === 0) return;
    const ordered = new Map<string, CEEGuessSignal[]>();
    for (const guess of guesses) {
      const signal = signals.get(guess.id);
      if (!signal) continue;
      const list = ordered.get(signal.playerId) ?? [];
      list.push({ ...signal, correct: guess.correct });
      ordered.set(signal.playerId, list);
    }
    const recordedAt = this.now();
    for (const review of ceeAntiCheatReviews(
      { roomId: room.id, roomCreatedAt: room.createdAt, roundNumber: room.roundNumber, recordedAt },
      ordered,
      (playerId) => {
        const player = room.players.get(playerId);
        return { name: player?.name ?? playerId, userId: player?.account?.userId ?? null };
      }
    ))
      this.reviewQueue.add(review);
  }
  /** 回合中途关房时结算不会再来清，信号表要随房间一起走。 */
  discard(roomId: string): void {
    this.guessSignals.delete(roomId);
  }
}
