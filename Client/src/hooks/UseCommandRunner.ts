import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { COMMAND_POLL_INTERVAL_MS } from "@/config/Constants";
import type { CommandPolicy, CommandSpecMap, GameSendCommand } from "@/lib/GameWs";

/** run 的逐次选项：键登记、成功回调与只针对本次失败的单独处理。 */
export interface CommandRunOptions {
  /** 登记「哪个命令在等应答」用的键，默认取命令名；同一命令有多个按钮时用它区分 */
  key?: string;
  /** 命令成功后执行（失败不执行） */
  onSuccess?: () => void;
  /** 只处理本次失败；不传则走注入的 onError */
  onError?: (error: unknown) => void;
}

/**
 * 「发一条命令」的公共壳：按命令名或整体加锁防连点，pending 驱动按钮的进行中态，
 * 超时与轮询口径由策略表决定，失败统一交给 onError（猜歌落横幅提示，CEE 走上报并可能拉起登录弹窗）。
 *
 * 依赖全部由工厂参数注入，壳不反向依赖任何玩法 store；命令名与载荷的类型约束由命令表锁定。
 */
export function useCommandRunner<M extends CommandSpecMap>({
  send,
  policy,
  pollSync,
  onError,
  lock,
}: {
  send: GameSendCommand<M>;
  policy: CommandPolicy<M>;
  /** 有 pollSync 命令在途时按固定间隔调用；不传则不轮询。 */
  pollSync?: () => void;
  onError: (error: unknown, type: keyof M & string) => void;
  /** command：按命令名各一把锁；single：同一时刻只一条（阶段内命令互斥）。 */
  lock: "command" | "single";
}) {
  const inFlight = useRef(new Map<string, keyof M & string>());
  const [pendingMap, setPendingMap] = useState<ReadonlyMap<string, keyof M & string>>(new Map());
  // 注入项每轮渲染都可能换身份，走 ref 让 run 的身份保持稳定：调用方把它当 props 往下传。
  const deps = useRef({ send, policy, pollSync, onError, lock });
  useEffect(() => {
    deps.current = { send, policy, pollSync, onError, lock };
  });

  // 匿名动作（卧底阶段的 run）不登记命令键，只占整体互斥锁，pending 不显示它。
  const guardDepth = useRef(0);
  const [guarding, setGuarding] = useState(false);

  const run = useCallback(
    async <K extends keyof M & string>(
      type: K,
      payload?: M[K]["payload"],
      options?: CommandRunOptions
    ): Promise<M[K]["ack"] | undefined> => {
      const key = options?.key ?? type;
      const {
        send: sendCommand,
        policy: commandPolicy,
        onError: reportError,
        lock: lockMode,
      } = deps.current;
      const blocked =
        lockMode === "single"
          ? inFlight.current.size > 0 || guardDepth.current > 0
          : guardDepth.current > 0 || [...inFlight.current.values()].includes(type);
      if (blocked) return undefined;
      inFlight.current.set(key, type);
      setPendingMap(new Map(inFlight.current));
      try {
        const timeout = commandPolicy[type]?.timeout;
        // 调用形状逐款保留：无超时不带选项参、无载荷不带载荷参，与各处手写时的发送形状一致。
        let ack: M[K]["ack"];
        if (timeout !== undefined) ack = await sendCommand(type, payload, { timeout });
        else if (payload !== undefined) ack = await sendCommand(type, payload);
        else ack = await sendCommand(type);
        options?.onSuccess?.();
        return ack;
      } catch (error) {
        if (options?.onError) options.onError(error);
        else reportError(error, type);
        return undefined;
      } finally {
        inFlight.current.delete(key);
        setPendingMap(new Map(inFlight.current));
      }
    },
    []
  );

  const guard = useCallback(
    async <TResult>(action: () => Promise<TResult>): Promise<TResult | undefined> => {
      if (inFlight.current.size > 0 || guardDepth.current > 0) return undefined;
      guardDepth.current += 1;
      setGuarding(true);
      try {
        return await action();
      } finally {
        guardDepth.current -= 1;
        setGuarding(guardDepth.current > 0);
      }
    },
    []
  );

  const pending = useMemo(() => new Set(pendingMap.keys()), [pendingMap]);
  const isPending = useCallback((key: string) => pending.has(key), [pending]);
  const pendingKey = pendingMap.size === 1 ? [...pendingMap.keys()][0] : null;
  const busy = pendingMap.size > 0 || guarding;

  const pollingActive =
    pollSync !== undefined &&
    [...pendingMap.values()].some((type) => policy[type]?.pollSync === true);
  // 轮询定时器在 effect 内创建，用 Effect Event 读最新的 pollSync，不让它进依赖导致定时器重建。
  const pollSyncEvent = useEffectEvent(() => {
    deps.current.pollSync?.();
  });
  useEffect(() => {
    if (!pollingActive) return;
    const timer = setInterval(() => {
      pollSyncEvent();
    }, COMMAND_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pollingActive]);

  return { run, guard, isPending, pending, pendingKey, busy };
}
