import { useFakerPhaseAction } from "./UseFakerPhaseAction";
import { useCallback, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Moon, FastForward } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { listContainer, useOriginTracker } from "@/lib/Motion";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { FakerPrivilegedActionPreview } from "../layout/FakerPrivilegedActionPreview";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { FakerAbstainOption } from "../layout/FakerAbstainOption";
import { ActionReceipt, TargetOption } from "../layout/FakerActionChoice";

export function FakerNightPhase() {
  const snapshot = useWhoIsFakerStore((s) => s.snapshot)!;
  const privateState = useWhoIsFakerStore((s) => s.privateState);
  const sendCommand = useWhoIsFakerStore((s) => s.sendCommand);
  const addToast = useWhoIsFakerStore((s) => s.addToast);
  const action = useFakerPhaseAction();
  const { run, busy } = action;
  const [pendingCommand, setPendingCommand] = useState<"cancel" | "advance" | null>(null);
  // 回执从被点的那张选项上展开
  const { origin, capture } = useOriginTracker();
  const isQuestioner = privateState?.isQuestioner ?? false;
  const me = snapshot.players.find((p) => p.id === privateState?.playerId);
  const amAlive = me?.roundStatus === "alive";
  const role = privateState?.role;

  const acted = privateState?.nightActionSubmitted ?? false;
  const actionTargetName = snapshot.players.find(
    (p) => p.id === privateState?.myCurrentNightTargetId
  )?.name;

  const canAct = amAlive && !isQuestioner && (role === "civilian" || role === "undercover");

  // 自己永远不是夜晚目标，测试房间也一样。
  const targets = snapshot.players.filter(
    (p) => p.roundStatus === "alive" && p.id !== privateState?.playerId
  );

  const handleNightAction = useCallback(
    async (targetId?: string) => {
      await run(async () => {
        try {
          await sendCommand("game.submitNightAction", { targetId: targetId ?? null });
        } catch (e) {
          addToast((e as { message: string }).message, "error");
        }
      });
    },
    [run, sendCommand, addToast]
  );

  const runPending = useCallback(
    (key: "cancel" | "advance", type: "game.cancelNightAction" | "game.advancePhase") =>
      run(async () => {
        setPendingCommand(key);
        try {
          await sendCommand(type);
        } catch (e) {
          addToast((e as { message: string }).message, "error");
        } finally {
          setPendingCommand(null);
        }
      }),
    [run, sendCommand, addToast]
  );
  const handleCancelNightAction = () => void runPending("cancel", "game.cancelNightAction");
  const handleAdvance = () => void runPending("advance", "game.advancePhase");

  // 夜里不行动的人各自说明原因，不留一块空白
  const idleNote =
    isQuestioner || me?.membership !== "active"
      ? null
      : !amAlive
        ? "你已出局，等待天亮"
        : role === "angel" || role === "blank"
          ? "你今晚没有行动，等待天亮"
          : null;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <PhaseHeader icon={Moon} title="夜晚降临" />

      <FakerPrivilegedActionPreview mode="night" />

      {/* 与投票阶段同一套交叉：选项退场、回执从被点的选项上展开 */}
      <div className="relative">
        <AnimatePresence mode="popLayout" initial={false}>
          {canAct && !acted ? (
            <motion.div
              key="options"
              className="grid grid-cols-2 gap-2.5"
              variants={listContainer(targets.length)}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              {targets.map((p) => (
                <TargetOption
                  key={p.id}
                  name={p.name}
                  tone="night"
                  disabled={busy}
                  controlId={`faker.night.${p.id}`}
                  onSelect={(event) => {
                    capture(event);
                    void handleNightAction(p.id);
                  }}
                />
              ))}
              <FakerAbstainOption
                label="不行动"
                disabled={busy}
                controlId="faker.night.skip"
                onSelect={(event) => {
                  capture(event);
                  void handleNightAction();
                }}
              />
            </motion.div>
          ) : canAct && acted ? (
            <ActionReceipt
              key="receipt"
              title="已完成夜晚决策"
              detail={
                actionTargetName ? (
                  <>
                    目标 <span className="font-medium text-foreground">{actionTargetName}</span>
                  </>
                ) : (
                  "本夜不行动"
                )
              }
              origin={origin}
              busy={pendingCommand === "cancel"}
              undoControlId="faker.cancelNight"
              onUndo={handleCancelNightAction}
            />
          ) : null}
        </AnimatePresence>
      </div>

      {idleNote ? <p className="text-center text-sm text-muted-foreground">{idleNote}</p> : null}

      {isQuestioner && (
        <div className="flex justify-center pt-2">
          <Button
            onClick={handleAdvance}
            disabled={busy}
            loading={pendingCommand === "advance"}
            size="lg"
            data-agent-control="faker.advance"
          >
            {pendingCommand === "advance" ? null : <FastForward className="h-4 w-4" />}
            天亮了
          </Button>
        </div>
      )}
    </div>
  );
}
