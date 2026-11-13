import { useCallback, useMemo, useState } from "react";
import type { PlayerMark, PlayerMarks } from "./FakerPlayerList";

/** 身份预测推理笔记按局次 (roundId) 隔离，换局自动读取新局空映射，杜绝渲染期 setState 截断。 */
export function usePlayerMarks(roundId: string | undefined) {
  const [playerMarksByRound, setPlayerMarksByRound] = useState<Record<string, PlayerMarks>>({});
  const playerMarks = useMemo<PlayerMarks>(
    () => (roundId ? (playerMarksByRound[roundId] ?? {}) : {}),
    [roundId, playerMarksByRound]
  );

  const onMarkChange = useCallback(
    (playerId: string, mark: PlayerMark) => {
      if (!roundId) return;
      setPlayerMarksByRound((cur) => ({
        ...cur,
        [roundId]: {
          ...(cur[roundId] ?? {}),
          [playerId]: mark,
        },
      }));
    },
    [roundId]
  );
  return { playerMarks, onMarkChange };
}
