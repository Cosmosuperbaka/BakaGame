import { useEffect, useState } from "react";
import { Eye, MessageSquare, PenLine, Users } from "lucide-react";
import { ChatPanel } from "@/components/common/ChatPanel";
import { Seo } from "@/components/common/Seo";
import { ChatColumn, PlayerColumn, RoomShell } from "@/components/common/room/RoomShell";
import { RoomJoinGate } from "@/components/common/room/RoomJoinGate";
import { HeaderChip, HeaderCounter } from "@/components/common/room/RoomHeader";
import { CEEPlayerList } from "@/components/cee/CEEPlayerList";
import { CEEGameArea } from "@/components/cee/CEEGameArea";
import { useCEERoomLifecycle } from "@/hooks/UseCEERoomLifecycle";
import { useCEERoundHistory } from "@/hooks/UseCEERoundHistory";
import { ceeErrorMessage, useCEEStore } from "@/stores/UseCEEStore";
import { CEE_SOURCE_LABELS, ceeDisplayRound, ceePerspective, ceeRoomPath } from "@/lib/CEESession";

/** 归密码步处理的加入失败：缺密码、密码错误、错误次数过多。 */
const PASSWORD_CODES = new Set(["PASSWORD_REQUIRED", "PASSWORD_INCORRECT", "TOO_MANY_ATTEMPTS"]);

export default function CEERoomPage() {
  const lifecycle = useCEERoomLifecycle();
  const snapshot = useCEEStore((state) => state.snapshot);
  const privateState = useCEEStore((state) => state.privateState);
  // 整局回放的历史要在房间页累积：游戏区按局数重挂载，放进去会被换局清空。
  const replayRounds = useCEERoundHistory(snapshot);
  const [panel, setPanel] = useState<"players" | "chat" | null>(null);
  const showError = (error: unknown) => useCEEStore.getState().setNotice(ceeErrorMessage(error));
  const sendChat = async (text: string) => {
    await useCEEStore.getState().sendCommand("cee.chat.send", { text });
  };
  const ready = snapshot && privateState && snapshot.roomId === lifecycle.roomId;

  const seo = (
    <Seo
      path={lifecycle.roomId ? ceeRoomPath(lifecycle.roomId) : "/cee"}
      description="CEE 猜动漫角色对局中，快进房比拼二次元浓度与看番量！"
      indexable={false}
    />
  );

  // 尚未握手成功：与原版重连中同为断线语义，文案区分来源。
  const connectionIssue = !lifecycle.connected
    ? "重连中..."
    : ready && !snapshot.upstreamConnected
      ? "原版重连中..."
      : null;

  // 密码步的失败写在密码框下（RoomJoinGate 的 passwordError）；其余加入失败（房间已满、已关闭等）以提示条报出。
  const passwordFailure = PASSWORD_CODES.has(lifecycle.errorCode);
  useEffect(() => {
    if (lifecycle.error && !passwordFailure) useCEEStore.getState().setNotice(lifecycle.error);
  }, [lifecycle.error, passwordFailure]);

  if (!ready) {
    // 与另外两个游戏一致：直链进房自动用本地用户名（没存过就取访客名）加入，不再拦「设置用户名」弹窗。
    // 只剩私密房要输密码这一步——是否私密取大厅列表（私密房带锁进大厅）；列表里查不到时
    // （刚转私密）由服务端的缺密码 / 密码错误应答（错误码）把人带到这一步。
    const needsPassword = lifecycle.needsJoin && passwordFailure;
    return (
      <RoomJoinGate
        roomId={lifecycle.roomId ?? ""}
        needsName={false}
        needsPassword={needsPassword}
        nameDraft={lifecycle.name}
        onNameDraftChange={lifecycle.setName}
        onConfirmName={() => void lifecycle.join()}
        passwordDraft={lifecycle.password}
        onPasswordDraftChange={lifecycle.setPassword}
        onConfirmPassword={() => void lifecycle.join()}
        onExit={() => void lifecycle.leave()}
        nameMaxLength={32}
        pending={lifecycle.joining}
        // 刚到密码步时的「需要密码」不算失败，不标红；密码错误与尝试过多写在框下。
        passwordError={
          passwordFailure && lifecycle.errorCode !== "PASSWORD_REQUIRED"
            ? { message: lifecycle.error, invalid: lifecycle.errorCode === "PASSWORD_INCORRECT" }
            : null
        }
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
  const displayRound = ceeDisplayRound(snapshot.phase, snapshot.roundNumber);
  const perspective = ceePerspective(snapshot, privateState.playerId);

  return (
    <>
      {seo}
      <RoomShell
        onLeave={() => void lifecycle.leave()}
        title={snapshot.name || "猜猜呗"}
        roomId={lifecycle.roomId}
        // 与大厅卡片同口径：增强房是默认，只给原版房挂来源标签；放在房号旁，中栏留给局数与视角。
        roomTag={snapshot.source === "original" ? CEE_SOURCE_LABELS.original : undefined}
        center={
          <>
            {displayRound > 0 ? <HeaderCounter>第 {displayRound} 局</HeaderCounter> : null}
            {perspective === "setter" ? <HeaderChip icon={PenLine} label="出题人" /> : null}
            {perspective === "observer" ? <HeaderChip icon={Eye} label="旁观" muted /> : null}
          </>
        }
        connectionIssue={connectionIssue}
        player={
          <PlayerColumn>
            <CEEPlayerList snapshot={snapshot} privateState={privateState} />
          </PlayerColumn>
        }
        game={
          <CEEGameArea
            snapshot={snapshot}
            privateState={privateState}
            replayRounds={replayRounds}
          />
        }
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
            content: <CEEPlayerList snapshot={snapshot} privateState={privateState} />,
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
