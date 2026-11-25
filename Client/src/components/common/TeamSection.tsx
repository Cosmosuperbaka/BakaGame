import type { ReactNode, Ref } from "react";
import { motion } from "framer-motion";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { listItem, playerRelayout } from "@/lib/motion/Choreography";
import { cn } from "@/lib/Utils";

/**
 * 玩家栏里的一个队伍块（CEE 与猜歌共用）。
 *
 * 组队的人收进一块带细描边的浅凹槽：一眼能数出有几队、谁和谁一队，又不至于用色块把玩家栏切成彩砖。
 * 标题行与队员行同一套左右缘：队号对齐头像左缘，全队合计对齐队员分数所在的行尾，
 * 扫一列分数时队伍合计和个人分数落在同一条竖线上，只靠字重分出层级。
 * 个人游玩的人没有队伍块，只有一行与队号同位的小标题。
 * `extra` 挂在标题下方（CEE 的共享猜测进度串），队员行由 `children` 给出。
 */
export function TeamSection({
  ref,
  team,
  scores,
  detail,
  extra,
  children,
}: {
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
      className={cn(
        "min-w-0",
        team !== null && "rounded-lg border border-border/70 bg-muted/45 p-0.5"
      )}
    >
      {team === null ? (
        <p className="px-2.5 pt-1 pb-0.5 font-serif text-2xs leading-none text-muted-foreground">
          个人
        </p>
      ) : (
        <div className="space-y-1 pt-1.5 pr-2 pb-1 pl-2.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-serif text-xs font-semibold leading-none">
              {team} 队
            </span>
            <span className="min-w-0 flex-1 truncate font-sans text-2xs leading-none text-muted-foreground">
              {detail}
            </span>
            <span
              aria-label={`合计 ${total} 分`}
              className="flex shrink-0 items-baseline gap-0.5 font-sans text-2xs leading-none text-muted-foreground tabular-nums"
            >
              合计
              <AnimatedNumber
                value={total}
                className="ml-0.5 text-sm font-medium leading-none text-foreground"
              />
              分
            </span>
          </div>
          {extra}
        </div>
      )}
      {children}
    </motion.section>
  );
}
