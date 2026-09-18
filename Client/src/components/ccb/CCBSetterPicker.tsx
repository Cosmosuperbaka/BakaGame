import { useState } from "react";
import { PenLine } from "lucide-react";
import type { CCBPrivateState, CCBRoomSnapshot } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { useCCBAction } from "@/hooks/UseCCBAction";
import { CCBSelect } from "./CCBSelect";

export function CCBSetterPicker({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const { setterCandidateIds, playerId } = privateState;
  const [selection, setSetter] = useState(playerId);
  const setter = setterCandidateIds.includes(selection) ? selection : setterCandidateIds.includes(playerId) ? playerId : setterCandidateIds[0] ?? "";
  const { run, busy } = useCCBAction();
  return <div className="flex flex-wrap gap-2">
    <div className="min-w-40 flex-1"><CCBSelect label="指定出题人" value={setter} options={snapshot.players.filter((player) => setterCandidateIds.includes(player.id)).map((player) => ({ value: player.id, label: player.name }))} disabled={busy || !setterCandidateIds.length} onChange={setSetter} /></div>
    <Button variant="outline" disabled={busy || !setterCandidateIds.includes(setter)} onClick={() => void run("ccb.game.chooseSetter", { playerId: setter })}><PenLine />手动出题</Button>
  </div>;
}
