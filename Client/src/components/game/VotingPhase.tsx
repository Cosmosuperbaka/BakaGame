import { useCallback } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, FastForward, Undo2, Vote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listContainer, listItem, selectable, spring } from "@/lib/motion";
import { useGameStore } from "@/stores/useGameStore";
import { PrivilegedActionPreview } from "./PrivilegedActionPreview";
import { PhaseHeader } from "./PhaseHeader";
import { SupplementRequestControl } from "./SupplementRequestControl";

export function VotingPhase() {
  const snapshot = useGameStore((state) => state.snapshot)!;
  const privateState = useGameStore((state) => state.privateState);
  const sendCommand = useGameStore((state) => state.sendCommand);
  const addToast = useGameStore((state) => state.addToast);
  const isQuestioner = privateState?.isQuestioner ?? false;
  const me = snapshot.players.find((player) => player.id === privateState?.playerId);
  const amAlive = me?.roundStatus === "alive";
  const votedId = privateState?.myCurrentVoteTargetId ?? null;
  const isTieBreak = snapshot.status.phase === "tieBreak";
  const tieBreakCandidateIds = snapshot.status.tieBreakCandidateIds ?? [];
  const alivePlayers = snapshot.players.filter((player) => player.roundStatus === "alive");
  const baseTargets = alivePlayers.filter(
    (player) => player.id !== privateState?.playerId || snapshot.testMode,
  );
  const targets =
    isTieBreak && tieBreakCandidateIds.length > 0
      ? alivePlayers.filter((player) => tieBreakCandidateIds.includes(player.id))
      : baseTargets.length > 0
        ? baseTargets
        : snapshot.testMode && amAlive && !isQuestioner && me
          ? [me]
          : [];

  const handleVote = useCallback(
    async (targetId: string) => {
      try {
        await sendCommand("game.submitVote", { targetId });
      } catch (error) {
        addToast((error as { message: string }).message, "error");
      }
    },
    [addToast, sendCommand],
  );

  const handleCancelVote = useCallback(async () => {
    try {
      await sendCommand("game.cancelVote", {});
    } catch (error) {
      addToast((error as { message: string }).message, "error");
    }
  }, [addToast, sendCommand]);

  const handleAdvance = useCallback(async () => {
    try {
      await sendCommand("game.advancePhase");
    } catch (error) {
      addToast((error as { message: string }).message, "error");
    }
  }, [addToast, sendCommand]);

  const targetPlayerName =
    targets.find((target) => target.id === votedId)?.name ??
    snapshot.players.find((player) => player.id === votedId)?.name;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <PhaseHeader
        icon={Vote}
        title={isTieBreak ? "平票 PK · 投票" : "投票阶段"}
        iconClassName={isTieBreak ? "text-amber-600" : undefined}
      />

      <PrivilegedActionPreview mode="vote" />

      {amAlive && !isQuestioner && !votedId ? (
        <motion.div
          className="grid grid-cols-2 gap-2.5"
          variants={listContainer(targets.length)}
          initial="initial"
          animate="animate"
        >
          {targets.map((player) => (
            <motion.button
              key={player.id}
              type="button"
              variants={listItem}
              {...selectable}
              className="flex cursor-pointer items-center justify-between rounded-md bg-muted px-4 py-3.5 text-left transition-colors hover:bg-muted/70"
              onClick={() => handleVote(player.id)}
            >
              <span className="truncate text-sm font-medium">{player.name}</span>
              <Vote className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
            </motion.button>
          ))}
        </motion.div>
      ) : null}

      {amAlive && !isQuestioner && votedId ? (
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
              <div className="text-sm font-semibold text-foreground">已完成投票</div>
              {targetPlayerName ? (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  投给 <span className="font-medium text-foreground">{targetPlayerName}</span>
                </div>
              ) : null}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 gap-1.5 text-xs"
            onClick={handleCancelVote}
          >
            <Undo2 className="h-3.5 w-3.5" />
            撤销
          </Button>
        </motion.div>
      ) : null}

      {isQuestioner ? (
        <div className="flex items-center justify-center gap-3 pt-2">
          <SupplementRequestControl canRequest={!isTieBreak} />
          <Button onClick={handleAdvance} size="lg" className="gap-2 px-6">
            <FastForward className="h-4 w-4" />
            结算投票
          </Button>
        </div>
      ) : null}
    </div>
  );
}
