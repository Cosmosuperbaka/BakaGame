import { useEffect, useRef } from "react";
import { serverNow, useClockOffsetMs } from "@/stores/UseServerClock";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";

/**
 * 阶段倒计时到点时，把本地已写好的内容替玩家提交一次。
 *
 * 服务端到点会自己强制推进，这里只是客户端的补偿，所以两条约束：
 * 一是到点按校正后的服务端时钟判断（与读秒同一个钟），本机钟快慢都不能让提交早于或晚于读秒归零；
 * 二是每个截止时刻最多自动提交一次，被拒或失败后留给玩家手动，不能因为「提交中」状态复位就再触发。
 */
export function useAutoSubmitOnTimeout({
  enabled,
  hasContent,
  submit,
}: {
  /** 玩家此刻能提交（有发言资格、没有在途请求等） */
  enabled: boolean;
  /** 本地已有可提交的内容 */
  hasContent: boolean;
  submit: () => void | Promise<unknown>;
}) {
  const endsAt = useWhoIsFakerStore((s) => s.snapshot?.status.phaseTimer?.endsAt);
  // 新的对时样本会移动「到点」的本机时刻：订阅它，样本变化时重排定时
  const clockOffsetMs = useClockOffsetMs();
  const firedFor = useRef<number | null>(null);
  // 提交函数每次输入都换身份，经 ref 取最新，不让它参与重排定时
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });

  useEffect(() => {
    if (endsAt === undefined || !enabled || !hasContent || firedFor.current === endsAt) return;
    const timer = window.setTimeout(
      () => {
        if (firedFor.current === endsAt) return;
        firedFor.current = endsAt;
        void submitRef.current();
      },
      Math.max(0, endsAt - serverNow())
    );
    return () => window.clearTimeout(timer);
  }, [endsAt, enabled, hasContent, clockOffsetMs]);
}
