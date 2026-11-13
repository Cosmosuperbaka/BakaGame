import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { History, Menu, MessageSquare } from "lucide-react";
import { getSavedUsername, normalizeRoomId, saveUsername } from "@/lib/Storage";
import { useMinWidth } from "@/hooks/UseMinWidth";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { Seo } from "@/components/common/Seo";
import { waitForConnection } from "@/lib/WhoIsFakerWs";
import { useWhoIsFakerStore, withChannelNotices } from "@/stores/UseWhoIsFakerStore";
import { FakerPlayerList } from "@/components/whoisfaker/layout/FakerPlayerList";
import { buildSpeechHistory } from "@/components/whoisfaker/layout/FakerSpeechHistory";
import { FakerRoomHeaderCenter } from "@/components/whoisfaker/layout/FakerRoomHeaderCenter";
import { usePlayerMarks } from "@/components/whoisfaker/layout/UsePlayerMarks";
import { useFakerWordReveal } from "@/components/whoisfaker/layout/UseFakerWordReveal";
import { resolveAssignedWordText } from "@/components/whoisfaker/layout/FakerAssignedWordText";
import { useFakerHistoryPanel } from "@/components/whoisfaker/layout/UseFakerHistoryPanel";
import { FakerRoomPlayerAside } from "@/components/whoisfaker/layout/FakerRoomPlayerAside";
import { FakerAssignedWord } from "@/components/whoisfaker/layout/FakerAssignedWord";
import { FakerGameArea } from "@/components/whoisfaker/layout/FakerGameArea";
import { ChatPanel } from "@/components/common/ChatPanel";
import { ChatColumn, RoomShell } from "@/components/common/room/RoomShell";
import { RoomJoinGate } from "@/components/common/room/RoomJoinGate";
import { RoomUtilityActions } from "@/components/common/room/RoomUtilityActions";
import { isValidRoomId } from "@bakagame/shared/values";
import type { WhoIsFakerRole } from "@bakagame/shared";

export default function WhoIsFakerRoomPage() {
  const { roomId: routeRoomId } = useParams<{ roomId: string }>();
  // 路由房号可能是测试房的大小写变体，先归一为服务端规范房号；快照比对与入房命令
  // 都依赖它，否则小写直链拿到的快照房号与路由参数不等，页面会一直停在入房加载态。
  const roomId = normalizeRoomId(routeRoomId ?? "");
  const navigate = usePageNavigate();
  const connected = useWhoIsFakerStore((s) => s.connected);
  const storeRoomId = useWhoIsFakerStore((s) => s.roomId);
  const snapshot = useWhoIsFakerStore((s) => s.snapshot);
  const privateState = useWhoIsFakerStore((s) => s.privateState);
  const createRoom = useWhoIsFakerStore((s) => s.createRoom);
  const joinRoom = useWhoIsFakerStore((s) => s.joinRoom);
  const reconnectRoom = useWhoIsFakerStore((s) => s.reconnectRoom);
  const addToast = useWhoIsFakerStore((s) => s.addToast);
  const sendCommand = useWhoIsFakerStore((s) => s.sendCommand);
  const roomClosedAt = useWhoIsFakerStore((s) => s.roomClosedAt);
  const channelNotices = useWhoIsFakerStore((s) => s.channelNotices);
  const chatMessages = useMemo(
    () => withChannelNotices(snapshot?.chat ?? [], channelNotices),
    [snapshot?.chat, channelNotices]
  );
  const alreadyInRoom = storeRoomId === roomId && snapshot?.roomId === roomId;

  const handleSendChatMessage = useCallback(
    async (text: string) => {
      try {
        await sendCommand("chat.send", { text });
      } catch (e) {
        addToast((e as { message: string }).message, "error");
        // 继续抛出：聊天面板要靠这次 reject 把原文收回输入框，吞掉就等于让玩家白打一遍
        throw e;
      }
    },
    [sendCommand, addToast]
  );

  const [joining, setJoining] = useState(!alreadyInRoom);
  // 从分享链接直接进房、本地又没存过名字时，先问名字再进房，而不是踢回大厅。
  const [needsName, setNeedsName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  // 私密房：不带密码的加入被拒后先问密码；名字沿用已确认的那个
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [pendingJoinName, setPendingJoinName] = useState("");
  const stageRef = useRef<HTMLElement>(null);
  const [mountTime] = useState(() => Date.now());
  const entryRef = useRef<AbortController | null>(null);

  // 挂载与卸载时清理残留的 roomClosedAt
  useEffect(() => {
    useWhoIsFakerStore.getState().clearRoomClosed();
    return () => {
      useWhoIsFakerStore.getState().clearRoomClosed();
    };
  }, []);

  // 房间被服务端关闭或席位被替换：这是一个明确的事件，无论当前是否正在加入
  // 都必须立刻退回大厅，否则加入流程中被关闭会一直停在加载态。
  useEffect(() => {
    if (roomClosedAt && roomClosedAt >= mountTime) {
      entryRef.current?.abort();
      useWhoIsFakerStore.getState().clearRoomClosed();
      void navigate("/whoisfaker", { replace: true });
    }
  }, [mountTime, roomClosedAt, navigate]);

  // 主动离开等其它原因导致的脱离房间。等用户填名字或密码的这段时间同样没有 snapshot，
  // 但那是正常状态，不能当成房间已关闭。
  useEffect(() => {
    if (!joining && !needsName && !needsPassword && !snapshot && !storeRoomId)
      void navigate("/whoisfaker");
  }, [joining, needsName, needsPassword, snapshot, storeRoomId, navigate]);

  /** 用给定名字加入房间；房间不存在就以该名字开一间。 */
  const enterWithName = useCallback(
    async (name: string, signal: AbortSignal, password?: string) => {
      if (!roomId || signal.aborted) return;
      setJoining(true);
      try {
        await joinRoom(roomId, name, password, signal);
        if (signal.aborted) return;
        setNeedsPassword(false);
        setJoining(false);
      } catch (e) {
        if (signal.aborted) return;
        const err = e as { code?: string; message?: string };
        if (err.code === "PASSWORD_INCORRECT" || err.code === "PASSWORD_REQUIRED") {
          // 密码缺失与密码错误都回到密码框重输，而不是踢回大厅
          setPendingJoinName(name);
          setPasswordDraft("");
          setNeedsPassword(true);
          setJoining(false);
        } else if (err.code === "ROOM_NOT_FOUND") {
          try {
            await createRoom(
              {
                roomId,
                name: `${name}的房间`,
                visibility: "public",
                allowSpectators: true,
                userName: name,
              },
              signal
            );
            if (signal.aborted) return;
            setJoining(false);
          } catch (createErr) {
            if (signal.aborted) return;
            addToast((createErr as { message: string }).message ?? "创建房间失败", "error");
            void navigate("/whoisfaker");
          }
        } else {
          addToast(err.message ?? "加入房间失败", "error");
          void navigate("/whoisfaker");
        }
      }
    },
    [roomId, joinRoom, createRoom, addToast, navigate]
  );

  // 入房事务归属路由房间，而非 snapshot；取消后的 ACK 释放由 Store 负责。
  useEffect(() => {
    const entry = new AbortController();
    entryRef.current = entry;
    const { signal } = entry;
    const cleanup = () => {
      entry.abort();
      if (entryRef.current === entry) entryRef.current = null;
    };
    if (!roomId || alreadyInRoom) return cleanup;

    if (!isValidRoomId(roomId)) {
      addToast("房间号无效，请检查链接", "error");
      void navigate("/whoisfaker", { replace: true });
      return cleanup;
    }

    useWhoIsFakerStore.getState().clearRoomClosed();
    const tryEnter = async () => {
      setJoining(true);
      try {
        await waitForConnection(8000);
      } catch {
        if (signal.aborted) return;
        addToast("连接服务器超时，请刷新重试", "error");
        void navigate("/whoisfaker");
        return;
      }
      if (signal.aborted) return;

      let restored: boolean;
      try {
        restored = await reconnectRoom(roomId, signal);
      } catch (error) {
        if (signal.aborted) return;
        addToast((error as { message?: string }).message ?? "恢复房间失败，请重试", "error");
        void navigate("/whoisfaker");
        return;
      }
      if (signal.aborted) return;
      if (restored) {
        setJoining(false);
        return;
      }
      const closedAt = useWhoIsFakerStore.getState().roomClosedAt;
      if (closedAt !== null && closedAt >= mountTime) return;

      const name = getSavedUsername();
      if (!name) {
        setJoining(false);
        setNameDraft("");
        setNeedsName(true);
        return;
      }
      await enterWithName(name, signal);
      if (signal.aborted) return;
    };

    void tryEnter();
    return cleanup;
  }, [roomId, mountTime]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleConfirmName = useCallback(async () => {
    const name = nameDraft.trim();
    if (!name) {
      addToast("请输入用户名", "error");
      return;
    }
    saveUsername(name);
    setNeedsName(false);
    const signal = entryRef.current?.signal;
    if (!signal || signal.aborted) return;
    await enterWithName(name, signal);
    if (signal.aborted) return;
  }, [nameDraft, addToast, enterWithName]);

  const handleConfirmPassword = useCallback(async () => {
    if (!pendingJoinName || !passwordDraft.trim()) return;
    setNeedsPassword(false);
    const signal = entryRef.current?.signal;
    if (!signal || signal.aborted) return;
    await enterWithName(pendingJoinName, signal, passwordDraft);
  }, [pendingJoinName, passwordDraft, enterWithName]);

  // 先换页、页面卸载后再退房：退房会清空快照，若先退再走，过渡拍下的旧页就成了加入中的转圈，
  // 清空还会触发上面「脱离房间」的 effect 再导航一次，打断进行中的过渡（DesignGuide §8）。
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    if (!exiting) return;
    return () => void useWhoIsFakerStore.getState().leaveRoom();
  }, [exiting]);
  const handleLeave = useCallback(() => {
    entryRef.current?.abort();
    setExiting(true);
    void navigate("/whoisfaker");
  }, [navigate]);

  const roundId = snapshot?.status.roundId;
  const { playerMarks, onMarkChange: handleMarkChange } = usePlayerMarks(roundId);

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
  if (joining || needsName || needsPassword || !snapshot || snapshot.roomId !== roomId) {
    return (
      <RoomJoinGate
        roomId={roomId}
        needsName={needsName}
        needsPassword={needsPassword}
        nameDraft={nameDraft}
        onNameDraftChange={setNameDraft}
        onConfirmName={() => void handleConfirmName()}
        passwordDraft={passwordDraft}
        onPasswordDraftChange={setPasswordDraft}
        onConfirmPassword={() => void handleConfirmPassword()}
        onExit={handleLeave}
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
        actions={<RoomUtilityActions game="faker" />}
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
            icon: Menu,
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
