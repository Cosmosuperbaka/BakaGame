import { useCallback, useRef, useState } from "react";
import type { CEECommand, CEEPayload } from "@bakagame/shared";
import { ceeErrorMessage, useCEEStore } from "@/stores/UseCEEStore";

export function useCEEAction() {
  const inFlight = useRef(new Set<CEECommand>());
  const [pending, setPending] = useState<ReadonlySet<CEECommand>>(new Set());
  const run = useCallback(async <T extends CEECommand>(command: T, payload: CEEPayload<T>) => {
    if (inFlight.current.has(command)) return undefined;
    inFlight.current.add(command); setPending(new Set(inFlight.current));
    try { return await useCEEStore.getState().sendCommand(command, payload); }
    catch (error) { useCEEStore.getState().setNotice(ceeErrorMessage(error)); return undefined; }
    finally { inFlight.current.delete(command); setPending(new Set(inFlight.current)); }
  }, []);
  return { run, pending, busy: pending.size > 0 };
}
