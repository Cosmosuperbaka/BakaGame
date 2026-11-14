import { useCallback, useRef, useState } from "react";
import { errorText } from "@/lib/ErrorMessage";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import type { WhoIsFakerCommand, WhoIsFakerPayload } from "@bakagame/shared";

/** `exec` 的附加选项。 */
export interface PhaseExecOptions {
  /** 登记「哪个命令在等应答」用的键，默认取命令名；同一命令有多个按钮时用它区分 */
  key?: string;
  /** 命令成功后执行（失败不执行） */
  onSuccess?: () => void;
  /** 错误没带文案时的兜底提示 */
  fallback?: string;
}

/**
 * 同阶段冲突命令共用同步守卫；锁只覆盖 ACK 等待，不代替权威快照。
 *
 * `run` 只给锁，错误原样抛出，由调用方处理。
 * `exec` 是常见形状的一步到位：占锁、记下在等哪个命令、发命令、失败落成错误提示、解锁。
 */
export function useFakerPhaseAction() {
  const sendCommand = useWhoIsFakerStore((s) => s.sendCommand);
  const addToast = useWhoIsFakerStore((s) => s.addToast);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const run = useCallback(async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);
  const exec = useCallback(
    <TCommand extends WhoIsFakerCommand>(
      type: TCommand,
      payload?: WhoIsFakerPayload<TCommand>,
      { key, onSuccess, fallback = "操作失败" }: PhaseExecOptions = {}
    ) =>
      run(async () => {
        setPending(key ?? type);
        try {
          // 无载荷的命令不带第二个参数，与逐处手写时的调用形状一致
          await (payload === undefined ? sendCommand(type) : sendCommand(type, payload));
          onSuccess?.();
        } catch (error) {
          addToast(errorText(error, fallback), "error");
        } finally {
          setPending(null);
        }
      }),
    [run, sendCommand, addToast]
  );
  return { run, exec, busy, pending };
}

export type PhaseAction = ReturnType<typeof useFakerPhaseAction>;
