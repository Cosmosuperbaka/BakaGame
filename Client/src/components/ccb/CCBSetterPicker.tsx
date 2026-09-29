import { useState } from "react";
import { PenLine } from "lucide-react";
import type { CCBPrivateState, CCBRoomSnapshot } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { SettingSelect } from "@/components/common/room/SettingFields";
import { useCCBAction } from "@/hooks/UseCCBAction";

export function CCBSetterPicker({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const { setterCandidateIds, playerId } = privateState;
  const [selection, setSetter] = useState(playerId);
  const setter = setterCandidateIds.includes(selection) ? selection : setterCandidateIds.includes(playerId) ? playerId : setterCandidateIds[0] ?? "";
  const candidates = snapshot.players.filter((player) => setterCandidateIds.includes(player.id)).map((player) => ({ value: player.id, label: player.name }));
  const { run, busy } = useCCBAction();
  // 按钮与下拉框底边对齐，不随上方标签一起拉高；没有候选（如原版重连中）时框内说明原因，不留空白。
  return <div className="flex flex-wrap items-end gap-2">
    <div className="min-w-40 flex-1">
      <SettingSelect label="指定出题人" value={setter} options={candidates.length ? candidates : [{ value: "", label: "暂无可选出题人" }]} disabled={busy || !candidates.length} onChange={setSetter} />
    </div>
    <Button variant="outline" disabled={busy || !setterCandidateIds.includes(setter)} onClick={() => void run("ccb.game.chooseSetter", { playerId: setter })}><PenLine />手动出题</Button>
  </div>;
}
