import { CEE_COMMAND_POLICY, type CEECommandMap } from "@/lib/CEEWs";
import { useCEEStore } from "@/stores/UseCEEStore";
import { useCommandRunner } from "./UseCommandRunner";

export function useCEEAction() {
  // LOGIN_REQUIRED 之类的码经统一入口既提示、又顺带拉起登录弹窗。
  const { run, pending, busy } = useCommandRunner<CEECommandMap>({
    send: (type, payload, options) => useCEEStore.getState().sendCommand(type, payload, options),
    policy: CEE_COMMAND_POLICY,
    onError: (error) => useCEEStore.getState().reportError(error),
    lock: "command",
  });
  return { run, pending, busy };
}
