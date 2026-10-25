import { usePhaseAction } from "./UsePhaseAction";
import { useCallback, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { FastForward, Vote } from "lucide-react";
import { ABSTAIN_TARGET_ID } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { listContainer, useOriginTracker } from "@/lib/Motion";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { PrivilegedActionPreview } from "../layout/PrivilegedActionPreview";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { useSupplementRequest } from "../layout/SupplementRequestControl";
import { AbstainOption } from "../layout/AbstainOption";
import { ActionReceipt, TargetOption } from "../layout/ActionChoice";

/** 投票候选：平票 PK 只在候选人里选，任何情况下都不投自己，测试房间也一样。 */
const pickVoteTargets = <P extends { id: string }>(
  alivePlayers: P[],
  tieBreakCandidateIds: string[],
  selfId: string | undefined,
  isTieBreak: boolean
): P[] => {
  if (!isTieBreak || tieBreakCandidateIds.length === 0)
    return alivePlayers.filter((player) => player.id !== selfId);
  return alivePlayers.filter(
    (player) => tieBreakCandidateIds.includes(player.id) && player.id !== selfId
  );
};

/** 投票视图：谁能投、投给谁、回执显示谁，全部由房间快照与私有态推出。 */
const useVotingView = () => {
  const snapshot = useWhoIsFakerStore((state) => state.snapshot)!;
  const privateState = useWhoIsFakerStore((state) => state.privateState);
  const selfId = privateState?.playerId;
  const isQuestioner = privateState?.isQuestioner ?? false;
  const me = snapshot.players.find((player) => player.id === selfId);
  const amAlive = me?.roundStatus === "alive";
  const votedId = privateState?.myCurrentVoteTargetId ?? null;
  const isTieBreak = snapshot.status.phase === "tieBreak";
  const tieBreakCandidateIds = snapshot.status.tieBreakCandidateIds ?? [];
  const alivePlayers = snapshot.players.filter((player) => player.roundStatus === "alive");
  const targets = pickVoteTargets(alivePlayers, tieBreakCandidateIds, selfId, isTieBreak);
  const isCandidate = tieBreakCandidateIds.includes(selfId ?? "");
  const canVote = Boolean(amAlive && !isQuestioner && !votedId && (!isTieBreak || !isCandidate));
  const abstained = votedId === ABSTAIN_TARGET_ID;
  // 弃票没有收件人；已出局的目标不在候选里，回退到全量玩家查名。
  const targetPlayerName = abstained
    ? undefined
    : (targets.find((target) => target.id === votedId)?.name ??
      snapshot.players.find((player) => player.id === votedId)?.name);
  const showReceipt = amAlive && !isQuestioner && Boolean(votedId);
  return {
    me,
    isQuestioner,
    isTieBreak,
    amAlive,
    votedId,
    abstained,
    targetPlayerName,
    isCandidate,
    canVote,
    showReceipt,
    targets,
  };
};

/** 回执文案：弃票说明本轮不投出任何一票，投人则点名收件人。 */
const receiptTitle = (abstained: boolean) => (abstained ? "已弃票" : "已完成投票");
const receiptDetail = (abstained: boolean, targetPlayerName?: string) =>
  abstained ? (
    "本轮不投出任何一票"
  ) : targetPlayerName ? (
    <>
      投给 <span className="font-medium text-foreground">{targetPlayerName}</span>
    </>
  ) : null;

export function VotingPhase() {
  const {
    me,
    isQuestioner,
    isTieBreak,
    amAlive,
    votedId,
    abstained,
    targetPlayerName,
    isCandidate,
    canVote,
    showReceipt,
    targets,
  } = useVotingView();
  const sendCommand = useWhoIsFakerStore((state) => state.sendCommand);
  const addToast = useWhoIsFakerStore((state) => state.addToast);
  const action = usePhaseAction();
  const { run, busy } = action;
  // 哪个命令在等应答：加载指示只落在发起它的按钮上，其余按钮照常禁用。
  const [pendingCommand, setPendingCommand] = useState<"cancel" | "advance" | null>(null);
  // 回执从被点的那张选项上展开
  const { origin, capture } = useOriginTracker();

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
    [run, addToast, sendCommand]
  );

  const runPending = useCallback(
    (key: "cancel" | "advance", type: "game.cancelVote" | "game.advancePhase") =>
      run(async () => {
        setPendingCommand(key);
        try {
          await sendCommand(type);
        } catch (error) {
          addToast((error as { message: string }).message, "error");
        } finally {
          setPendingCommand(null);
        }
      }),
    [run, addToast, sendCommand]
  );
  const handleCancelVote = () => void runPending("cancel", "game.cancelVote");
  const handleAdvance = () => void runPending("advance", "game.advancePhase");
  const supplement = useSupplementRequest({ canRequest: !isTieBreak, action });

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
                  controlId={`faker.vote.${player.id}`}
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
                controlId="faker.vote.abstain"
                onSelect={(event) => {
                  capture(event);
                  void handleVote(ABSTAIN_TARGET_ID);
                }}
              />
            </motion.div>
          ) : showReceipt ? (
            <ActionReceipt
              key="receipt"
              title={receiptTitle(abstained)}
              detail={receiptDetail(abstained, targetPlayerName)}
              origin={origin}
              busy={pendingCommand === "cancel"}
              undoControlId="faker.cancelVote"
              onUndo={handleCancelVote}
            />
          ) : null}
        </AnimatePresence>
      </div>

      {isTieBreak && amAlive && isCandidate && !votedId ? (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-center text-sm text-warning">
          你是平票候选人，本轮不参与投票。
        </p>
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
              data-agent-control="faker.advance"
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
