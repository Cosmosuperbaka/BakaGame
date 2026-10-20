import { useEffect, useState } from "react";

/** 倒计时刷新间隔：远小于 1 秒，保证数字跳变贴近真实时刻。 */
const TICK_MS = 200;

/** 某一时刻该显示的剩余整秒。 */
const secondsAt = (deadlineAt: number, at: number) =>
  Math.max(0, Math.ceil((deadlineAt - at) / 1000));

/**
 * 距截止时刻的剩余整秒。必须向上取整：向下取整会让 0.9 秒显示成 0，
 * 而服务端此刻仍判定未超时，玩家会看到「倒计时已归零、操作依然有效」的假超时窗口。
 *
 * 心跳仍是 200ms 一次，但只在显示值真的跨秒时才写入：写入的 `now` 每次都不同，
 * 无条件写会让 React 的相同值短路失效，每秒白跑 4 次渲染。
 */
export function useSecondsLeft(deadlineAt: number | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadlineAt) return;
    const tick = () =>
      setNow((current) =>
        secondsAt(deadlineAt, current) === secondsAt(deadlineAt, Date.now()) ? current : Date.now()
      );
    const timer = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(timer);
  }, [deadlineAt]);
  return deadlineAt ? secondsAt(deadlineAt, now) : 0;
}
