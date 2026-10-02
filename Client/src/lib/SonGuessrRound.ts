import type { SonGuessrPhase } from "@bakagame/shared";

/**
 * 顶栏显示的轮次。服务端在开始播放时才递增 `roundNumber`，
 * 选出题人与选歌阶段属于即将开始的下一轮；其余阶段显示最近开始的一轮，0 表示尚未开局。
 * 与 CCB 的 `ccbDisplayRound` 同口径。
 */
export function songDisplayRound(phase: SonGuessrPhase, roundNumber: number): number {
  return phase === "choosingSubmitter" || phase === "submittingSong" ? roundNumber + 1 : roundNumber;
}
