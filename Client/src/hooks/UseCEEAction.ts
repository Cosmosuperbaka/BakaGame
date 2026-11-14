import { useCallback } from "react";
import type { CEECommand, CEEPayload } from "@bakagame/shared";
import { useCEEStore } from "@/stores/UseCEEStore";
import { useCommandRunner } from "./UseCommandRunner";

export function useCEEAction() {
  // LOGIN_REQUIRED 之类的码经统一入口既提示、又顺带拉起登录弹窗。
  const onError = (error: unknown) => useCEEStore.getState().reportError(error);
  const { run: runLocked, pending, busy } = useCommandRunner<CEECommand>({ onError });
  const run = useCallback(
    <T extends CEECommand>(command: T, payload: CEEPayload<T>) =>
      runLocked(command, () => useCEEStore.getState().sendCommand(command, payload)),
    [runLocked]
  );
  return { run, pending, busy };
}
