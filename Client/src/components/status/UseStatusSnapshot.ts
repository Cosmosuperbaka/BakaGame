import { useEffect, useMemo, useRef, useState } from "react";
import type { PublicStatusSnapshot } from "@bakagame/shared";
import { useStatusLive } from "@/hooks/UseStatusLive";
import { fetchSystemStatus, STATUS_POLL_INTERVAL_MS } from "@/lib/SystemStatus";

/**
 * 实时通道首帧的宽限期：超过它还没有帧，就同时去查一次状态接口。
 * 取几秒而不是立刻查，是让正常网络下的首帧先到，不为每次打开页面都多打一个请求。
 */
export const STATUS_LIVE_GRACE_MS = 5_000;
/** 通道推送节奏是 15 秒：超过两拍没有新帧才算通道不可用，轮询才接手。 */
const STATUS_LIVE_STALE_MS = 35_000;

/**
 * 状态页的当前快照：以实时通道为主，通道连不上或停推时回落到状态查询接口轮询，
 * 回落期间通道仍在后台退避重连，恢复后推送重新接管。
 *
 * 两路按服务端观测时刻取较新者，不按到达先后：回落请求在途时通道先到了新帧，
 * 随后返回的旧读数不能把页面倒退回去。
 */
export function useStatusSnapshot(): {
  snapshot: PublicStatusSnapshot | null;
  /** 两路都读不到且从没有过快照：页面据此不再说「正在读取」。 */
  failed: boolean;
} {
  const { snapshot: live } = useStatusLive();
  const [polled, setPolled] = useState<PublicStatusSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const lastFrameAt = useRef<number | null>(null);

  useEffect(() => {
    if (live) lastFrameAt.current = Date.now();
  }, [live]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      const frameAt = lastFrameAt.current;
      const liveFresh = frameAt !== null && Date.now() - frameAt < STATUS_LIVE_STALE_MS;
      if (!liveFresh) {
        try {
          const next = await fetchSystemStatus();
          if (!alive) return;
          setPolled((previous) =>
            previous && previous.observedAt > next.observedAt ? previous : next
          );
          setFailed(false);
        } catch {
          if (alive) setFailed(true);
        }
      }
      if (alive) timer = setTimeout(() => void poll(), STATUS_POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void poll(), STATUS_LIVE_GRACE_MS);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const snapshot = useMemo(
    () =>
      live && polled ? (polled.observedAt > live.observedAt ? polled : live) : (live ?? polled),
    [live, polled]
  );
  return { snapshot, failed: failed && snapshot === null };
}
