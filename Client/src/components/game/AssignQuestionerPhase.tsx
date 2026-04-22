import { useCallback } from "react";
import { motion } from "framer-motion";
import { UserCheck, Eye, AlertTriangle } from "lucide-react";
import { useGame } from "@/contexts/GameContext";
import { cn } from "@/lib/utils";

export function AssignQuestionerPhase() {
  const { state, sendCommand, addToast } = useGame();
  const snapshot = state.snapshot!;
  const me = snapshot.players.find((p) => p.id === state.privateState?.playerId);
  const isHost = me?.isHost ?? false;

  const activeCandidates = snapshot.players.filter(
    (p) => p.membership === "active"
  );
  const spectatorCandidates = snapshot.players.filter(
    (p) => p.membership === "spectator"
  );

  const handleAssign = useCallback(
    async (playerId: string) => {
      try {
        await sendCommand("game.assignQuestioner", { playerId });
      } catch (e) {
        addToast((e as { message: string }).message, "error");
      }
    },
    [sendCommand, addToast]
  );

  return (
    <motion.div
      className="flex flex-col items-center gap-6 py-10"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
    >
      <div className="text-center">
        <h2 className="text-2xl font-semibold mb-1.5">指定出题人</h2>
        <p className="text-sm text-muted-foreground">
          {isHost ? "选择一名玩家作为本局的出题人" : "等待房主指定出题人..."}
        </p>
      </div>

      {isHost && (
        <div className="w-full max-w-xl space-y-5">
          {/* 旁观者区块（优先推荐） */}
          {spectatorCandidates.length > 0 && (
            <section>
              <SectionHeader
                icon={<Eye className="h-3.5 w-3.5" />}
                title="旁观玩家"
                hint="推荐：正式玩家全员参战"
              />
              <CandidateGrid
                candidates={spectatorCandidates}
                onPick={handleAssign}
                tone="recommended"
              />
            </section>
          )}

          {/* 正式玩家区块 */}
          <section>
            <SectionHeader
              icon={<UserCheck className="h-3.5 w-3.5" />}
              title="正式玩家"
              hint={
                spectatorCandidates.length > 0 ? (
                  <span className="inline-flex items-center gap-1 text-amber-600">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    从此处指定会自动把卧底人数减 1
                  </span>
                ) : null
              }
            />
            <CandidateGrid
              candidates={activeCandidates}
              onPick={handleAssign}
              tone="default"
            />
          </section>
        </div>
      )}
    </motion.div>
  );
}

function SectionHeader({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-2.5 px-1">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {icon}
        {title}
      </div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function CandidateGrid({
  candidates,
  onPick,
  tone,
}: {
  candidates: { id: string; name: string }[];
  onPick: (id: string) => void;
  tone: "recommended" | "default";
}) {
  if (candidates.length === 0) {
    return (
      <div className="text-xs text-muted-foreground px-1 py-3">暂无玩家</div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {candidates.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onPick(p.id)}
          className={cn(
            "rounded-lg border px-3 py-2.5 text-left text-sm transition-[background,border-color] duration-150",
            "hover:border-primary/40 hover:bg-primary/5",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            tone === "recommended" && "border-primary/20 bg-primary/5"
          )}
        >
          <div className="flex items-center gap-1.5">
            {tone === "recommended" ? (
              <Eye className="h-3.5 w-3.5 text-primary/70 shrink-0" />
            ) : (
              <UserCheck className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <span className="font-medium truncate">{p.name}</span>
          </div>
        </button>
      ))}
    </div>
  );
}
