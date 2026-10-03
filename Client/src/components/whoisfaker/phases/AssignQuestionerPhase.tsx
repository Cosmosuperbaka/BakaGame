import { useCallback } from "react";
import { UserCheck, Eye, AlertTriangle } from "lucide-react";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { CandidateGrid, SectionHeader } from "@/components/common/CandidateGrid";

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
                nameWrap="truncate"
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
                  <span className="inline-flex items-center gap-1 text-warning">
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
              nameWrap="truncate"
            />
          </section>
        </div>
      )}
    </div>
  );
}
