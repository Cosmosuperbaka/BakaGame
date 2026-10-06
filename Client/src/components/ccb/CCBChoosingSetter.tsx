import { Eye, UserCheck } from "lucide-react";
import type { CCBPlayer, CCBPrivateState, CCBRoomSnapshot } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { CandidateGrid, SectionHeader } from "@/components/common/CandidateGrid";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { useCCBAction } from "@/hooks/UseCCBAction";

/** 候选名字后带上队伍：指定后整队本局观战，房主选人时要看得见。 */
const candidate = (player: CCBPlayer) => ({ id: player.id, name: player.team !== null ? `${player.name}（${player.team} 队）` : player.name });

/**
 * 选出题人阶段（手动出题）。与猜歌的「指定出题人」、谁是卧底的「指定主持人」同一形态：
 * 房主在候选网格里点一下即指定，旁观者排在前面并标为推荐（出题不占猜题名额）；其他人看等待说明。
 * 候选名单只由服务端下发（`setterCandidateIds`），已排除指定后留不下猜题者的人选。
 */
export function CCBChoosingSetter({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const isHost = snapshot.hostPlayerId === privateState.playerId;
  const { run, pending, busy } = useCCBAction();
  const candidates = snapshot.players.filter((player) => privateState.setterCandidateIds.includes(player.id));
  const spectators = candidates.filter((player) => player.membership === "spectator").map(candidate);
  const players = candidates.filter((player) => player.membership === "active").map(candidate);
  const teamed = candidates.some((player) => player.team !== null);
  const pick = (playerId: string) => void run("ccb.game.chooseSetter", { playerId });
  const cancelling = pending.has("ccb.game.cancel");

  return (
    <div className="flex flex-col items-center gap-6">
      <PhaseHeader icon={UserCheck} title="指定出题人" />
      {isHost ? (
        <div className="w-full max-w-xl space-y-5">
          {spectators.length ? (
            <section>
              <SectionHeader title="旁观玩家" icon={<Eye className="h-3.5 w-3.5" />} hint="推荐：出题不占猜题名额" />
              <CandidateGrid candidates={spectators} tone="recommended" nameWrap="wrap" disabled={busy} onPick={pick} />
            </section>
          ) : null}
          <section>
            <SectionHeader title="玩家" icon={<UserCheck className="h-3.5 w-3.5" />} hint={teamed ? "指定后其队友本局一起观战" : undefined} />
            <CandidateGrid candidates={players} tone="default" nameWrap="wrap" disabled={busy} onPick={pick} />
          </section>
          <div className="flex justify-center">
            <Button variant="outline" disabled={busy} loading={cancelling} onClick={() => void run("ccb.game.cancel", {})}>返回等待</Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">等待房主指定本局出题人</p>
      )}
    </div>
  );
}
