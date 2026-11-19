import type { CEEGuess, CEERoundSummary } from "@bakagame/shared";

/** 已结算的一回合：回放按回合顺序重演其中的每次猜测。 */
export interface ReplayRound {
  number: number;
  answer: CEERoundSummary["answer"];
  guesses: CEEGuess[];
}

/** 回放的一步：一条猜测。 */
export interface ReplayStep {
  round: number;
  /** 本回合内的第几次猜测，1 开始。 */
  index: number;
  guess: CEEGuess;
}

/**
 * 功能开关。回放先不向玩家开放：默认关闭，只在本地留下开关或带 `?ceeReplay=1` 时打开，
 * 便于联调与录屏，上线前不出现在任何界面入口。
 */
export const CEE_REPLAY_STORAGE_KEY = "bakagame:cee-replay";
export const CEE_REPLAY_QUERY_PARAM = "ceeReplay";

export const isCeeReplayEnabled = (
  search = typeof window === "undefined" ? "" : window.location.search
): boolean => {
  try {
    if (new URLSearchParams(search).get(CEE_REPLAY_QUERY_PARAM) === "1") return true;
    return window.localStorage.getItem(CEE_REPLAY_STORAGE_KEY) === "1";
  } catch {
    // 隐私模式下 localStorage 会抛错：没开就是关，不影响结算页其余部分。
    return false;
  }
};

/** 按回合顺序展平整局的猜测；回合内按时间先后，服务端已按追加顺序给出。 */
export const buildReplaySteps = (rounds: ReplayRound[]): ReplayStep[] => {
  const steps: ReplayStep[] = [];
  for (const round of [...rounds].sort((left, right) => left.number - right.number)) {
    [...round.guesses]
      .sort((left, right) => left.createdAt - right.createdAt)
      .forEach((guess, position) =>
        steps.push({ round: round.number, index: position + 1, guess })
      );
  }
  return steps;
};
