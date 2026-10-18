import { useEffect, useRef, useState } from "react";
import type { CEERoomSnapshot } from "@bakagame/shared";
import type { ReplayRound } from "@/lib/CeeReplay";

/**
 * 累积本局已结算的回合，供回放重演整局。
 *
 * 只认 `settled` 阶段的回合摘要：同一回合可能收到多次快照，按回合号去重；
 * 换房间（或重新进房）视为新的一局，历史清空。历史只在内存里，刷新页面即随房间状态消失。
 */
export function useCEERoundHistory(snapshot: CEERoomSnapshot | null): ReplayRound[] {
  const [rounds, setRounds] = useState<ReplayRound[]>([]);
  const roomIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    const roomChanged = snapshot.roomId !== roomIdRef.current;
    if (roomChanged) roomIdRef.current = snapshot.roomId;
    if (snapshot.phase !== "settled" || !snapshot.roundSummary) {
      if (roomChanged) setRounds([]);
      return;
    }
    const { answer, guesses } = snapshot.roundSummary;
    const number = snapshot.roundNumber;
    setRounds((previous) => {
      const base = roomChanged ? [] : previous;
      if (base.some((round) => round.number === number)) return base;
      return [...base, { number, answer, guesses }];
    });
  }, [snapshot]);

  return rounds;
}
