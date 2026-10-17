import type { CEEPrivateState, CEERoomSnapshot } from "@bakagame/shared";
import { TeamPicker } from "@/components/common/room/TeamPicker";
import { useCEEAction } from "@/hooks/UseCEEAction";

/** CEE 等待页的队伍面板：只给参与者，旁观者没有队伍。面板本身是公共的 `TeamPicker`。 */
export function CEETeamPicker({ snapshot, privateState }: { snapshot: CEERoomSnapshot; privateState: CEEPrivateState }) {
  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  const { run, pending } = useCEEAction();
  if (!me || me.membership !== "active") return null;
  return (
    <TeamPicker
      players={snapshot.players.filter((player) => player.membership === "active")}
      selfId={me.id}
      switching={pending.has("cee.player.team")}
      hint="同队共享次数与猜测"
      onPick={(team) => void run("cee.player.team", { team })}
    />
  );
}
