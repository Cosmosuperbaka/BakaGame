import { useCallback, useEffect, useRef, useState } from "react";

export interface HostPlayerActionsOptions {
  kick: (playerId: string) => Promise<unknown>;
  transferHost: (playerId: string) => Promise<unknown>;
  setSpectator: (spectator: boolean) => Promise<unknown>;
  onError: (error: unknown) => void;
  /**
   * 猜歌共用一把在途锁：一条命令返回前别的操作不发，同一批事件里的连点在重渲染前靠 ref 同步挡住。
   * 卧底不加锁；CEE 的锁按命令分在 useCEEAction 里，这里同样不再叠一把共享锁。
   */
  lock: "shared" | "none";
}

export interface HostPlayerActions {
  kick: (playerId: string) => void;
  transferHost: (playerId: string) => void;
  setSpectator: (spectator: boolean) => void;
  /** 仅 shared 锁有意义：有命令在途时为真，驱动按钮禁用；none 恒为假。 */
  pending: boolean;
}

/**
 * 三个游戏共用的房主玩家操作壳：踢人、转让房主、切换旁观。
 * 命令名与载荷留在调用方的选项里（各玩法 sendCommand 的泛型形状不同，收进壳里会放宽回任意字符串），
 * 这里只统一在途锁与失败出口；回调身份稳定，调用方把它们当 props 往下传。
 */
export function useHostPlayerActions(options: HostPlayerActionsOptions): HostPlayerActions {
  const [pending, setPending] = useState(false);
  const lockRef = useRef(false);
  // 选项每轮渲染都是新函数，走 ref 让三个回调的身份保持稳定。
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const dispatch = useCallback(async (action: () => Promise<unknown>) => {
    const { lock, onError } = latest.current;
    if (lock === "shared") {
      if (lockRef.current) return;
      lockRef.current = true;
      setPending(true);
      try {
        await action();
      } catch (error) {
        onError(error);
      } finally {
        lockRef.current = false;
        setPending(false);
      }
      return;
    }
    try {
      await action();
    } catch (error) {
      onError(error);
    }
  }, []);

  const kick = useCallback(
    (playerId: string) => void dispatch(() => latest.current.kick(playerId)),
    [dispatch]
  );
  const transferHost = useCallback(
    (playerId: string) => void dispatch(() => latest.current.transferHost(playerId)),
    [dispatch]
  );
  const setSpectator = useCallback(
    (spectator: boolean) => void dispatch(() => latest.current.setSpectator(spectator)),
    [dispatch]
  );

  return { kick, transferHost, setSpectator, pending };
}
