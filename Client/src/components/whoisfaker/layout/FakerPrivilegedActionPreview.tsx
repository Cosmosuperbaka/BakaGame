import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Clock3 } from "lucide-react";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Hint } from "@/components/ui/Tooltip";
import { listItem, readoutSwap } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { ABSTAIN_TARGET_ID } from "@bakagame/shared/values";
import { FakerRoleBadge } from "./FakerRoleBadge";
import {
  buildNightRows,
  buildVoteRows,
  countVotes,
  voteTargetsOf,
} from "./FakerPrivilegedActionRows";

interface Props {
  mode: "vote" | "night";
}

export function FakerPrivilegedActionPreview({ mode }: Props) {
  const snapshot = useWhoIsFakerStore((state) => state.snapshot);
  const privateState = useWhoIsFakerStore((state) => state.privateState);
  const preview = privateState?.privilegedActionPreview;

  if (!snapshot || !privateState?.questionerView || !preview) return null;

  const roleByPlayerId = new Map(
    privateState.questionerView.map((player) => [player.playerId, player.role])
  );
  const rows =
    mode === "vote"
      ? buildVoteRows(snapshot, privateState.questionerView, preview)
      : buildNightRows(snapshot, privateState.questionerView, preview);
  const voteTargets = voteTargetsOf(snapshot);
  const voteCounts = countVotes(preview.votes);
  const abstainCount = voteCounts.get(ABSTAIN_TARGET_ID) ?? 0;

  return (
    <section
      className="mx-auto w-full max-w-lg space-y-3"
      aria-label={mode === "vote" ? "投票预览" : "夜间行动预览"}
    >
      {mode === "vote" ? (
        // 每张票数卡里有身份徽章、名字与票数三样：手机上两列只剩一个字的名字，sm 起再并成两列
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {voteTargets.map((player) => {
            const role = roleByPlayerId.get(player.id);
            return (
              <div
                key={player.id}
                className="flex min-w-0 items-center gap-2 rounded-md bg-muted px-3 py-2.5"
              >
                {role ? <FakerRoleBadge role={role} inset /> : null}
                <Hint label={player.name}>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{player.name}</span>
                </Hint>
                {/* 票数随投票逐位滚动，读作「又多了一票」 */}
                <AnimatedNumber
                  value={voteCounts.get(player.id) ?? 0}
                  className="shrink-0 rounded-md bg-background px-2 py-0.5 text-sm font-bold"
                />
              </div>
            );
          })}
          {/* 第一张弃票出现时卡片推入，弃票被撤回到 0 时退出 */}
          <AnimatePresence initial={false}>
            {abstainCount > 0 ? (
              <motion.div
                key="abstain"
                variants={listItem}
                initial="initial"
                animate="animate"
                exit="exit"
                className="flex origin-left items-center justify-between rounded-md bg-muted px-3 py-2.5 text-sm text-muted-foreground"
              >
                <span>弃票</span>
                <AnimatedNumber
                  value={abstainCount}
                  className="rounded-md bg-background px-2 py-0.5 font-bold text-foreground"
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}

      <div className="divide-y divide-background overflow-hidden rounded-md bg-muted">
        {rows.map((row) => (
          <div
            key={row.id}
            className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-3 py-2 text-sm"
          >
            <span className="flex min-w-0 items-center gap-2">
              {row.role ? <FakerRoleBadge role={row.role} inset /> : null}
              <Hint label={row.name}>
                <span className="truncate font-medium">{row.name}</span>
              </Hint>
            </span>
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
            {/* 目标换人（投票、撤销、改投）时新读数自下顶上来，而不是原地闪一下 */}
            <span className="flex min-w-0 justify-end">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={row.value}
                  variants={readoutSwap}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className={cn(
                    "flex min-w-0 items-center justify-end gap-1.5 text-right",
                    row.pending ? "text-muted-foreground" : "font-medium"
                  )}
                >
                  {row.pending ? <Clock3 className="h-3.5 w-3.5 shrink-0" /> : null}
                  <Hint label={row.value}>
                    <span className="truncate">{row.value}</span>
                  </Hint>
                </motion.span>
              </AnimatePresence>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
