import { create } from "zustand";

/** 一次对时样本：本机时钟比服务端快（正）或慢（负）多少毫秒，以及取样用的往返耗时。 */
export interface ClockSample {
  /** 服务端时刻减本机时刻。校正后的当前时刻 = 本机当前时刻 + 此值。 */
  offsetMs: number;
  /** 命令发出到确认帧收到的往返耗时：越短，对单程延迟对称的假设越可靠。 */
  roundTripMs: number;
}

/**
 * 由一条命令的往返估算偏差：假设去程与回程耗时相等，服务端写出确认帧的时刻对应本机
 * 「发送与接收的中点」。往返耗时取非负，本机时钟在往返期间被回拨时不让样本变成负数。
 */
export function estimateClockSample(
  serverNow: number,
  sentAt: number,
  receivedAt: number
): ClockSample {
  const roundTripMs = Math.max(0, receivedAt - sentAt);
  return { offsetMs: serverNow - (sentAt + roundTripMs / 2), roundTripMs };
}

/** 保留往返耗时最短的样本；耗时相同取新的，让时钟漂移能被跟上。 */
export function preferClockSample(current: ClockSample | null, next: ClockSample): ClockSample {
  if (!current) return next;
  return next.roundTripMs <= current.roundTripMs ? next : current;
}

interface ServerClockState {
  /** 当前采信的样本；没有样本时偏差为零，行为退回直接使用本机时钟。 */
  sample: ClockSample | null;
}

export const useServerClockStore = create<ServerClockState>(() => ({ sample: null }));

/** 记下一次确认帧得到的样本。 */
export function recordClockSample(serverNow: number, sentAt: number, receivedAt: number): void {
  const next = estimateClockSample(serverNow, sentAt, receivedAt);
  useServerClockStore.setState((state) => ({ sample: preferClockSample(state.sample, next) }));
}

/** 连接全部断开后样本作废：重连后在新连接上重新取样。 */
export function resetClockSample(): void {
  useServerClockStore.setState({ sample: null });
}

/** 当前偏差（毫秒）；没有样本为零。 */
export function getClockOffsetMs(): number {
  return useServerClockStore.getState().sample?.offsetMs ?? 0;
}

/**
 * 校正后的当前时刻：本机时钟换算到服务端时间轴。一切「本机当前时刻与服务端下发的绝对时刻」
 * 的比较都必须经它，不能直接用 `Date.now()`。
 */
export function serverNow(): number {
  return Date.now() + getClockOffsetMs();
}

/** 订阅偏差的 hook：新样本带来更小往返时，使用方据此重新计算。 */
export function useClockOffsetMs(): number {
  return useServerClockStore((state) => state.sample?.offsetMs ?? 0);
}
