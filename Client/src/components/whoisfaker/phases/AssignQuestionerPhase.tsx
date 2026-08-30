import { useCallback } from "react";
import { motion } from "framer-motion";
import { UserCheck, Eye, AlertTriangle } from "lucide-react";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { listContainer, listItem, selectable } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

export function AssignQuestionerPhase() {
  const snapshot = useWhoIsFakerStore((s) => s.snapshot)!;
  const privateState = useWhoIsFakerStore((s) => s.privateState);
  const sendCommand = useWhoIsFakerStore((s) => s.sendCommand);
  const addToast = useWhoIsFakerStore((s) => s.addToast);
  const me = snapshot.players.find((p) => p.id === privateState?.playerId);
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
    <div className="flex flex-col items-center gap-6">
      <PhaseHeader
        icon={UserCheck}
        title="指定主持人"
      />

      {isHost && (
        <div className="w-full max-w-xl space-y-5">
          {/* 旁观者区块（优先推荐） */}
          {spectatorCandidates.length > 0 && (
            <section>
              <SectionHeader
                icon={<Eye className="h-3.5 w-3.5" />}
                title="旁观玩家"
                hint="推荐：玩家全员参战"
              />
              <CandidateGrid
                candidates={spectatorCandidates}
                onPick={handleAssign}
                tone="recommended"
              />
            </section>
          )}

          {/* 玩家区块 */}
          <section>
            <SectionHeader
              icon={<UserCheck className="h-3.5 w-3.5" />}
              title="玩家"
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
    </div>
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
    return <div className="px-1 py-3 text-xs text-muted-foreground">暂无玩家</div>;
  }

  return (
    <motion.div
      className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      variants={listContainer(candidates.length)}
      initial="initial"
      animate="animate"
    >
      {candidates.map((p) => (
        <motion.button
          key={p.id}
          type="button"
          variants={listItem}
          {...selectable}
          onClick={() => onPick(p.id)}
          className={cn(
            "cursor-pointer rounded-md border px-3 py-2.5 text-left text-sm transition-[background,border-color] duration-150",
            "hover:border-primary/40 hover:bg-primary/5",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            tone === "recommended" && "border-primary/20 bg-primary/5"
          )}
        >
          <div className="flex items-center gap-1.5">
            {tone === "recommended" ? (
              <Eye className="h-3.5 w-3.5 shrink-0 text-primary/70" />
            ) : (
              <UserCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate font-medium">{p.name}</span>
          </div>
        </motion.button>
      ))}
    </motion.div>
  );
}
