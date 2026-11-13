import { useEffect } from "react";
import { useAnimate } from "framer-motion";
import { spring, urgentPulse } from "@/lib/Motion";
import { serverNow } from "@/stores/UseServerClock";

/**
 * 倒计时末段的图标脉动，返回挂在图标外层的 ref。
 *
 * 用命令式动画而不是 `animate` 属性：所在面板常在 `AnimatePresence initial={false}` 下首屏挂载
 * （进房、重连时倒计时已在末段），声明式的无限循环会被当成首屏入场跳过、根本不起拍。
 * 给了截止时刻就对齐到读秒换数的那一刻起拍（剩余毫秒数落在整秒上时读秒才换），之后一拍一秒；
 * 截止时刻在服务端时间轴上，「现在」取校正后的时刻，与读秒用的是同一个钟。
 * 没给就从 `active` 变真的那一刻起拍。变假时停下并弹回原大。减弱动效时不脉动。
 */
export function useUrgentPulse<T extends Element>(
  active: boolean,
  reduced: boolean | null,
  deadlineAt?: number
) {
  const [scope, animate] = useAnimate<T>();
  useEffect(() => {
    const node = scope.current;
    if (!active || reduced || !node) return;
    const delay =
      deadlineAt === undefined ? 0 : (Math.max(0, deadlineAt - serverNow()) % 1000) / 1000;
    const controls = animate(node, urgentPulse.animate, { ...urgentPulse.transition, delay });
    return () => {
      controls.stop();
      animate(node, { scale: 1 }, spring.snap);
    };
  }, [active, reduced, deadlineAt, animate, scope]);
  return scope;
}
