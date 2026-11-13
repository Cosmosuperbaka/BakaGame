import { useFakerPhaseAction } from "./UseFakerPhaseAction";
import { AnimatePresence, motion } from "framer-motion";
import { Moon, FastForward } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useOriginTracker } from "@/hooks/UseOriginTracker";
import { listContainer } from "@/lib/Motion";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { FakerPrivilegedActionPreview } from "../layout/FakerPrivilegedActionPreview";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { FakerAbstainOption } from "../layout/FakerAbstainOption";
import { ActionReceipt, ReceiptAnnouncer, TargetOption } from "../layout/FakerActionChoice";

/** 读屏播报的夜晚回执：与可见回执同一件事，写成一句话。 */
const nightReceiptSpeech = (targetName?: string) =>
  `已完成夜晚决策，${targetName ? `目标 ${targetName}` : "本夜不行动"}`;

export function FakerNightPhase() {
  const snapshot = useWhoIsFakerStore((s) => s.snapshot)!;
  const privateState = useWhoIsFakerStore((s) => s.privateState);
  const { exec, busy, pending } = useFakerPhaseAction();
  // 回执从被点的那张选项上展开
  const { origin, capture } = useOriginTracker();
  const isQuestioner = privateState?.isQuestioner ?? false;
  const me = snapshot.players.find((p) => p.id === privateState?.playerId);
  const amAlive = me?.roundStatus === "alive";

  const acted = privateState?.nightActionSubmitted ?? false;
  const actionTargetName = snapshot.players.find(
    (p) => p.id === privateState?.myCurrentNightTargetId
  )?.name;

  const canAct = amAlive && !isQuestioner && (privateState?.canActAtNight ?? false);

  // 自己永远不是夜晚目标，测试房间也一样。
  const targets = snapshot.players.filter(
    (p) => p.roundStatus === "alive" && p.id !== privateState?.playerId
  );

  const handleNightAction = (targetId?: string) =>
    void exec("game.submitNightAction", { targetId: targetId ?? null });
  const handleCancelNightAction = () =>
    void exec("game.cancelNightAction", undefined, { key: "cancel" });
  const handleAdvance = () => void exec("game.advancePhase", undefined, { key: "advance" });

  // 夜里不行动的人各自说明原因，不留一块空白
  const idleNote =
    isQuestioner || me?.membership !== "active"
      ? null
      : !amAlive
        ? "你已出局，等待天亮"
        : privateState?.specialRole
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
                    handleNightAction(p.id);
                  }}
                />
              ))}
              <FakerAbstainOption
                label="不行动"
                disabled={busy}
                controlId="faker.night.skip"
                onSelect={(event) => {
                  capture(event);
                  handleNightAction();
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
              busy={pending === "cancel"}
              undoControlId="faker.cancelNight"
              focusUndo={origin !== null}
              onUndo={handleCancelNightAction}
            />
          ) : null}
        </AnimatePresence>
        <ReceiptAnnouncer text={canAct && acted ? nightReceiptSpeech(actionTargetName) : ""} />
      </div>

      {idleNote ? <p className="text-center text-sm text-muted-foreground">{idleNote}</p> : null}

      {isQuestioner && (
        <div className="flex justify-center pt-2">
          <Button
            onClick={handleAdvance}
            disabled={busy}
            loading={pending === "advance"}
            size="lg"
            data-agent-control="faker.advance"
          >
            {pending === "advance" ? null : <FastForward className="h-4 w-4" />}
            天亮了
          </Button>
        </div>
      )}
    </div>
  );
}
