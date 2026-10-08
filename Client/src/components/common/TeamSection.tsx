import type { ReactNode, Ref } from "react";
import { motion } from "framer-motion";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { listItem, playerRelayout } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/**
 * 玩家栏里的一个队伍块（CCB 与猜歌共用）：队伍用淡色块包住标题行与队员行，个人游玩的人只有一行小标题、不加底。
 * 标题行给队号、`detail`（人数与共享进度）与全队合计分；分数仍按人存储，这里只相加。
 * `extra` 挂在标题下方（CCB 的共享猜测进度串），队员行由 `children` 给出。
 */
export function TeamSection({ ref, team, scores, detail, extra, children }: {
  ref?: Ref<HTMLElement>;
  team: number | null;
  scores: number[];
  detail: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  const total = scores.reduce((sum, score) => sum + score, 0);
  return (
    <motion.section
      ref={ref}
      variants={listItem}
      initial="initial"
      animate="animate"
      exit="exit"
      layout="position"
      transition={playerRelayout}
      aria-label={team === null ? "个人游玩" : `${team} 队`}
      className={cn("min-w-0", team !== null && "rounded-md bg-muted/40 p-0.5")}
    >
      {team === null ? (
        <p className="px-2 pt-1 pb-0.5 font-sans text-2xs text-muted-foreground">个人</p>
      ) : (
        <div className="space-y-0.5 px-2 pt-1 pb-0.5">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="text-xs font-medium">{team} 队</span>
            <span className="min-w-0 flex-1 truncate font-sans text-2xs text-muted-foreground">{detail}</span>
            <span aria-label={`合计 ${total} 分`} className="flex shrink-0 items-baseline gap-0.5 font-sans text-2xs text-muted-foreground tabular-nums">
              合计<AnimatedNumber value={total} className="text-xs text-foreground" />分
            </span>
          </div>
          {extra}
        </div>
      )}
      {children}
    </motion.section>
  );
}
