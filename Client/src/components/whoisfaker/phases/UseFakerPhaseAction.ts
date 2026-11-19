import { useCallback } from "react";
import { errorText } from "@/lib/ErrorMessage";
import { WHOISFAKER_COMMAND_POLICY, type WhoIsFakerCommandMap } from "@/lib/WhoIsFakerWs";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { useCommandRunner } from "@/hooks/UseCommandRunner";
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
  const showToast = useWhoIsFakerStore((s) => s.showToast);
  const {
    run: send,
    guard: run,
    pendingKey,
    busy,
  } = useCommandRunner<WhoIsFakerCommandMap>({
    send: sendCommand,
    policy: WHOISFAKER_COMMAND_POLICY,
    onError: (error) => showToast(errorText(error, "操作失败"), "error"),
    lock: "single",
  });
  const exec = useCallback(
    <TCommand extends WhoIsFakerCommand>(
      type: TCommand,
      payload?: WhoIsFakerPayload<TCommand>,
      { key, onSuccess, fallback }: PhaseExecOptions = {}
    ) =>
      send(type, payload, {
        key,
        onSuccess,
        onError:
          fallback === undefined
            ? undefined
            : (error) => showToast(errorText(error, fallback), "error"),
      }),
    [send, showToast]
  );
  return { run, exec, busy, pending: pendingKey };
}

export type PhaseAction = ReturnType<typeof useFakerPhaseAction>;
