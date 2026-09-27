import { useEffect, useState } from "react";

/** 倒计时刷新间隔：远小于 1 秒，保证数字跳变贴近真实时刻。 */
const TICK_MS = 200;

/**
 * 距截止时刻的剩余整秒。必须向上取整：向下取整会让 0.9 秒显示成 0，
 * 而服务端此刻仍判定未超时，玩家会看到「倒计时已归零、操作依然有效」的假超时窗口。
 */
export function useSecondsLeft(deadlineAt: number | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadlineAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [deadlineAt]);
  return deadlineAt ? Math.max(0, Math.ceil((deadlineAt - now) / 1000)) : 0;
}
