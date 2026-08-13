import { useCallback } from "react";
import { motion } from "framer-motion";
import { Moon, Sword, FastForward, CheckCircle2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listContainer, listItem, selectable, spring } from "@/lib/motion";
import { useGameStore } from "@/stores/useGameStore";
import { PrivilegedActionPreview } from "./PrivilegedActionPreview";
import { PhaseHeader } from "./PhaseHeader";
import { AbstainOption } from "./AbstainOption";

export function NightPhase() {
  const snapshot = useGameStore((s) => s.snapshot)!;
  const privateState = useGameStore((s) => s.privateState);
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);
  const phaseResultPresentationPending = useGameStore(
    (state) => state.phaseResultPresentationPending,
  );
  const isQuestioner = privateState?.isQuestioner ?? false;
  const me = snapshot.players.find((p) => p.id === privateState?.playerId);
  const amAlive = me?.roundStatus === "alive";
  const role = privateState?.role;

  const acted = privateState?.nightActionSubmitted ?? false;
  const actionTargetName = snapshot.players.find(
    (p) => p.id === privateState?.myCurrentNightTargetId,
  )?.name;

  const canAct =
    amAlive && !isQuestioner && (role === "civilian" || role === "undercover");

  // 自己永远不是夜晚目标，测试房间也一样。
  const targets = snapshot.players.filter(
    (p) => p.roundStatus === "alive" && p.id !== privateState?.playerId,
  );

  const handleNightAction = useCallback(
    async (targetId?: string) => {
      try {
        await sendCommand("game.submitNightAction", { targetId: targetId ?? null });
      } catch (e) {
        addToast((e as { message: string }).message, "error");
      }
    },
    [sendCommand, addToast]
  );

  const handleCancelNightAction = useCallback(async () => {
    try {
      await sendCommand("game.cancelNightAction", {});
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [sendCommand, addToast]);

  const handleAdvance = useCallback(async () => {
    try {
      await sendCommand("game.advancePhase");
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [sendCommand, addToast]);

  return (
    <div className="space-y-6 max-w-lg mx-auto">
      <PhaseHeader
        icon={Moon}
        title="夜晚降临"
        iconClassName="text-indigo-500"
      />

      <PrivilegedActionPreview mode="night" />

      {canAct && !acted && (
        <motion.div
          className="grid grid-cols-2 gap-2.5"
          variants={listContainer(targets.length)}
          initial="initial"
          animate="animate"
        >
            {targets.map((p) => (
              <motion.button
                key={p.id}
                type="button"
                variants={listItem}
                {...selectable}
                className="flex cursor-pointer items-center justify-between rounded-md border px-4 py-3.5 text-left transition-colors hover:border-rose-400/50 hover:bg-rose-500/5"
                onClick={() => handleNightAction(p.id)}
              >
                <span className="truncate text-sm font-medium">{p.name}</span>
                <Sword className="ml-2 h-4 w-4 shrink-0 text-rose-500" />
              </motion.button>
            ))}
          <AbstainOption onSelect={() => handleNightAction()} />
        </motion.div>
      )}

      {/* 提交行动后的反馈卡片，与投票阶段同一套结构与配色 */}
      {canAct && acted && (
        <motion.div
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={spring.impulse}
          className="mx-auto flex max-w-sm items-center justify-between gap-3 rounded-md border-2 border-primary/30 bg-primary/10 px-4 py-3"
        >
          <div className="flex items-center gap-2.5">
            <motion.span
              className="inline-flex shrink-0"
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ ...spring.impulse, delay: 0.06 }}
            >
              <CheckCircle2 className="h-5 w-5 text-primary" />
            </motion.span>
            <div>
              <div className="text-sm font-semibold text-foreground">已完成夜晚决策</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {actionTargetName ? (
                  <>
                    目标 <span className="font-medium text-foreground">{actionTargetName}</span>
                  </>
                ) : (
                  "已弃票"
                )}
              </div>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 gap-1.5 text-xs"
            onClick={handleCancelNightAction}
          >
            <Undo2 className="h-3.5 w-3.5" />
            撤销
          </Button>
        </motion.div>
      )}

      {isQuestioner && (
        <div className="text-center pt-2">
          <Button
            onClick={handleAdvance}
            disabled={phaseResultPresentationPending}
            size="lg"
            className="gap-2 px-6"
          >
            <FastForward className="h-4 w-4" /> 天亮了
          </Button>
        </div>
      )}
    </div>
  );
}
