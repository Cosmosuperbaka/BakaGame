import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, MessageSquarePlus, Send, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGameStore } from "@/stores/useGameStore";
import { cn } from "@/lib/utils";

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
    <div className="space-y-3">
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="space-y-3 rounded-md bg-muted p-4 text-left">
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
                    <button
                      key={player.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => togglePlayer(player.id)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                        selected
                          ? "border-sky-500 bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200"
                          : "text-muted-foreground hover:bg-muted",
                      )}
                    >
                      {selected && <Check className="h-3 w-3" />}
                      {player.name}
                    </button>
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
          等待 {pendingPlayerIds.length} 名玩家完成补充发言，完成前不能结算投票
        </p>
      ) : canRequest && !open ? (
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
          <MessageSquarePlus className="h-3.5 w-3.5" />
          请求补充发言
        </Button>
      ) : null}
    </div>
  );
}
