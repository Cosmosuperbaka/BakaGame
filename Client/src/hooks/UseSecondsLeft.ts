import { useEffect, useState } from "react";
import { serverNow } from "@/stores/UseServerClock";

/** 倒计时刷新间隔：远小于 1 秒，保证数字跳变贴近真实时刻。 */
const TICK_MS = 200;

/** 某一时刻该显示的剩余整秒。 */
const secondsAt = (deadlineAt: number, at: number) =>
  Math.max(0, Math.ceil((deadlineAt - at) / 1000));

/**
 * 距截止时刻的剩余整秒。必须向上取整：向下取整会让 0.9 秒显示成 0，
 * 而服务端此刻仍判定未超时，玩家会看到「倒计时已归零、操作依然有效」的假超时窗口。
 *
 * 截止时刻是服务端的绝对时刻，「现在」一律取校正后的时刻（`serverNow`），不受玩家本机时钟快慢影响。
 *
 * 心跳仍是 200ms 一次，但只在显示值真的跨秒时才写入：写入的 `now` 每次都不同，
 * 无条件写会让 React 的相同值短路失效，每秒白跑 4 次渲染。
 */
export function useSecondsLeft(deadlineAt: number | null | undefined): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    if (!deadlineAt) return;
    const tick = () =>
      setNow((current) => {
        const latest = serverNow();
        return secondsAt(deadlineAt, current) === secondsAt(deadlineAt, latest) ? current : latest;
      });
    const timer = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(timer);
  }, [deadlineAt]);
  return deadlineAt ? secondsAt(deadlineAt, now) : 0;
}

/**
 * 自某个服务端绝对时刻起已过的整秒（排队计时之类）。与 `useSecondsLeft` 同源：
 * 「现在」取校正后的时刻，且只在显示值跨秒时才写入。
 */
export function useSecondsSince(since: number): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const tick = () =>
      setNow((current) => {
        const latest = serverNow();
        return Math.floor((current - since) / 1000) === Math.floor((latest - since) / 1000)
          ? current
          : latest;
      });
    const timer = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(timer);
  }, [since]);
  return Math.max(0, Math.floor((now - since) / 1000));
}
