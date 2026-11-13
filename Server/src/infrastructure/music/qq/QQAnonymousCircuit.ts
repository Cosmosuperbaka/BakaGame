import { AppError } from "../../../domain/Errors";
import type { EventLogger } from "../../EventLogger";

/** 匿名检索连续失败/空结果的上限：达到后短暂停止补充，避免持续打限流中的上游。 */
const ANONYMOUS_FAILURE_THRESHOLD = 3;
const ANONYMOUS_EMPTY_THRESHOLD = 5;
const ANONYMOUS_COOLDOWN_MS = 60 * 1000;

/**
 * 给匿名补充检索加等待上限。超时后原请求仍可能完成，因此必须提前挂一个
 * `catch`，否则迟到的拒绝会变成 unhandledRejection（Bun 会终止进程）。
 */
export async function withAnonymousTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AppError("MUSIC_API_TIMEOUT", "QQ 音乐匿名检索超时")),
      timeoutMs
    );
    (timer as { unref?: () => void }).unref?.();
  });
  void task.catch(() => {});
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 匿名检索熔断的结算回调：已登录检索不需要计数，走这份空实现。 */
export interface SearchSettlementNotes {
  onSettled: (resultCount: number) => void;
  onFailure: () => void;
}

export const NO_OP_SEARCH_NOTES: SearchSettlementNotes = {
  onSettled: () => {},
  onFailure: () => {},
};

/** 匿名检索熔断：连续失败或连续空结果达到阈值后短暂停止补充，避免持续打限流中的上游。 */
export class QQAnonymousCircuit {
  private anonymousFailureStreak = 0;
  /** 当前这段连续空结果里出现过的不同关键词。 */
  private readonly anonymousEmptyKeywords = new Set<string>();
  private anonymousBlockedUntil = 0;

  constructor(
    private readonly now: () => number,
    private readonly options: { logger?: EventLogger }
  ) {}

  isOpen(): boolean {
    return this.now() < this.anonymousBlockedUntil;
  }

  noteResult(keyword: string, resultCount: number): void {
    if (resultCount > 0) {
      this.anonymousFailureStreak = 0;
      this.anonymousEmptyKeywords.clear();
      return;
    }
    this.anonymousFailureStreak = 0;
    // 空结果按不同关键词计数：同一首歌被反复检索（重试、兜底、多处同时问）只算一次，
    // 否则一首 QQ 本来就没有的曲子就能独自凑够连续空结果，把正常的未收录误当限流。
    this.anonymousEmptyKeywords.add(keyword.trim().toLowerCase());
    if (this.anonymousEmptyKeywords.size >= ANONYMOUS_EMPTY_THRESHOLD) {
      this.openAnonymousCircuit(keyword, "empty", this.anonymousEmptyKeywords.size);
    }
  }

  noteFailure(keyword: string): void {
    this.anonymousEmptyKeywords.clear();
    this.anonymousFailureStreak += 1;
    if (this.anonymousFailureStreak >= ANONYMOUS_FAILURE_THRESHOLD) {
      this.openAnonymousCircuit(keyword, "failure", this.anonymousFailureStreak);
    }
  }

  private openAnonymousCircuit(keyword: string, reason: "empty" | "failure", streak: number): void {
    this.anonymousFailureStreak = 0;
    this.anonymousEmptyKeywords.clear();
    this.anonymousBlockedUntil = this.now() + ANONYMOUS_COOLDOWN_MS;
    // 带上触发原因：「连续空结果」与「连续抛错/超时」的处置完全不同，只写一句话无法区分。
    this.options.logger?.warn?.("QQ 音乐匿名检索连续失败，暂时熔断", {
      keyword,
      reason,
      streak,
      cooldownMs: ANONYMOUS_COOLDOWN_MS,
    });
  }
}
