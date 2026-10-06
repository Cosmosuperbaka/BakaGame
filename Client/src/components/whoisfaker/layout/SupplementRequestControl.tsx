import { usePhaseAction, type PhaseAction } from "../phases/UsePhaseAction";
import { useId, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, MessageSquarePlus, Plus, Send, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CloseButton } from "@/components/ui/CloseButton";
import { CollapsibleRegion } from "@/components/ui/Collapsible";
import { receiptMark, tappable } from "@/lib/Motion";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { cn } from "@/lib/Utils";

interface Options {
  canRequest: boolean;
  action?: PhaseAction;
}

interface SupplementRequest {
  /** 按钮行里的入口；展开后保留，`aria-expanded` 指向面板 */
  trigger: ReactNode;
  /** 选人面板：整宽块，放在按钮行上方 */
  panel: ReactNode;
  /** 补充进行中的说明，放在按钮行下方 */
  hint: ReactNode;
}

/**
 * 主持人发起补充发言。入口、选人面板与进行中说明分开交给调用处摆放：
 * 面板是按钮行上方的整宽块，入口仍在按钮行里，与推进按钮并排，两者不互相挤压。
 * 非主持人只得到进行中的说明。
 */
export function useSupplementRequest({ canRequest, action }: Options): SupplementRequest {
  const snapshot = useWhoIsFakerStore((state) => state.snapshot)!;
  const isQuestioner = useWhoIsFakerStore((state) => state.privateState?.isQuestioner ?? false);
  const sendCommand = useWhoIsFakerStore((state) => state.sendCommand);
  const addToast = useWhoIsFakerStore((state) => state.addToast);
  const ownAction = usePhaseAction();
  const { run, busy } = action ?? ownAction;
  const [open, setOpen] = useState(false);
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<string[]>([]);
  const panelId = useId();

  const pendingPlayerIds = snapshot.status.pendingSupplementPlayerIds ?? [];
  const supplementActive = pendingPlayerIds.length > 0;
  const candidates = snapshot.players.filter(
    (player) =>
      player.roundStatus === "alive" && player.id !== snapshot.status.questionerPlayerId,
  );

  const close = () => {
    setOpen(false);
    setSelectedPlayerIds([]);
  };

  const togglePlayer = (playerId: string) => {
    setSelectedPlayerIds((currentIds) =>
      currentIds.includes(playerId)
        ? currentIds.filter((currentId) => currentId !== playerId)
        : [...currentIds, playerId],
    );
  };

  const requestSupplement = () =>
    run(async () => {
      if (selectedPlayerIds.length === 0) return;
      try {
        await sendCommand("game.requestSupplement", { playerIds: selectedPlayerIds });
        close();
      } catch (error) {
        addToast((error as { message: string }).message, "error");
      }
    });

  if (!isQuestioner) {
    return {
      trigger: null,
      panel: null,
      hint: supplementActive ? (
        <p className="flex items-center justify-center gap-2 text-xs text-info">
          <MessageSquarePlus className="h-3.5 w-3.5" />
          补充发言进行中，完成后恢复原阶段
        </p>
      ) : null,
    };
  }

  const panelOpen = open && canRequest && !supplementActive;

  return {
    trigger: canRequest && !supplementActive ? (
      <Button
        size="lg"
        variant="outline"
        aria-expanded={panelOpen}
        aria-controls={panelOpen ? panelId : undefined}
        onClick={() => (panelOpen ? close() : setOpen(true))}
      >
        <MessageSquarePlus className="h-4 w-4" />
        请求补充发言
      </Button>
    ) : null,
    panel: (
      <CollapsibleRegion open={panelOpen} id={panelId}>
        <div className="space-y-3 rounded-md bg-muted p-4 text-left">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Users className="h-4 w-4 text-info" />
              选择补充发言玩家
            </div>
            <CloseButton className="h-7 w-7" onClick={close} aria-label="收起补充发言" />
          </div>
          <div className="flex flex-wrap gap-2">
            {candidates.map((player) => {
              const selected = selectedPlayerIds.includes(player.id);
              return (
                <motion.button
                  key={player.id}
                  type="button"
                  {...tappable}
                  aria-pressed={selected}
                  disabled={busy}
                  title={player.name}
                  onClick={() => togglePlayer(player.id)}
                  className={cn(
                    "flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                    selected
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-dashed border-border bg-background text-muted-foreground hover:bg-accent/40",
                  )}
                >
                  {/* 图标位定宽，选中与否只换图标，胶囊不随之伸缩 */}
                  <span aria-hidden="true" className="grid h-3 w-3 shrink-0 place-items-center">
                    <AnimatePresence mode="popLayout" initial={false}>
                      <motion.span key={selected ? "on" : "off"} className="[grid-area:1/1]" {...receiptMark}>
                        {selected ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                      </motion.span>
                    </AnimatePresence>
                  </span>
                  <span className="truncate">{player.name}</span>
                </motion.button>
              );
            })}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={close}>取消</Button>
            <Button
              size="sm"
              loading={busy}
              disabled={selectedPlayerIds.length === 0}
              onClick={() => void requestSupplement()}
            >
              {busy ? null : <Send className="h-3.5 w-3.5" />}
              发起补充 ({selectedPlayerIds.length})
            </Button>
          </div>
        </div>
      </CollapsibleRegion>
    ),
    hint: supplementActive ? (
      <p className="text-center text-xs text-info">
        等待 {pendingPlayerIds.length} 名玩家完成补充发言
      </p>
    ) : null,
  };
}
