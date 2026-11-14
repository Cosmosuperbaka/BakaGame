import { CEE_COMMAND_POLICY, type CEECommandMap } from "@/lib/CEEWs";
import { useCEEStore } from "@/stores/UseCEEStore";
import { useCommandRunner } from "./UseCommandRunner";

export function useCEEAction() {
  // LOGIN_REQUIRED 之类的码经统一入口既提示、又顺带拉起登录弹窗。
  const { run, pending, busy } = useCommandRunner<CEECommandMap>({
    // 没有选项时不带第三个参数：与各处直接调用 store 的发送形状一致。
    send: (type, payload, options) =>
      options === undefined
        ? useCEEStore.getState().sendCommand(type, payload)
        : useCEEStore.getState().sendCommand(type, payload, options),
    policy: CEE_COMMAND_POLICY,
    onError: (error) => useCEEStore.getState().reportError(error),
    lock: "command",
  });
  return { run, pending, busy };
}
