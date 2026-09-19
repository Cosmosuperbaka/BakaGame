import { useState } from "react";
import { Settings, Play, Check, Copy } from "lucide-react";
import type { CCBPrivateState, CCBRoomSnapshot } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { Label } from "@/components/ui/Label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/Dialog";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { useOriginTracker } from "@/hooks/UseOriginTracker";
import { useCCBAction } from "@/hooks/UseCCBAction";
import { ccbErrorMessage, useCCBStore } from "@/stores/UseCCBStore";
import { CCBSettingsForm } from "./CCBSettingsForm";
import { CCBSetterPicker } from "./CCBSetterPicker";

export function CCBWaiting({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const isHost = snapshot.hostPlayerId === privateState.playerId;
  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [name, setName] = useState(snapshot.name);
  const [allowSpectators, setAllowSpectators] = useState(snapshot.allowSpectators);
  const [visibility, setVisibility] = useState(snapshot.visibility);
  const origin = useOriginTracker();
  const { run, busy } = useCCBAction();
  const copy = async () => {
    try { await navigator.clipboard.writeText(location.href); useCCBStore.getState().setNotice("房间链接已复制", "success"); }
    catch (error) { useCCBStore.getState().setNotice(ccbErrorMessage(error)); }
  };
  return <div className="mx-auto w-full max-w-2xl space-y-6 p-5 md:p-8">
    <PhaseHeader icon={Play} title="等待玩家准备" />
    <div className="flex items-center justify-center gap-3"><span className="font-mono text-lg">#{snapshot.roomId}</span><Button variant="outline" size="sm" onClick={() => void copy()}><Copy />复制链接</Button></div>
    <p className="text-center text-sm text-muted-foreground">{snapshot.settings.syncMode ? "同步" : "普通"} · {snapshot.settings.nonstopMode ? "血战" : "首位猜中结束"} · {snapshot.settings.maxAttempts} 次机会 · {snapshot.settings.timeLimit ? `每次 ${snapshot.settings.timeLimit} 秒` : "不限行动时间"}</p>
    <div className="flex flex-wrap justify-center gap-2">
      {me?.membership === "active" ? <Button variant={me.ready ? "secondary" : "default"} disabled={busy} onClick={() => void run("ccb.player.ready", { ready: !me.ready })}><Check />{me.ready ? "取消准备" : "准备"}</Button> : null}
      <Button variant="outline" onClick={(event) => { origin.capture(event); setSettingsOpen(true); }}><Settings />{isHost ? "题目设置" : "查看设置"}</Button>
      {isHost ? <Button disabled={busy || !privateState.canStart} loading={busy} onClick={() => void run("ccb.game.start", {})}><Play />随机出题</Button> : null}
    </div>
    {isHost ? <div className="space-y-4 border-t pt-5">
      <CCBSetterPicker snapshot={snapshot} privateState={privateState} />
      <details><summary className="cursor-pointer text-sm text-muted-foreground">房间设置</summary><div className="mt-3 space-y-3"><Label className="block space-y-2">房间名称<Input value={name} maxLength={snapshot.source === "original" ? 30 : 32} onChange={(event) => setName(event.target.value)} /></Label><Label className="flex items-center justify-between">公开显示在大厅<Switch checked={visibility === "public"} onCheckedChange={(value) => setVisibility(value ? "public" : "private")} /></Label>{snapshot.source === "native" ? <Label className="flex items-center justify-between">允许旁观<Switch checked={allowSpectators} onCheckedChange={setAllowSpectators} /></Label> : null}<Button variant="outline" disabled={busy || !name.trim()} onClick={() => void run("ccb.room.update", { name: name.trim(), visibility, allowSpectators })}>保存房间设置</Button></div></details>
    </div> : <p className="text-center text-xs text-muted-foreground">准备完成后由房主开始</p>}
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen} origin={origin.origin}><DialogContent className="max-h-[85dvh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>题目设置</DialogTitle><DialogDescription>设置在开局后固定，仅对下一局生效。</DialogDescription></DialogHeader><CCBSettingsForm key={settingsOpen ? "open" : "closed"} settings={snapshot.settings} editable={isHost && snapshot.phase === "waiting"} onSaved={() => setSettingsOpen(false)} /></DialogContent></Dialog>
  </div>;
}
