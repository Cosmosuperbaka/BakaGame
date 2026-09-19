import { useCallback, useRef, useState } from "react";
import type { CCBCommand, CCBPayload } from "@bakagame/shared";
import { ccbErrorMessage, useCCBStore } from "@/stores/UseCCBStore";

export function useCCBAction() {
  const inFlight = useRef(new Set<CCBCommand>());
  const [pending, setPending] = useState<ReadonlySet<CCBCommand>>(new Set());
  const run = useCallback(async <T extends CCBCommand>(command: T, payload: CCBPayload<T>) => {
    if (inFlight.current.has(command)) return undefined;
    inFlight.current.add(command); setPending(new Set(inFlight.current));
    try { return await useCCBStore.getState().sendCommand(command, payload); }
    catch (error) { useCCBStore.getState().setNotice(ccbErrorMessage(error)); return undefined; }
    finally { inFlight.current.delete(command); setPending(new Set(inFlight.current)); }
  }, []);
  return { run, pending, busy: pending.size > 0 };
}
