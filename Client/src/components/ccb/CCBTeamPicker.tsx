import type { CCBPrivateState, CCBRoomSnapshot } from "@bakagame/shared";
import { TeamPicker } from "@/components/common/room/TeamPicker";
import { useCCBAction } from "@/hooks/UseCCBAction";

/** CCB 等待页的队伍面板：只给参与者，旁观者没有队伍。面板本身是公共的 `TeamPicker`。 */
export function CCBTeamPicker({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  const { run, pending } = useCCBAction();
  if (!me || me.membership !== "active") return null;
  return (
    <TeamPicker
      players={snapshot.players.filter((player) => player.membership === "active")}
      selfId={me.id}
      switching={pending.has("ccb.player.team")}
      hint="同队共享次数与猜测"
      onPick={(team) => void run("ccb.player.team", { team })}
    />
  );
}
