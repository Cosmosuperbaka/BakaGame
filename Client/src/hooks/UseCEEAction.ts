import { useCallback, useRef, useState } from "react";
import type { CEECommand, CEEPayload } from "@bakagame/shared";
import { useCEEStore } from "@/stores/UseCEEStore";

export function useCEEAction() {
  const inFlight = useRef(new Set<CEECommand>());
  const [pending, setPending] = useState<ReadonlySet<CEECommand>>(new Set());
  const run = useCallback(async <T extends CEECommand>(command: T, payload: CEEPayload<T>) => {
    if (inFlight.current.has(command)) return undefined;
    inFlight.current.add(command);
    setPending(new Set(inFlight.current));
    try {
      return await useCEEStore.getState().sendCommand(command, payload);
    } catch (error) {
      // LOGIN_REQUIRED 之类的码经统一入口既提示、又顺带拉起登录弹窗。
      useCEEStore.getState().reportError(error);
      return undefined;
    } finally {
      inFlight.current.delete(command);
      setPending(new Set(inFlight.current));
    }
  }, []);
  return { run, pending, busy: pending.size > 0 };
}
