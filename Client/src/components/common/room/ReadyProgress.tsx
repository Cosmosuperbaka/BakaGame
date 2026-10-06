import { motion } from "framer-motion";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { spring } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/**
 * 等待页的准备进度。房主看到带标题的整宽进度条；其他玩家看到居中的一句摘要与短进度条。
 * 进度条宽度随准备人数弹性变化，读作同一根条在伸缩；已准备人数逐位滚到新值。
 */
export function ReadyProgress({ ready, total, variant }: { ready: number; total: number; variant: "host" | "guest" }) {
  const bar = (
    // 轨道取前景色的淡档：bg-muted 在暗色下比面板更暗，几乎看不出轨道（Design §3 骨架条同理）。
    <div
      role="progressbar"
      aria-label="玩家准备进度"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={ready}
      aria-valuetext={`${ready}/${total} 名玩家已准备`}
      className={cn("h-1.5 overflow-hidden rounded-full bg-foreground/10", variant === "guest" && "mx-auto w-48")}
    >
      <motion.div
        className="h-full rounded-full bg-primary"
        initial={false}
        animate={{ width: `${total > 0 ? (ready / total) * 100 : 0}%` }}
        transition={spring.settle}
      />
    </div>
  );
  const count = <><AnimatedNumber value={ready} />/{total}</>;
  if (variant === "guest") {
    return (
      <div className="w-full space-y-2 text-center">
        <p className="text-sm text-muted-foreground tabular-nums">{count} 名玩家已准备</p>
        {bar}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>玩家准备进度</span>
        <span className="tabular-nums">{count}</span>
      </div>
      {bar}
    </div>
  );
}
