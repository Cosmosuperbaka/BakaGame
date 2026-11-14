import { useCallback, useMemo, useRef } from "react";
import { useParams } from "react-router";
import { History, MessageSquare, Users } from "lucide-react";
import { normalizeRoomId } from "@/lib/Storage";
import { errorText } from "@/lib/ErrorMessage";
import { useMinWidth } from "@/hooks/UseMinWidth";
import { useRoomEntryFlow } from "@/hooks/UseRoomEntryFlow";
import { useUnreadCount } from "@/hooks/UseUnreadCount";
import { Seo } from "@/components/common/Seo";
import { useWhoIsFakerStore, withChannelNotices } from "@/stores/UseWhoIsFakerStore";
import { FakerPlayerList } from "@/components/whoisfaker/layout/FakerPlayerList";
import { buildSpeechHistory } from "@/components/whoisfaker/layout/FakerSpeechHistory";
import { FakerRoomHeaderCenter } from "@/components/whoisfaker/layout/FakerRoomHeaderCenter";
import { useFakerPlayerMarks } from "@/components/whoisfaker/layout/UseFakerPlayerMarks";
import { useFakerWordReveal } from "@/components/whoisfaker/layout/UseFakerWordReveal";
import { resolveAssignedWordText } from "@/components/whoisfaker/layout/FakerAssignedWordText";
import {
  FAKER_ROOM_ENTRY_POLICY,
  fakerRoomEntryAdapter,
} from "@/components/whoisfaker/layout/FakerRoomEntryAdapter";
import { useFakerHistoryPanel } from "@/components/whoisfaker/layout/UseFakerHistoryPanel";
import { FakerRoomPlayerAside } from "@/components/whoisfaker/layout/FakerRoomPlayerAside";
import { FakerAssignedWord } from "@/components/whoisfaker/layout/FakerAssignedWord";
import { FakerGameArea } from "@/components/whoisfaker/layout/FakerGameArea";
import { ChatPanel } from "@/components/common/ChatPanel";
import { ChatColumn, RoomShell } from "@/components/common/room/RoomShell";
import { RoomJoinGate } from "@/components/common/room/RoomJoinGate";
import { RoomUtilityActions } from "@/components/common/room/RoomUtilityActions";
import type { WhoIsFakerRole } from "@bakagame/shared";

export default function WhoIsFakerRoomPage() {
  const { roomId: routeRoomId } = useParams<{ roomId: string }>();
  // 路由房号可能是测试房的大小写变体，先归一为服务端规范房号；快照比对与入房命令
  // 都依赖它，否则小写直链拿到的快照房号与路由参数不等，页面会一直停在入房加载态。
  const roomId = normalizeRoomId(routeRoomId ?? "");
  const connected = useWhoIsFakerStore((s) => s.connected);
  const snapshot = useWhoIsFakerStore((s) => s.snapshot);
  const privateState = useWhoIsFakerStore((s) => s.privateState);
  const showToast = useWhoIsFakerStore((s) => s.showToast);
  const sendCommand = useWhoIsFakerStore((s) => s.sendCommand);
  const channelNotices = useWhoIsFakerStore((s) => s.channelNotices);
  const chatMessages = useMemo(
    () => withChannelNotices(snapshot?.chat ?? [], channelNotices),
    [snapshot?.chat, channelNotices]
  );

  const handleSendChatMessage = useCallback(
    async (text: string) => {
      try {
        await sendCommand("chat.send", { text });
      } catch (e) {
        showToast(errorText(e, "操作失败，请重试"), "error");
        // 继续抛出：聊天面板要靠这次 reject 把原文收回输入框，吞掉就等于让玩家白打一遍
        throw e;
      }
    },
    [sendCommand, showToast]
  );

  const stageRef = useRef<HTMLElement>(null);
  const {
    joining,
    needsName,
    needsPassword,
    nameDraft,
    setNameDraft,
    passwordDraft,
    passwordError,
    setPasswordDraft,
    confirmName,
    confirmPassword,
    leave: handleLeave,
  } = useRoomEntryFlow({
    roomId,
    exitPath: "/whoisfaker",
    adapter: fakerRoomEntryAdapter,
    policy: FAKER_ROOM_ENTRY_POLICY,
  });

  const roundId = snapshot?.status.roundId;
  const { playerMarks, onMarkChange: handleMarkChange } = useFakerPlayerMarks(roundId);

  const me = snapshot?.players.find((p) => p.id === privateState?.playerId);
  const isHost = me?.isHost ?? false;
  const isSpectator = me?.membership === "spectator";
  const phase = snapshot?.status.phase ?? "waiting";
  const day = snapshot?.status.day ?? 0;

  // 结算后身份公开，与出题人视角合并成一张身份表交给玩家栏。
  const revealedRoles = useMemo(() => {
    if (snapshot?.status.phase !== "gameOver") return undefined;
    const roles = new Map<string, WhoIsFakerRole>();
    for (const entry of snapshot?.summary?.revealedRoles ?? [])
      roles.set(entry.playerId, entry.role);
    return roles.size > 0 ? roles : undefined;
  }, [snapshot?.status.phase, snapshot?.summary?.revealedRoles]);

  const assignedWordText = resolveAssignedWordText(privateState, isSpectator);

  const { wordRevealed, dockSize, setDockSize, wordAnchorRef } = useFakerWordReveal({
    phase,
    day,
    assignedWordText,
  });

  // 发言历史列模型。展开侧栏时按行嵌入玩家列表，与玩家名同行。
  const history = useMemo(
    () =>
      buildSpeechHistory(snapshot?.descriptions ?? [], snapshot?.players ?? [], snapshot?.status),
    [snapshot?.descriptions, snapshot?.players, snapshot?.status]
  );

  // 身份分配与出词阶段还没有发言，历史入口从描述阶段起才提供。
  const historyAvailable = !["waiting", "assigningQuestioner", "wordSubmission"].includes(phase);
  const desktopSidebar = useMinWidth("md");
  const {
    historyOpen,
    historyDrawerOpen,
    historyRendered,
    openDrawer,
    gameInert,
    panelId,
    toggleRef,
    toggleHistory,
    onSidebarSettled,
    onDrawerChange,
  } = useFakerHistoryPanel({ roundId, historyAvailable, desktopSidebar });

  // 聊天在宽屏常驻、窄屏收进抽屉；抽屉关着时攒下的未读数挂在入口上。
  const chatDocked = useMinWidth("xl");
  const inRoom = Boolean(
    !joining && !needsName && !needsPassword && snapshot && snapshot.roomId === roomId
  );
  const unreadChat = useUnreadCount(inRoom ? chatMessages : undefined, {
    open: chatDocked || openDrawer === "chat",
    selfPlayerId: privateState?.playerId,
  });

  // 对局页内容全部来自服务端运行时状态，对搜索引擎无索引价值，
  // 统一标记 noindex；robots.txt 里也同步屏蔽了本路径。
  const seoNode = (
    <Seo
      description="这间 Who is Faker 正在等人，进房拿词，看谁演得更像。"
      path={`/whoisfaker/room/${roomId}`}
      title="谁是卧底房间 - BakaGame"
      indexable={false}
    />
  );

  // 加载中、等待加入，或等用户填名字
  if (!inRoom || !snapshot) {
    return (
      <RoomJoinGate
        roomId={roomId}
        needsName={needsName}
        needsPassword={needsPassword}
        nameDraft={nameDraft}
        onNameDraftChange={setNameDraft}
        onConfirmName={() => void confirmName()}
        passwordDraft={passwordDraft}
        onPasswordDraftChange={setPasswordDraft}
        onConfirmPassword={() => void confirmPassword()}
        onExit={handleLeave}
        pending={joining}
        passwordError={passwordError}
      >
        {seoNode}
      </RoomJoinGate>
    );
  }

  const roleConfig = snapshot.settings.roleConfig;
  const dayVisible = [
    "description",
    "voting",
    "tieBreak",
    "night",
    "blankGuess",
    "feedback",
    "gameOver",
  ].includes(phase);
  const privateInfoVisible = !["waiting", "assigningQuestioner", "wordSubmission"].includes(phase);
  const globalWords = privateInfoVisible ? privateState?.globalWords : undefined;

  const playerList = (withHistory: boolean, compact = false) => (
    <FakerPlayerList
      players={snapshot.players}
      hostPlayerId={snapshot.hostPlayerId}
      myPlayerId={privateState?.playerId}
      isHost={isHost}
      phase={snapshot.status.phase}
      allowSpectators={snapshot.allowSpectators}
      privateState={privateState}
      roleConfig={roleConfig}
      playerMarks={playerMarks}
      onMarkChange={handleMarkChange}
      revealedRoles={revealedRoles}
      {...(withHistory ? { history, compact } : {})}
    />
  );

  return (
    <>
      <RoomShell
        before={<>{seoNode}</>}
        onLeave={handleLeave}
        title={snapshot.name}
        roomId={snapshot.roomId}
        center={
          <FakerRoomHeaderCenter
            day={day}
            dayVisible={dayVisible}
            isQuestioner={privateState?.isQuestioner}
            isSpectator={isSpectator}
            globalWords={globalWords}
            privateInfoVisible={privateInfoVisible}
            assignedWordText={assignedWordText}
            dockSize={dockSize}
            wordAnchorRef={wordAnchorRef}
          />
        }
        actions={<RoomUtilityActions agentsBlocked={snapshot.settings.allowAgents !== true} />}
        connectionIssue={connected ? null : "断线中..."}
        player={
          <FakerRoomPlayerAside
            historyAvailable={historyAvailable}
            historyOpen={historyOpen}
            onToggleHistory={toggleHistory}
            panelId={panelId}
            toggleRef={toggleRef}
            onSettled={onSidebarSettled}
            list={playerList(historyRendered)}
          />
        }
        gameRef={stageRef}
        game={
          // contents 包一层只为挂 inert，不产生盒子，布局与直接放 FakerGameArea 相同
          <div className="contents" inert={gameInert}>
            <FakerGameArea wordRevealed={wordRevealed} />
          </div>
        }
        chat={
          <ChatColumn>
            <ChatPanel
              messages={chatMessages}
              players={snapshot?.players ?? []}
              myPlayerId={privateState?.playerId}
              onSendMessage={handleSendChatMessage}
              onRepeatMessage={handleSendChatMessage}
            />
          </ChatColumn>
        }
        openDrawer={openDrawer}
        onDrawerChange={onDrawerChange}
        drawers={[
          {
            key: "players",
            icon: Users,
            label: "玩家列表",
            side: "left",
            title: "玩家",
            closeFrom: "md",
            content: playerList(false),
          },
          ...(historyAvailable
            ? [
                {
                  key: "history",
                  icon: History,
                  label: historyDrawerOpen ? "收起发言历史" : "展开发言历史",
                  side: "left" as const,
                  title: "发言历史",
                  closeFrom: "md" as const,
                  // 发言历史需要横向空间：面板占满游戏区宽度，玩家列换成只有头像与名字的窄列
                  className: "w-full",
                  content: playerList(true, true),
                },
              ]
            : []),
          {
            key: "chat",
            icon: MessageSquare,
            label: "聊天",
            side: "right",
            title: "聊天",
            closeFrom: "xl",
            badge: unreadChat,
            content: (
              <ChatPanel
                messages={chatMessages}
                players={snapshot?.players ?? []}
                myPlayerId={privateState?.playerId}
                onSendMessage={handleSendChatMessage}
                onRepeatMessage={handleSendChatMessage}
              />
            ),
          },
        ]}
      />

      {/* 词语本体：始终是同一个元素，在居中揭示位与顶栏停靠位之间连续移动 */}
      {privateInfoVisible && assignedWordText ? (
        <FakerAssignedWord
          word={assignedWordText}
          revealed={wordRevealed}
          anchorRef={wordAnchorRef}
          stageRef={stageRef}
          onDockSizeChange={setDockSize}
        />
      ) : null}
    </>
  );
}
