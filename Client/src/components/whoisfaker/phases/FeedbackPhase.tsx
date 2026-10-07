import { useCallback } from "react";
import { motion } from "framer-motion";
import { CircleHelp, FastForward, Sunrise, Vote } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { listContainer, listItem, sunrise } from "@/lib/Motion";
import { feedbackNextLabel, playerNameOf, tallyVotes } from "@/lib/WhoIsFakerHistory";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { ABSTAIN_TARGET_ID, type RoundFeedback, type WhoIsFakerRoomSnapshot } from "@/types";
import { usePhaseAction } from "./UsePhaseAction";
import { GuessReadout } from "./BlankGuessPhase";

/** 出局名单的一句话结论：没人出局时给出各自的说法。 */
function EliminationLine({ names, empty }: { names: string[]; empty: string }) {
  if (!names.length) return <p className="text-center text-base font-medium text-muted-foreground">{empty}</p>;
  return (
    <p className="text-center text-base">
      <span className="font-semibold text-destructive">{names.join("、")}</span>
      <span className="text-muted-foreground"> 出局</span>
    </p>
  );
}

/** 投票反馈：每个人投给了谁、各自得票，以及最终谁出局或进入平票 PK。 */
function VoteFeedback({ feedback, snapshot }: { feedback: RoundFeedback; snapshot: WhoIsFakerRoomSnapshot }) {
  const votes = feedback.votes ?? [];
  const tally = tallyVotes(votes);
  const nameOf = (id: string) => playerNameOf(snapshot.players, id);
  const eliminated = feedback.eliminatedPlayerIds.map(nameOf);
  const candidates = (feedback.tieBreakCandidateIds ?? []).map(nameOf);

  return (
    <div className="space-y-5">
      <PhaseHeader
        icon={Vote}
        title={feedback.tieBreak ? `第 ${feedback.day} 天 · 平票 PK 结果` : `第 ${feedback.day} 天投票结果`}
        iconClassName={feedback.tieBreak ? "text-warning" : undefined}
      />

      {candidates.length ? (
        <p className="text-center text-base">
          <span className="font-semibold text-warning">{candidates.join("、")}</span>
          <span className="text-muted-foreground"> 平票，进入 PK</span>
        </p>
      ) : (
        <EliminationLine names={eliminated} empty={votes.length ? "无人出局" : "无人投票，无人出局"} />
      )}

      {tally.length ? (
        <section className="space-y-2 rounded-md bg-muted p-4">
          <h3 className="text-xs font-semibold text-muted-foreground">得票</h3>
          <motion.ul
            className="flex flex-wrap gap-2"
            variants={listContainer(tally.length)}
            initial="initial"
            animate="animate"
          >
            {tally.map(({ targetId, count }) => {
              const out = feedback.eliminatedPlayerIds.includes(targetId);
              return (
                <motion.li key={targetId} variants={listItem}>
                  <Badge variant={out ? "destructive" : "outline"} className="gap-1.5 bg-background">
                    <span>{targetId === ABSTAIN_TARGET_ID ? "弃票" : nameOf(targetId)}</span>
                    <span className="tabular-nums">{count} 票</span>
                  </Badge>
                </motion.li>
              );
            })}
          </motion.ul>
        </section>
      ) : null}

      {votes.length ? (
        <section className="space-y-2 rounded-md bg-muted p-4">
          <h3 className="text-xs font-semibold text-muted-foreground">票型</h3>
          <motion.ul
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            variants={listContainer(votes.length)}
            initial="initial"
            animate="animate"
          >
            {votes.map((vote) => {
              const abstained = vote.targetId === ABSTAIN_TARGET_ID;
              return (
                <motion.li
                  key={vote.voterId}
                  variants={listItem}
                  className="flex min-w-0 items-center gap-2 rounded-md bg-background px-3 py-1.5 text-sm"
                >
                  <span className="min-w-0 truncate font-medium">{nameOf(vote.voterId)}</span>
                  <span className="shrink-0 text-muted-foreground">{abstained ? "选择" : "投给"}</span>
                  <span className={abstained ? "shrink-0 text-muted-foreground" : "min-w-0 truncate font-medium"}>
                    {abstained ? "弃票" : nameOf(vote.targetId)}
                  </span>
                </motion.li>
              );
            })}
          </motion.ul>
        </section>
      ) : null}
    </div>
  );
}

/** 夜晚反馈即「天亮」：只公布谁在夜里出局，凶手留到结算历史里再揭晓。 */
function NightFeedback({ feedback, snapshot }: { feedback: RoundFeedback; snapshot: WhoIsFakerRoomSnapshot }) {
  const eliminated = feedback.eliminatedPlayerIds.map((id) => playerNameOf(snapshot.players, id));
  return (
    <div className="space-y-5">
      <div className="flex min-h-[5.5rem] flex-col items-center justify-start text-center">
        {/* 日出图标自下升起，与「天亮」语义一致 */}
        <motion.span className="flex h-11 w-11 items-center justify-center rounded-md bg-muted" {...sunrise}>
          <Sunrise className="h-5 w-5 text-warning" />
        </motion.span>
        <h2 className="mt-3 text-2xl font-semibold leading-8">天亮了</h2>
      </div>
      <div className="space-y-1 rounded-md bg-muted px-4 py-5">
        <p className="text-center text-xs text-muted-foreground">第 {feedback.day} 天夜里</p>
        <EliminationLine names={eliminated} empty="平安夜，无人出局" />
      </div>
    </div>
  );
}

/** 白板猜词反馈：猜词过程全房已实时看过，这里只把最终两词与对错摆出来。 */
function BlankGuessFeedback({ feedback, snapshot }: { feedback: RoundFeedback; snapshot: WhoIsFakerRoomSnapshot }) {
  const record = feedback.blankGuess;
  const guesser = record ? playerNameOf(snapshot.players, record.playerId) : "白板";
  return (
    <div className="mx-auto max-w-md space-y-5">
      <PhaseHeader icon={CircleHelp} title="白板猜词结果" iconClassName="text-warning" />
      <p className="text-center text-sm font-medium">{guesser} 的猜测</p>
      <GuessReadout words={record?.guessedWords} submitted />
      <div className="flex flex-col items-center gap-1.5">
        <Badge variant={record?.success ? "matched" : "destructive"} className="px-3 py-1 text-sm">
          {record?.success ? "猜中" : "未猜中"}
        </Badge>
        {feedback.blankGuessReviewed ? (
          <p className="text-xs text-muted-foreground">经主持人裁定</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 阶段反馈：投票、夜晚与白板猜词结算后停在这里，由出题人手动继续。
 * 旁观者在上一阶段看过实时预览，结果页紧接着出现，读作同一件事的收尾。
 */
export function FeedbackPhase() {
  const snapshot = useWhoIsFakerStore((s) => s.snapshot)!;
  const privateState = useWhoIsFakerStore((s) => s.privateState);
  const sendCommand = useWhoIsFakerStore((s) => s.sendCommand);
  const addToast = useWhoIsFakerStore((s) => s.addToast);
  const { run, busy } = usePhaseAction();
  const feedback = snapshot.status.feedback;
  // 测试房跳转后可能没有出题人，服务端放开给房内任何人继续
  const canContinue = (privateState?.isQuestioner ?? false) || snapshot.testMode;

  const handleContinue = useCallback(
    () =>
      void run(async () => {
        try {
          await sendCommand("game.advancePhase");
        } catch (e) {
          addToast((e as { message: string }).message, "error");
        }
      }),
    [run, sendCommand, addToast],
  );

  if (!feedback) {
    return <p className="py-12 text-center text-sm text-muted-foreground">结果同步中…</p>;
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      {feedback.kind === "vote" ? (
        <VoteFeedback feedback={feedback} snapshot={snapshot} />
      ) : feedback.kind === "night" ? (
        <NightFeedback feedback={feedback} snapshot={snapshot} />
      ) : (
        <BlankGuessFeedback feedback={feedback} snapshot={snapshot} />
      )}

      <div className="flex justify-center pt-2">
        {canContinue ? (
          <Button size="lg" onClick={handleContinue} loading={busy}>
            {busy ? null : <FastForward className="h-4 w-4" />}
            {feedbackNextLabel(feedback)}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">等待主持人继续</p>
        )}
      </div>
    </div>
  );
}
