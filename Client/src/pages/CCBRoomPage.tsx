import { useState } from "react";
import { MessageSquare, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { ChatPanel } from "@/components/common/ChatPanel";
import { Seo } from "@/components/common/Seo";
import { ChatColumn, PlayerColumn, RoomShell } from "@/components/common/room/RoomShell";
import { HeaderChip, HeaderCounter } from "@/components/common/room/RoomHeader";
import { CCBPlayerList } from "@/components/ccb/CCBPlayerList";
import { CCBGameArea } from "@/components/ccb/CCBGameArea";
import { useCCBRoomLifecycle } from "@/hooks/UseCCBRoomLifecycle";
import { ccbErrorMessage, useCCBStore } from "@/stores/UseCCBStore";
import { CCB_SOURCE_LABELS, ccbDisplayRound, ccbRoomPath } from "@/lib/CCBSession";

export default function CCBRoomPage() {
  const lifecycle = useCCBRoomLifecycle();
  const snapshot = useCCBStore((state) => state.snapshot);
  const privateState = useCCBStore((state) => state.privateState);
  const [panel, setPanel] = useState<"players" | "chat" | null>(null);
  const showError = (error: unknown) => useCCBStore.getState().setNotice(ccbErrorMessage(error));
  const sendChat = async (text: string) => { await useCCBStore.getState().sendCommand("ccb.chat.send", { text }); };
  const ready = snapshot && privateState && snapshot.roomId === lifecycle.roomId;

  const seo = (
    <Seo path={lifecycle.roomId ? ccbRoomPath(lifecycle.roomId) : "/ccb"} description="CCB 多人猜角色房间" indexable={false} />
  );

  // 尚未握手成功：与原版重连中同为断线语义，文案区分来源。
  const connectionIssue = !lifecycle.connected ? "重连中..." : ready && !snapshot.upstreamConnected ? "原版重连中..." : null;

  const joinDialog = (
    <Dialog open={lifecycle.needsJoin} onOpenChange={(open) => { if (!open) void lifecycle.leave(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>加入房间 #{lifecycle.roomId}</DialogTitle>
          <DialogDescription>填写用户名后加入房间。</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void lifecycle.join(); }}>
          <Input aria-label="用户名" placeholder="用户名" maxLength={32} value={lifecycle.name} onChange={(event) => lifecycle.setName(event.target.value)} />
          <Input aria-label="房间密码" type="password" placeholder="私密房间密码（如有）" value={lifecycle.password} onChange={(event) => lifecycle.setPassword(event.target.value)} />
          {lifecycle.error ? <p role="alert" className="text-sm text-destructive">{lifecycle.error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => void lifecycle.leave()}>返回大厅</Button>
            <Button type="submit" loading={lifecycle.joining} disabled={!lifecycle.connected || !lifecycle.name.trim()}>加入房间</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  if (!ready) {
    return (
      <>
        {seo}
        <RoomShell
          onLeave={() => void lifecycle.leave()}
          title={snapshot?.name ?? "猜猜呗"}
          roomId={lifecycle.roomId}
          connectionIssue={connectionIssue}
          game={<div role="status" className="m-auto p-6 text-sm text-muted-foreground">{lifecycle.joining ? "正在连接房间…" : "请加入房间"}</div>}
        />
        {joinDialog}
      </>
    );
  }

  const chatPanel = (
    <ChatPanel
      messages={snapshot.chat}
      players={snapshot.players}
      myPlayerId={privateState.playerId}
      onSendMessage={sendChat}
      onError={showError}
      maxLength={500}
    />
  );
  const chatTitle = snapshot.source === "original" ? "增强版聊天" : "聊天";
  // 原版房的聊天来自增强版，与上游房间不同步，需要一句来源说明。
  const chatNote = snapshot.source === "original" ? (
    <p className="border-b px-3 py-2 text-xs text-muted-foreground">增强版聊天</p>
  ) : null;
  const displayRound = ccbDisplayRound(snapshot.phase, snapshot.roundNumber);

  return (
    <>
      {seo}
      <RoomShell
        onLeave={() => void lifecycle.leave()}
        title={snapshot.name || "猜猜呗"}
        roomId={lifecycle.roomId}
        center={<>
          <HeaderChip icon={Users} label={CCB_SOURCE_LABELS[snapshot.source]} muted />
          {displayRound > 0 ? <HeaderCounter>第 {displayRound} 局</HeaderCounter> : null}
        </>}
        connectionIssue={connectionIssue}
        player={<PlayerColumn><CCBPlayerList snapshot={snapshot} privateState={privateState} /></PlayerColumn>}
        game={<CCBGameArea snapshot={snapshot} privateState={privateState} />}
        chat={<ChatColumn>{chatNote}{chatPanel}</ChatColumn>}
        openDrawer={panel}
        onDrawerChange={(key) => setPanel(key as "players" | "chat" | null)}
        drawers={[
          {
            key: "players",
            icon: Users,
            label: "玩家列表",
            side: "left",
            title: "玩家",
            closeFrom: "md",
            content: <CCBPlayerList snapshot={snapshot} privateState={privateState} />,
          },
          {
            key: "chat",
            icon: MessageSquare,
            label: "聊天",
            side: "right",
            title: chatTitle,
            closeFrom: "lg",
            content: chatPanel,
          },
        ]}
      />
    </>
  );
}
