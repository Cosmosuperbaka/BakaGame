import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 「发一条命令」的公共壳：同一命令在途时重复调用被忽略，pending 驱动按钮的进行中态，
 * 失败统一交给 onError（猜歌落横幅提示，CEE 走上报并可能拉起登录弹窗）。
 *
 * 命令、载荷、超时口径与成功后的动作都留在调用方的 perform 里：各玩法 sendCommand 的
 * 泛型形状不同，收进壳里会把命令名与载荷的类型约束放宽回任意字符串。
 */
export function useCommandRunner<TCommand extends string>({
  onError,
}: {
  onError: (error: unknown) => void;
}) {
  const inFlight = useRef(new Set<TCommand>());
  const [pending, setPending] = useState<ReadonlySet<TCommand>>(new Set());
  // 错误出口每轮渲染都是新函数，走 ref 让 run 的身份保持稳定：调用方把它当 props 往下传。
  const reportError = useRef(onError);
  useEffect(() => {
    reportError.current = onError;
  });

  const run = useCallback(async <TResult>(command: TCommand, perform: () => Promise<TResult>) => {
    if (inFlight.current.has(command)) return undefined;
    inFlight.current.add(command);
    setPending(new Set(inFlight.current));
    try {
      return await perform();
    } catch (error) {
      reportError.current(error);
      return undefined;
    } finally {
      inFlight.current.delete(command);
      setPending(new Set(inFlight.current));
    }
  }, []);

  return { run, pending, busy: pending.size > 0 };
}
