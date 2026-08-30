import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, MessageSquarePlus, Send, Users, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { collapsible, spring, tappable } from "@/lib/Motion";
import { useWhoIsFakerStore as useGameStore } from "@/stores/UseWhoIsFakerStore";
import { cn } from "@/lib/Utils";

interface Props {
  canRequest: boolean;
}

export function SupplementRequestControl({ canRequest }: Props) {
  const snapshot = useGameStore((state) => state.snapshot)!;
  const privateState = useGameStore((state) => state.privateState);
  const sendCommand = useGameStore((state) => state.sendCommand);
  const addToast = useGameStore((state) => state.addToast);
  const [open, setOpen] = useState(false);
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<string[]>([]);

  const pendingPlayerIds = snapshot.status.pendingSupplementPlayerIds ?? [];
  const supplementActive = pendingPlayerIds.length > 0;
  const isQuestioner = privateState?.isQuestioner ?? false;
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

  const requestSupplement = async () => {
    if (selectedPlayerIds.length === 0) return;
    try {
      await sendCommand("game.requestSupplement", { playerIds: selectedPlayerIds });
      close();
    } catch (error) {
      addToast((error as { message: string }).message, "error");
    }
  };

  if (!isQuestioner) {
    return supplementActive ? (
      <div className="flex items-center justify-center gap-2 text-xs text-sky-700 dark:text-sky-300">
        <MessageSquarePlus className="h-3.5 w-3.5" />
        补充发言进行中，完成后恢复原阶段
      </div>
    ) : null;
  }

  return (
    <div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            variants={collapsible}
            initial="initial"
            animate="animate"
            exit="exit"
            className="overflow-hidden"
          >
            <div className="mb-3 space-y-3 rounded-md bg-muted p-4 text-left">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Users className="h-4 w-4 text-sky-600" />
                  选择补充发言玩家
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={close}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {candidates.map((player) => {
                  const selected = selectedPlayerIds.includes(player.id);
                  return (
                    <motion.button
                      key={player.id}
                      type="button"
                      layout
                      {...tappable}
                      aria-pressed={selected}
                      onClick={() => togglePlayer(player.id)}
                      className={cn(
                        "flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                        selected
                          ? "border-primary/40 bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:bg-accent/50",
                      )}
                    >
                      <AnimatePresence initial={false}>
                        {selected ? (
                          <motion.span
                            key="check"
                            initial={{ width: 0, opacity: 0, scale: 0.6 }}
                            animate={{ width: "0.75rem", opacity: 1, scale: 1 }}
                            exit={{ width: 0, opacity: 0, scale: 0.6 }}
                            transition={spring.snap}
                            className="inline-flex shrink-0 overflow-hidden"
                          >
                            <Check className="h-3 w-3" />
                          </motion.span>
                        ) : null}
                      </AnimatePresence>
                      {player.name}
                    </motion.button>
                  );
                })}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={close}>取消</Button>
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={selectedPlayerIds.length === 0}
                  onClick={requestSupplement}
                >
                  <Send className="h-3.5 w-3.5" />
                  发起补充 ({selectedPlayerIds.length})
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {supplementActive ? (
        <p className="text-center text-xs text-sky-700 dark:text-sky-300">
          等待 {pendingPlayerIds.length} 名玩家完成补充发言
        </p>
      ) : canRequest && !open ? (
        <Button size="lg" variant="outline" className="gap-2 px-6" onClick={() => setOpen(true)}>
          <MessageSquarePlus className="h-4 w-4" />
          请求补充发言
        </Button>
      ) : null}
    </div>
  );
}
