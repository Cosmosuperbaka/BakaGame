import { useEffect, useState } from "react";
import { Eye, MessageSquare, PenLine, Users } from "lucide-react";
import { ChatPanel } from "@/components/common/ChatPanel";
import { Seo } from "@/components/common/Seo";
import { ChatColumn, PlayerColumn, RoomShell } from "@/components/common/room/RoomShell";
import { RoomJoinGate } from "@/components/common/room/RoomJoinGate";
import { HeaderChip, HeaderCounter } from "@/components/common/room/RoomHeader";
import { CCBPlayerList } from "@/components/ccb/CCBPlayerList";
import { CCBGameArea } from "@/components/ccb/CCBGameArea";
import { useCCBRoomLifecycle } from "@/hooks/UseCCBRoomLifecycle";
import { ccbErrorMessage, useCCBStore } from "@/stores/UseCCBStore";
import { CCB_SOURCE_LABELS, ccbDisplayRound, ccbPerspective, ccbRoomPath } from "@/lib/CCBSession";

export default function CCBRoomPage() {
  const lifecycle = useCCBRoomLifecycle();
  const snapshot = useCCBStore((state) => state.snapshot);
  const privateState = useCCBStore((state) => state.privateState);
  const rooms = useCCBStore((state) => state.rooms);
  const [panel, setPanel] = useState<"players" | "chat" | null>(null);
  const [named, setNamed] = useState(false);
  const showError = (error: unknown) => useCCBStore.getState().setNotice(ccbErrorMessage(error));
  const sendChat = async (text: string) => { await useCCBStore.getState().sendCommand("ccb.chat.send", { text }); };
  const ready = snapshot && privateState && snapshot.roomId === lifecycle.roomId;

  const seo = (
    <Seo path={lifecycle.roomId ? ccbRoomPath(lifecycle.roomId) : "/ccb"} description="CCB 猜动漫角色对局中，快进房比拼二次元浓度与看番量！" indexable={false} />
  );

  // 尚未握手成功：与原版重连中同为断线语义，文案区分来源。
  const connectionIssue = !lifecycle.connected ? "重连中..." : ready && !snapshot.upstreamConnected ? "原版重连中..." : null;

  // 加入失败（房间已满、密码错误等）以提示条报出：公共进房门没有错误位，与另外两个游戏同口径。
  useEffect(() => {
    if (lifecycle.error) useCCBStore.getState().setNotice(lifecycle.error);
  }, [lifecycle.error]);

  if (!ready) {
    // 进房分两步：先填名字，私密房再输密码。是否私密取大厅列表（私密房带锁进大厅）；
    // 列表里查不到时（刚转私密）由服务端的缺密码 / 密码错误应答把人带到第二步。
    const locked = rooms.some((room) => room.roomId === lifecycle.roomId && room.hasPassword);
    const awaiting = lifecycle.needsJoin && !lifecycle.joining;
    const needsPassword = awaiting && named && (locked || /密码/.test(lifecycle.error));
    return (
      <RoomJoinGate
        roomId={lifecycle.roomId ?? ""}
        needsName={awaiting && !needsPassword}
        needsPassword={needsPassword}
        nameDraft={lifecycle.name}
        onNameDraftChange={lifecycle.setName}
        onConfirmName={() => {
          setNamed(true);
          if (!locked) void lifecycle.join();
        }}
        passwordDraft={lifecycle.password}
        onPasswordDraftChange={lifecycle.setPassword}
        onConfirmPassword={() => void lifecycle.join()}
        onExit={() => void lifecycle.leave()}
        nameMaxLength={32}
      >
        {seo}
      </RoomJoinGate>
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
      // 原版房的聊天只在增强版玩家之间互通，上游的原版玩家看不到，要在频道里交代清楚。
      notice={snapshot.source === "original" ? "聊天仅增强版玩家可见" : undefined}
    />
  );
  const displayRound = ccbDisplayRound(snapshot.phase, snapshot.roundNumber);
  const perspective = ccbPerspective(snapshot, privateState.playerId);

  return (
    <>
      {seo}
      <RoomShell
        onLeave={() => void lifecycle.leave()}
        title={snapshot.name || "猜猜呗"}
        roomId={lifecycle.roomId}
        // 与大厅卡片同口径：增强房是默认，只给原版房挂来源标签；放在房号旁，中栏留给局数与视角。
        roomTag={snapshot.source === "original" ? CCB_SOURCE_LABELS.original : undefined}
        center={<>
          {displayRound > 0 ? <HeaderCounter>第 {displayRound} 局</HeaderCounter> : null}
          {perspective === "setter" ? <HeaderChip icon={PenLine} label="出题人" /> : null}
          {perspective === "observer" ? <HeaderChip icon={Eye} label="旁观" muted /> : null}
        </>}
        connectionIssue={connectionIssue}
        player={<PlayerColumn><CCBPlayerList snapshot={snapshot} privateState={privateState} /></PlayerColumn>}
        game={<CCBGameArea snapshot={snapshot} privateState={privateState} />}
        chat={<ChatColumn>{chatPanel}</ChatColumn>}
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
            title: "聊天",
            closeFrom: "xl",
            content: chatPanel,
          },
        ]}
      />
    </>
  );
}
