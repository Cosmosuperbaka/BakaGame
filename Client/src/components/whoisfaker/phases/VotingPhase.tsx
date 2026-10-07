import { usePhaseAction } from "./UsePhaseAction";
import { useCallback, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { FastForward, Vote } from "lucide-react";
import { ABSTAIN_TARGET_ID } from "@/types";
import { Button } from "@/components/ui/Button";
import { listContainer, useOriginTracker } from "@/lib/Motion";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { PrivilegedActionPreview } from "../layout/PrivilegedActionPreview";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { useSupplementRequest } from "../layout/SupplementRequestControl";
import { AbstainOption } from "../layout/AbstainOption";
import { ActionReceipt, TargetOption } from "../layout/ActionChoice";

export function VotingPhase() {
  const snapshot = useWhoIsFakerStore((state) => state.snapshot)!;
  const privateState = useWhoIsFakerStore((state) => state.privateState);
  const sendCommand = useWhoIsFakerStore((state) => state.sendCommand);
  const addToast = useWhoIsFakerStore((state) => state.addToast);
  const action = usePhaseAction();
  const { run, busy } = action;
  // 哪个命令在等应答：加载指示只落在发起它的按钮上，其余按钮照常禁用。
  const [pendingCommand, setPendingCommand] = useState<"cancel" | "advance" | null>(null);
  // 回执从被点的那张选项上展开
  const { origin, capture } = useOriginTracker();
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

  const runPending = useCallback(
    (key: "cancel" | "advance", type: string) =>
      run(async () => {
        setPendingCommand(key);
        try {
          await sendCommand(type, {});
        } catch (error) {
          addToast((error as { message: string }).message, "error");
        } finally {
          setPendingCommand(null);
        }
      }),
    [run, addToast, sendCommand],
  );
  const handleCancelVote = () => void runPending("cancel", "game.cancelVote");
  const handleAdvance = () => void runPending("advance", "game.advancePhase");
  const supplement = useSupplementRequest({ canRequest: !isTieBreak, action });

  const abstained = votedId === ABSTAIN_TARGET_ID;
  const targetPlayerName = abstained
    ? undefined
    : (targets.find((target) => target.id === votedId)?.name ??
      snapshot.players.find((player) => player.id === votedId)?.name);
  const isCandidate = tieBreakCandidateIds.includes(privateState?.playerId ?? "");
  const showReceipt = amAlive && !isQuestioner && Boolean(votedId);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <PhaseHeader
        icon={Vote}
        title={isTieBreak ? "平票 PK · 投票" : "投票阶段"}
        iconClassName={isTieBreak ? "text-warning" : undefined}
      />

      <PrivilegedActionPreview mode="vote" />

      {/* 选项与回执是同一次决定的前后两面：交叉替换，回执从被点的选项上展开，撤销时收回 */}
      <div className="relative">
        <AnimatePresence mode="popLayout" initial={false}>
          {canVote ? (
            <motion.div
              key="options"
              className="grid grid-cols-2 gap-2.5"
              variants={listContainer(targets.length)}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              {targets.map((player) => (
                <TargetOption
                  key={player.id}
                  name={player.name}
                  tone="vote"
                  disabled={busy}
                  onSelect={(event) => {
                    capture(event);
                    void handleVote(player.id);
                  }}
                />
              ))}
              {/* 弃票与投人是同一次决定的两种结果，因此并入同一组选项，
                  占满整行以区别于具体玩家。 */}
              <AbstainOption
                label="弃票"
                disabled={busy}
                onSelect={(event) => {
                  capture(event);
                  void handleVote(ABSTAIN_TARGET_ID);
                }}
              />
            </motion.div>
          ) : showReceipt ? (
            <ActionReceipt
              key="receipt"
              title={abstained ? "已弃票" : "已完成投票"}
              detail={
                abstained ? "本轮不投出任何一票" : targetPlayerName ? (
                  <>投给 <span className="font-medium text-foreground">{targetPlayerName}</span></>
                ) : null
              }
              origin={origin}
              busy={pendingCommand === "cancel"}
              onUndo={handleCancelVote}
            />
          ) : null}
        </AnimatePresence>
      </div>

      {isTieBreak && amAlive && isCandidate && !votedId ? (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-center text-sm text-warning">你是平票候选人，本轮不参与投票。</p>
      ) : null}

      {/* 不能投票的人也要知道自己在等什么 */}
      {!isQuestioner && me?.membership === "active" && me.roundStatus === "dead" ? (
        <p className="text-center text-sm text-muted-foreground">你已出局，本轮不能投票</p>
      ) : null}

      {isQuestioner ? (
        <div className="space-y-3 pt-2">
          {supplement.panel}
          <div className="flex flex-wrap items-center justify-center gap-3">
            {supplement.trigger}
            <Button
              onClick={handleAdvance}
              disabled={busy}
              loading={pendingCommand === "advance"}
              size="lg"
            >
              {pendingCommand === "advance" ? null : <FastForward className="h-4 w-4" />}
              结算投票
            </Button>
          </div>
          {supplement.hint}
        </div>
      ) : null}
    </div>
  );
}
