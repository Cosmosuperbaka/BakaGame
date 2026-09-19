import { useState } from "react";
import { ArrowLeft, MessageSquare, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { ChatPanel } from "@/components/common/ChatPanel";
import { PLAYER_COLUMN_WIDTH } from "@/components/common/PlayerStatusPill";
import { Seo } from "@/components/common/Seo";
import { CCBPlayerList } from "@/components/ccb/CCBPlayerList";
import { CCBGameArea } from "@/components/ccb/CCBGameArea";
import { CCBRoomPanel } from "@/components/ccb/CCBRoomPanel";
import { useCCBRoomLifecycle } from "@/hooks/UseCCBRoomLifecycle";
import { ccbErrorMessage, useCCBStore } from "@/stores/UseCCBStore";
import { CCB_SOURCE_LABELS, ccbRoomPath } from "@/lib/CCBSession";

export default function CCBRoomPage() {
  const lifecycle = useCCBRoomLifecycle();
  const snapshot = useCCBStore((state) => state.snapshot);
  const privateState = useCCBStore((state) => state.privateState);
  const [panel, setPanel] = useState<"players" | "chat" | null>(null);
  const showError = (error: unknown) => useCCBStore.getState().setNotice(ccbErrorMessage(error));
  const sendChat = async (text: string) => { await useCCBStore.getState().sendCommand("ccb.chat.send", { text }); };
  const ready = snapshot && privateState && snapshot.source === lifecycle.source && snapshot.roomId === lifecycle.roomId;
  return <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
    <Seo path={lifecycle.source && lifecycle.roomId ? ccbRoomPath(lifecycle.source, lifecycle.roomId) : "/ccb"} description="CCB 多人猜角色房间" indexable={false} />
    <header className="grid h-14 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2 md:grid-cols-3 md:px-4">
      <div className="flex min-w-0 items-center gap-2"><Button variant="ghost" size="icon" aria-label="离开房间" onClick={() => void lifecycle.leave()}><ArrowLeft /></Button><span className="hidden truncate text-sm font-semibold sm:inline">{snapshot?.name || "CCB"}</span><span className="hidden font-mono text-xs text-muted-foreground md:inline">#{lifecycle.roomId}</span></div>
      <div className="flex min-w-0 items-center justify-center gap-2 text-xs"><span className="shrink-0 rounded-md bg-muted px-2 py-1">{lifecycle.source ? CCB_SOURCE_LABELS[lifecycle.source] : "CCB"}</span>{snapshot && snapshot.roundNumber > 0 ? <span className="whitespace-nowrap">第 {snapshot.roundNumber} 局</span> : null}</div>
      <div className="flex items-center justify-end gap-1">{!lifecycle.connected ? <span className="text-xs text-destructive">重连中</span> : ready && !snapshot.upstreamConnected ? <span className="text-xs text-destructive">原版重连中</span> : null}<Button variant="ghost" size="icon" className="md:hidden" aria-label="玩家列表" aria-expanded={panel === "players"} onClick={() => setPanel(panel === "players" ? null : "players")}><Users /></Button><Button variant="ghost" size="icon" className="lg:hidden" aria-label="聊天" aria-expanded={panel === "chat"} onClick={() => setPanel(panel === "chat" ? null : "chat")}><MessageSquare /></Button></div>
    </header>
    {ready ? <div className="relative flex min-h-0 flex-1 gap-2 overflow-hidden px-2 pb-2 md:gap-3 md:px-3 md:pb-3">
      <aside className="hidden min-h-0 shrink-0 overflow-hidden rounded-md border bg-panel md:block" style={{ width: PLAYER_COLUMN_WIDTH }}><CCBPlayerList snapshot={snapshot} privateState={privateState} /></aside>
      <main className="isolate min-h-0 min-w-0 flex-1 overflow-y-auto rounded-md border bg-panel"><CCBGameArea snapshot={snapshot} privateState={privateState} /></main>
      <aside className="hidden min-h-0 w-80 shrink-0 flex-col overflow-hidden rounded-md border bg-panel lg:flex">{snapshot.source === "original" ? <p className="border-b px-3 py-2 text-xs text-muted-foreground">增强版聊天</p> : null}<ChatPanel messages={snapshot.chat} players={snapshot.players} myPlayerId={privateState.playerId} onSendMessage={sendChat} onError={showError} maxLength={500} /></aside>
      <CCBRoomPanel panel={panel} title={panel === "players" ? "玩家" : snapshot.source === "original" ? "增强版聊天" : "聊天"} onClose={() => setPanel(null)}>{panel === "players" ? <CCBPlayerList snapshot={snapshot} privateState={privateState} /> : <ChatPanel messages={snapshot.chat} players={snapshot.players} myPlayerId={privateState.playerId} onSendMessage={sendChat} onError={showError} maxLength={500} />}</CCBRoomPanel>
    </div> : <div role="status" className="m-auto p-6 text-sm text-muted-foreground">{lifecycle.joining ? "正在连接房间…" : "请加入房间"}</div>}
    <Dialog open={lifecycle.needsJoin} onOpenChange={(open) => { if (!open) void lifecycle.leave(); }}><DialogContent><DialogHeader><DialogTitle>加入房间 #{lifecycle.roomId}</DialogTitle><DialogDescription>填写用户名后加入{lifecycle.source ? CCB_SOURCE_LABELS[lifecycle.source] : "房间"}。</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void lifecycle.join(); }}><Input aria-label="用户名" placeholder="用户名" maxLength={32} value={lifecycle.name} onChange={(event) => lifecycle.setName(event.target.value)} />{lifecycle.source === "native" ? <Input aria-label="房间密码" type="password" placeholder="私密房间密码（如有）" value={lifecycle.password} onChange={(event) => lifecycle.setPassword(event.target.value)} /> : null}{lifecycle.error ? <p role="alert" className="text-sm text-destructive">{lifecycle.error}</p> : null}<DialogFooter><Button type="button" variant="outline" onClick={() => void lifecycle.leave()}>返回大厅</Button><Button type="submit" loading={lifecycle.joining} disabled={!lifecycle.connected || !lifecycle.name.trim()}>加入房间</Button></DialogFooter></form></DialogContent></Dialog>
  </div>;
}
