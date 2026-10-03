import { useCallback, useRef, useState } from "react";

/** 同阶段冲突命令共用同步守卫；锁只覆盖 ACK 等待，不代替权威快照。 */
export function usePhaseAction() {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try { await action(); }
    finally { inFlight.current = false; setBusy(false); }
  }, []);
  return { run, busy };
}

export type PhaseAction = ReturnType<typeof usePhaseAction>;
