import { Eye, UserCheck } from "lucide-react";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { CandidateGrid, SectionHeader } from "@/components/common/CandidateGrid";
import { withTeamName } from "@/lib/Teams";
import type { SongGameAreaProps } from "./SongGameAreaProps";

/**
 * 房主指定出题人：候选取服务端下发的 `submitterCandidateIds`（在线真人，且他出题、队友一起观战后仍留得下猜歌的人）。
 * 组队时候选名后带上队伍，并提示指定后其队友本局一起观战。
 */
export function SongChoosingSubmitterPhase({
  snapshot,
  privateState,
  isHost,
  run,
  isPending,
}: Pick<SongGameAreaProps, "snapshot" | "privateState" | "isHost" | "run" | "isPending">) {
  const allowed = new Set(privateState.submitterCandidateIds);
  const candidates = snapshot.players.filter((player) => allowed.has(player.id));
  const activeCandidates = candidates
    .filter((player) => player.membership === "active")
    .map(withTeamName);
  const spectatorCandidates = candidates.filter((player) => player.membership === "spectator");
  const teamed = snapshot.players.some(
    (player) => player.membership === "active" && player.team !== null
  );
  const choosing = isPending?.("song.game.chooseSubmitter") ?? false;
  const pick = (playerId: string) => void run("song.game.chooseSubmitter", { playerId });
  return (
    <div className="flex flex-col items-center gap-6">
      <PhaseHeader icon={UserCheck} title="指定出题人" />
      {snapshot.submitterPrompt ? (
        <p className="max-w-xl text-center text-sm text-muted-foreground">
          {snapshot.submitterPrompt}
        </p>
      ) : null}
      {isHost ? (
        <div className="w-full max-w-xl space-y-5">
          {spectatorCandidates.length > 0 ? (
            <section>
              <SectionHeader title="旁观玩家" icon={<Eye className="h-3.5 w-3.5" />} />
              <CandidateGrid
                candidates={spectatorCandidates}
                tone="recommended"
                nameWrap="wrap"
                disabled={choosing}
                onPick={pick}
                agentControlPrefix="song.submitter"
              />
            </section>
          ) : null}
          {activeCandidates.length > 0 ? (
            <section>
              <SectionHeader title="玩家" icon={<UserCheck className="h-3.5 w-3.5" />} />
              <CandidateGrid
                candidates={activeCandidates}
                tone="default"
                nameWrap="wrap"
                disabled={choosing}
                onPick={pick}
                agentControlPrefix="song.submitter"
              />
            </section>
          ) : null}
          {candidates.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">暂无可选出题人</p>
          ) : teamed ? (
            <p className="text-center text-xs text-muted-foreground">指定后其队友本局一起观战</p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">等待房主指定本局出题人</p>
      )}
    </div>
  );
}
