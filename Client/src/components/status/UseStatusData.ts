import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type {
  PublicStatusEvent,
  PublicStatusHistory,
  PublicStatusRealtime,
} from "@bakagame/shared";
import {
  fetchStatusEvents,
  fetchStatusHistory,
  fetchStatusRealtime,
  STATUS_POLL_INTERVAL_MS,
} from "@/lib/SystemStatus";

/** 轮询数据的三态：`undefined` 读取中；`null` 读失败且此前没读到过；其余为最近一次读到的数据。 */
export type Loadable<T> = T | null | undefined;

/** 状态页的三份轮询数据（历史、实时窗口、事件）与浏览器到后端的往返延迟。 */
export function useStatusData() {
  const [history, setHistory] = useState<Loadable<PublicStatusHistory>>(undefined);
  const [realtime, setRealtime] = useState<Loadable<PublicStatusRealtime>>(undefined);
  const [events, setEvents] = useState<Loadable<PublicStatusEvent[]>>(undefined);
  const [roundTripMs, setRoundTripMs] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    // 三份数据各自降级：一份读不到不拖其它两块。轮询失败时留着上一份读到的，
    // 条带不因一次超时被清空；从没读到过才落成「读失败」。
    const keepPrevious =
      <T>(set: Dispatch<SetStateAction<Loadable<T>>>) =>
      (): void => {
        if (alive) set((previous) => previous ?? null);
      };
    const load = (): void => {
      void fetchStatusHistory().then(
        (value) => alive && setHistory(value),
        keepPrevious(setHistory)
      );
      void fetchStatusRealtime((milliseconds) => alive && setRoundTripMs(milliseconds)).then(
        (value) => alive && setRealtime(value),
        () => {
          keepPrevious(setRealtime)();
          if (alive) setRoundTripMs(null);
        }
      );
      void fetchStatusEvents().then((value) => alive && setEvents(value), keepPrevious(setEvents));
    };
    load();
    // 采样本身 3 分钟一轮，页面按分钟对齐就够；离开页面即停。
    const timer = setInterval(load, STATUS_POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return { history, realtime, events, roundTripMs };
}
