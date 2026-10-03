import { motion } from "framer-motion";
import { followDelay, sealDrop } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/**
 * 印章：结算答案卡落定后盖下的一枚印，读作「这就是本局答案」。
 * 静态是描边的圆形标记，`primary` 描边配浅底（Design §3.1 的 `/40` 与 `/10`），
 * 与答案卡上的内容标签（`Badge outline`）区分：那是资料，这是落款。
 *
 * 整枚印 `aria-hidden`：答案卡的可读名由阶段标题「答案揭晓」给足，
 * 这只是同一句话的视觉副本，不再补一次可读名，免得读屏重复播报。
 * 缩小后旋转的直径约 52px，信息列因此让出的宽度按 `pr-16` 预留。
 */
export function Seal({ label, delay = followDelay, className }: {
  /** 印章上的文字，横排折成两行居中 */
  label: string;
  /** 晚主体一拍落下（秒），缺省取 `followDelay`，即卡片落定之后 */
  delay?: number;
  className?: string;
}) {
  return (
    <motion.div
      aria-hidden
      className={cn(
        "pointer-events-none flex size-14 shrink-0 items-center justify-center rounded-full border-2 border-primary/40 bg-primary/10 md:size-16",
        className,
      )}
      initial={sealDrop.initial}
      animate={sealDrop.animate}
      transition={{ ...sealDrop.transition, delay }}
    >
      <span className="text-2xs font-semibold leading-tight text-primary">{label}</span>
    </motion.div>
  );
}
