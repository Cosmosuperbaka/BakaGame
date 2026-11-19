import { useEffect, useRef, useState } from "react";
import type { CEERoomSnapshot } from "@bakagame/shared";
import type { ReplayRound } from "@/lib/CeeReplay";

/**
 * 累积本局已结算的回合，供回放重演整局。
 *
 * 只认 `settled` 阶段的回合摘要：同一回合可能收到多次快照，按回合号去重；
 * 换房间、或回合号比已见过的更小（重进同号房间开了新局），视为新的一局，历史清空；
 * 断线重连回到同一局时回合号不会倒退，历史保留。历史只在内存里，刷新页面即随房间状态消失。
 */
export function useCEERoundHistory(snapshot: CEERoomSnapshot | null): ReplayRound[] {
  const [rounds, setRounds] = useState<ReplayRound[]>([]);
  const roomIdRef = useRef<string | null>(null);
  const maxRoundRef = useRef(0);

  useEffect(() => {
    if (!snapshot) return;
    const roomChanged =
      snapshot.roomId !== roomIdRef.current || snapshot.roundNumber < maxRoundRef.current;
    roomIdRef.current = snapshot.roomId;
    maxRoundRef.current = roomChanged
      ? snapshot.roundNumber
      : Math.max(maxRoundRef.current, snapshot.roundNumber);
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
