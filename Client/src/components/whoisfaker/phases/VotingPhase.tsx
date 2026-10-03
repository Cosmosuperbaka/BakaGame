import { usePhaseAction } from "./UsePhaseAction";
import { useCallback } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, FastForward, Undo2, Vote } from "lucide-react";
import { ABSTAIN_TARGET_ID } from "@/types";
import { Button } from "@/components/ui/Button";
import { listContainer, listItem, receiptCard, receiptMarkFollow, selectable } from "@/lib/Motion";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { PrivilegedActionPreview } from "../layout/PrivilegedActionPreview";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { SupplementRequestControl } from "../layout/SupplementRequestControl";
import { AbstainOption } from "../layout/AbstainOption";

export function VotingPhase() {
  const snapshot = useWhoIsFakerStore((state) => state.snapshot)!;
  const privateState = useWhoIsFakerStore((state) => state.privateState);
  const sendCommand = useWhoIsFakerStore((state) => state.sendCommand);
  const addToast = useWhoIsFakerStore((state) => state.addToast);
  const action = usePhaseAction();
  const { run, busy } = action;
  const phaseResultPresentationPending = useWhoIsFakerStore(
    (state) => state.phaseResultPresentationPending,
  );
  const isQuestioner = privateState?.isQuestioner ?? false;
  const me = snapshot.players.find((player) => player.id === privateState?.playerId);
  const amAlive = me?.roundStatus === "alive";
  const votedId = privateState?.myCurrentVoteTargetId ?? null;
  const isTieBreak = snapshot.status.phase === "tieBreak";
  const tieBreakCandidateIds = snapshot.status.tieBreakCandidateIds ?? [];
  const alivePlayers = snapshot.players.filter((player) => player.roundStatus === "alive");
  // 自己永远不在投票目标里，测试房间也一样：测试房要复现真实规则。
  const baseTargets = alivePlayers.filter((player) => player.id !== privateState?.playerId);
  const canVote = Boolean(amAlive && !isQuestioner && !votedId && (!isTieBreak || !tieBreakCandidateIds.includes(privateState?.playerId ?? "")));
  const targets =
    isTieBreak && tieBreakCandidateIds.length > 0
      ? alivePlayers.filter(
          (player) =>
            tieBreakCandidateIds.includes(player.id) && player.id !== privateState?.playerId,
        )
      : baseTargets;

  const handleVote = useCallback(
    async (targetId: string) => {
      await run(async () => {
      try {
        await sendCommand("game.submitVote", { targetId });
      } catch (error) {
        addToast((error as { message: string }).message, "error");
      }
      });
    },
    [run, addToast, sendCommand],
  );

  const handleCancelVote = useCallback(async () => {
    await run(async () => {
    try {
      await sendCommand("game.cancelVote", {});
    } catch (error) {
      addToast((error as { message: string }).message, "error");
    }
    });
  }, [run, addToast, sendCommand]);

  const handleAdvance = useCallback(async () => {
    await run(async () => {
    try {
      await sendCommand("game.advancePhase");
    } catch (error) {
      addToast((error as { message: string }).message, "error");
    }
    });
  }, [run, addToast, sendCommand]);

  const abstained = votedId === ABSTAIN_TARGET_ID;
  const targetPlayerName = abstained
    ? undefined
    : (targets.find((target) => target.id === votedId)?.name ??
      snapshot.players.find((player) => player.id === votedId)?.name);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <PhaseHeader
        icon={Vote}
        title={isTieBreak ? "平票 PK · 投票" : "投票阶段"}
        iconClassName={isTieBreak ? "text-warning" : undefined}
      />

      <PrivilegedActionPreview mode="vote" />

      {canVote ? (
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
              className="flex cursor-pointer items-center justify-between rounded-md bg-muted px-4 py-3.5 text-left transition-colors hover:bg-accent/40"
              disabled={busy}
              onClick={() => handleVote(player.id)}
            >
              <span className="truncate text-sm font-medium">{player.name}</span>
              <Vote className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
            </motion.button>
          ))}
          {/* 弃票与投人是同一次决定的两种结果，因此并入同一组选项，
              占满整行以区别于具体玩家。 */}
          <AbstainOption disabled={busy} onSelect={() => handleVote(ABSTAIN_TARGET_ID)} />
        </motion.div>
      ) : null}

      {isTieBreak && amAlive && tieBreakCandidateIds.includes(privateState?.playerId ?? "") && !votedId ? (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-center text-sm text-warning">你是平票候选人，本轮不参与投票。</p>
      ) : null}

      {amAlive && !isQuestioner && votedId ? (
        <motion.div
          {...receiptCard}
          className="mx-auto flex max-w-sm items-center justify-between gap-3 rounded-md border-2 border-primary/40 bg-primary/10 px-4 py-3"
        >
          <div className="flex items-center gap-2.5">
            <motion.span className="inline-flex shrink-0" {...receiptMarkFollow}>
              <CheckCircle2 className="h-5 w-5 text-primary" />
            </motion.span>
            <div>
              <div className="text-sm font-semibold text-foreground">
                {abstained ? "已弃票" : "已完成投票"}
              </div>
              {abstained ? (
                <div className="mt-0.5 text-xs text-muted-foreground">本轮不投出任何一票</div>
              ) : targetPlayerName ? (
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
            disabled={busy}
            onClick={handleCancelVote}
          >
            <Undo2 className="h-3.5 w-3.5" />
            撤销
          </Button>
        </motion.div>
      ) : null}

      {isQuestioner ? (
        <div className="flex items-center justify-center gap-3 pt-2">
          <SupplementRequestControl canRequest={!isTieBreak} action={action} />
          <Button
            onClick={handleAdvance}
            disabled={busy || phaseResultPresentationPending}
            size="lg"
            className="gap-2 px-6"
          >
            <FastForward className="h-4 w-4" />
            结算投票
          </Button>
        </div>
      ) : null}
    </div>
  );
}
