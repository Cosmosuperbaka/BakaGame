import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Eye,
  History,
  Menu,
  MessageSquare,
  ShieldCheck,
} from "lucide-react";
import { motion } from "framer-motion";
import { getSavedUsername, normalizeRoomId, saveUsername } from "@/lib/Storage";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { Seo } from "@/components/common/Seo";
import { waitForConnection } from "@/lib/WhoIsFakerWs";
import { duration, iconTappable, spring, springSettleMs, wordRevealTiming } from "@/lib/Motion";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import {
  PLAYER_COLUMN_WIDTH,
  PlayerList,
  type PlayerListHistory,
  type PlayerMark,
  type PlayerMarks,
} from "@/components/whoisfaker/layout/PlayerList";
import { buildDescriptionColumns, pendingColumn } from "@/lib/DescriptionColumns";
import { AssignedWord } from "@/components/whoisfaker/layout/AssignedWord";
import { GameArea } from "@/components/whoisfaker/layout/GameArea";
import { ChatPanel } from "@/components/common/ChatPanel";
import { ChatColumn, RoomShell } from "@/components/common/room/RoomShell";
import { HeaderChip, HeaderCounter } from "@/components/common/room/RoomHeader";
import { RoomJoinGate } from "@/components/common/room/RoomJoinGate";
import { isValidRoomId, type WhoIsFakerRole, type PublicPlayerView } from "@/types";

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
  const alreadyInRoom = storeRoomId === roomId && snapshot?.roomId === roomId;

  const handleSendChatMessage = useCallback(
    async (text: string) => {
      try {
        await sendCommand("chat.send", { text });
      } catch (e) {
        addToast((e as { message: string }).message, "error");
      }
    },
    [sendCommand, addToast],
  );

  const [joining, setJoining] = useState(!alreadyInRoom);
  // 从分享链接直接进房、本地又没存过名字时，先问名字再进房，而不是踢回大厅。
  const [needsName, setNeedsName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [mobilePanel, setMobilePanel] = useState<"none" | "players" | "chat">("none");
  // 发言历史的展开状态记下展开时的局次，而不是一个布尔值：回到等待阶段、换局后自然收起，
  // 不会在切换按钮已隐藏时仍盖住游戏区，也不会在下一局一进描述阶段就自己弹开。
  const [historyRoundKey, setHistoryRoundKey] = useState<string | null>(null);
  const [historyDrawerRoundKey, setHistoryDrawerRoundKey] = useState<string | null>(null);
  // 延迟清除：宽度动画收回期间保持 history prop，避免 PlayerList 瞬间膨胀
  const [historyRendered, setHistoryRendered] = useState(false);
  // 身份预测推理笔记按局次 (roundId) 隔离，换局自动读取新局空映射，杜绝渲染期 setState 截断
  const [playerMarksByRound, setPlayerMarksByRound] = useState<Record<string, PlayerMarks>>({});
  // 词语揭示：true 时居中放大，false 时停靠顶栏；始终是同一个元素在移动
  const [wordRevealed, setWordRevealed] = useState(false);
  const [dockSize, setDockSize] = useState({ width: 0, height: 0 });
  const hasRevealedThisGameRef = useRef(false);
  const wordAnchorRef = useRef<HTMLSpanElement>(null);
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
      navigate("/whoisfaker", { replace: true });
    }
  }, [mountTime, roomClosedAt, navigate]);

  // 主动离开等其它原因导致的脱离房间。等用户填名字的这段时间同样没有 snapshot，
  // 但那是正常状态，不能当成房间已关闭。
  useEffect(() => {
    if (!joining && !needsName && !snapshot && !storeRoomId) navigate("/whoisfaker");
  }, [joining, needsName, snapshot, storeRoomId, navigate]);

  /** 用给定名字加入房间；房间不存在就以该名字开一间。 */
  const enterWithName = useCallback(
    async (name: string, signal: AbortSignal) => {
      if (!roomId || signal.aborted) return;
      setJoining(true);
      try {
        await joinRoom(roomId, name, undefined, signal);
        if (signal.aborted) return;
        setJoining(false);
      } catch (e) {
        if (signal.aborted) return;
        const err = e as { code?: string; message?: string };
        if (err.code === "ROOM_NOT_FOUND") {
          try {
            await createRoom({
              roomId,
              name: `${name}的房间`,
              visibility: "public",
              allowSpectators: true,
              userName: name,
            }, signal);
            if (signal.aborted) return;
            setJoining(false);
          } catch (createErr) {
            if (signal.aborted) return;
            addToast((createErr as { message: string }).message ?? "创建房间失败", "error");
            navigate("/whoisfaker");
          }
        } else {
          addToast(err.message ?? "加入房间失败", "error");
          navigate("/whoisfaker");
        }
      }
    },
    [roomId, joinRoom, createRoom, addToast, navigate],
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
      navigate("/whoisfaker", { replace: true });
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
        navigate("/whoisfaker");
        return;
      }
      if (signal.aborted) return;

      let restored: boolean;
      try {
        restored = await reconnectRoom(roomId, signal);
      } catch (error) {
        if (signal.aborted) return;
        addToast((error as { message?: string }).message ?? "恢复房间失败，请重试", "error");
        navigate("/whoisfaker");
        return;
      }
      if (signal.aborted) return;
      if (restored) { setJoining(false); return; }
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

  // 先换页、页面卸载后再退房：退房会清空快照，若先退再走，过渡拍下的旧页就成了加入中的转圈，
  // 清空还会触发上面「脱离房间」的 effect 再导航一次，打断进行中的过渡（Animation §2.4）。
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    if (!exiting) return;
    return () => void useWhoIsFakerStore.getState().leaveRoom();
  }, [exiting]);
  const handleLeave = useCallback(() => {
    entryRef.current?.abort();
    setExiting(true);
    navigate("/whoisfaker");
  }, [navigate]);

  const roundId = snapshot?.status.roundId;
  const playerMarks = useMemo<PlayerMarks>(
    () => (roundId ? playerMarksByRound[roundId] ?? {} : {}),
    [roundId, playerMarksByRound],
  );

  const handleMarkChange = useCallback(
    (playerId: string, mark: PlayerMark) => {
      if (!roundId) return;
      setPlayerMarksByRound((cur) => ({
        ...cur,
        [roundId]: {
          ...(cur[roundId] ?? {}),
          [playerId]: mark,
        },
      }));
    },
    [roundId],
  );

  const me = snapshot?.players.find((p) => p.id === privateState?.playerId);
  const isHost = me?.isHost ?? false;
  const isSpectator = me?.membership === "spectator";
  const phase = snapshot?.status.phase ?? "waiting";
  const day = snapshot?.status.day ?? 0;

  // 结算后身份公开，与出题人视角合并成一张身份表交给玩家栏。
  const revealedRoles = useMemo(() => {
    if (snapshot?.status.phase !== "gameOver") return undefined;
    const roles = new Map<string, WhoIsFakerRole>();
    for (const entry of snapshot?.summary?.revealedRoles ?? []) roles.set(entry.playerId, entry.role);
    return roles.size > 0 ? roles : undefined;
  }, [snapshot?.status.phase, snapshot?.summary?.revealedRoles]);

  const assignedWordText =
    !isSpectator && !privateState?.isQuestioner
      ? privateState?.word ??
        (privateState?.angelWordOptions
          ? `天使：${privateState.angelWordOptions[0]}/${privateState.angelWordOptions[1]}`
          : privateState?.blankHint ? `白板提示：${privateState.blankHint}` : undefined)
      : undefined;

  // 重置揭词标记——新局开始时（phase 回到 waiting）清除
  useEffect(() => {
    if (phase === "waiting") hasRevealedThisGameRef.current = false;
  }, [phase]);

  // 仅第一天描述阶段揭示词语，且每局只触发一次
  useEffect(() => {
    if (phase !== "description" || day !== 1 || !assignedWordText || hasRevealedThisGameRef.current)
      return;
    hasRevealedThisGameRef.current = true;
    const show = window.setTimeout(() => setWordRevealed(true), wordRevealTiming.showAfterMs);
    const dock = window.setTimeout(() => setWordRevealed(false), wordRevealTiming.dockAfterMs);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(dock);
      // 揭示途中离开该阶段时收回停靠态，避免下一局残留居中放大。
      setWordRevealed(false);
    };
  }, [phase, day, assignedWordText]);

  const speechStatus = snapshot?.status;

  // 发言历史列模型。展开侧栏时按行嵌入玩家列表，与玩家名同行。
  const history = useMemo<PlayerListHistory>(() => {
    const descriptions = snapshot?.descriptions ?? [];
    const { columns, byPlayer, playerOrder } = buildDescriptionColumns(descriptions, speechStatus);
    const present = new Set((snapshot?.players ?? []).map((player) => player.id));
    const departed = new Map<string, PublicPlayerView>();
    for (const record of descriptions) {
      if (present.has(record.playerId) || departed.has(record.playerId)) continue;
      departed.set(record.playerId, {
        id: record.playerId,
        name: record.playerName,
        score: 0,
        membership: "active",
        online: false,
        isReady: false,
        isBot: false,
        isHost: false,
        roundStatus: "waiting",
      });
    }
    // 进行中那一列里已提交但顺序未到的玩家：格子显示对勾而不是等待占位。
    const active = speechStatus ? pendingColumn(speechStatus) : null;

    return {
      columns,
      byPlayer,
      playerOrder,
      departedPlayers: [...departed.values()],
      submittedColumnKey: active?.key,
      submittedPlayerIds: new Set(speechStatus?.submittedSpeechPlayerIds ?? []),
    };
  }, [snapshot?.descriptions, snapshot?.players, speechStatus]);

  // 身份分配与出词阶段还没有发言，历史入口从描述阶段起才提供。
  const historyAvailable = !["waiting", "assigningQuestioner", "wordSubmission"].includes(phase);
  const roundKey = roundId ?? "";
  const historyOpen = historyAvailable && historyRoundKey === roundKey;
  const historyDrawerOpen = historyAvailable && historyDrawerRoundKey === roundKey;
  const openDrawer = historyDrawerOpen ? "history" : mobilePanel === "none" ? null : mobilePanel;

  // 展开：立即渲染；收起：等宽度动画（spring.settle）静止后再移除列，避免 PlayerList 瞬间膨胀
  useEffect(() => {
    const t = window.setTimeout(() => setHistoryRendered(historyOpen), historyOpen ? 0 : springSettleMs(spring.settle));
    return () => window.clearTimeout(t);
  }, [historyOpen]);

  // Escape 收起历史
  useEffect(() => {
    if (!historyOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setHistoryRoundKey(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [historyOpen]);

  // 对局页内容全部来自服务端运行时状态，对搜索引擎无索引价值，
  // 统一标记 noindex；robots.txt 里也同步屏蔽了本路径。
  const seoNode = (
    <Seo
      description="Who is Faker 谁是卧底房间已就绪，立即进房狂飙演技抓卧底！"
      path={`/whoisfaker/room/${roomId}`}
      indexable={false}
    />
  );

  // 加载中、等待加入，或等用户填名字
  if (joining || needsName || !snapshot || snapshot.roomId !== roomId) {
    return (
      <RoomJoinGate
        roomId={roomId}
        needsName={needsName}
        needsPassword={false}
        nameDraft={nameDraft}
        onNameDraftChange={setNameDraft}
        onConfirmName={() => void handleConfirmName()}
        passwordDraft=""
        onPasswordDraftChange={() => {}}
        onConfirmPassword={() => {}}
        onExit={handleLeave}
      >
        {seoNode}
      </RoomJoinGate>
    );
  }

  const roleConfig = snapshot.settings.roleConfig;
  const dayVisible = ["description", "voting", "tieBreak", "night", "blankGuess", "gameOver"].includes(phase);
  const privateInfoVisible = !["waiting", "assigningQuestioner", "wordSubmission"].includes(phase);
  const globalWords = privateInfoVisible ? privateState?.globalWords : undefined;

  const playerList = (withHistory: boolean, compact = false) => (
    <PlayerList
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
        before={seoNode}
        onLeave={handleLeave}
        title={snapshot.name}
        roomId={snapshot.roomId}
        center={<>
          {dayVisible && day > 0 ? <HeaderCounter>第 {day} 天</HeaderCounter> : null}
          {/* 中栏在手机上只有一百六十多像素：主持人徽章在 sm 以下只留图标，身份名交给读屏 */}
          {privateState?.isQuestioner ? (
            <>
              <HeaderChip icon={ShieldCheck} label="主持人" className="hidden sm:inline-flex" />
              <HeaderChip icon={ShieldCheck} label="" title="主持人" className="px-1.5 sm:hidden" />
              <span className="sr-only sm:hidden">主持人</span>
            </>
          ) : null}
          {!privateState?.isQuestioner && isSpectator ? <HeaderChip icon={Eye} label="旁观" muted /> : null}
          {/* 全局词语：只有已能看到全部身份的主持人与旁观者才会收到。放不下时截断，完整内容在 title 里 */}
          {globalWords ? (
            <HeaderChip
              icon={BookOpen}
              label={`${globalWords.civilianWord}/${globalWords.undercoverWord}`}
              title={`平民：${globalWords.civilianWord} | 卧底：${globalWords.undercoverWord}${globalWords.blankHint ? ` | 白板：${globalWords.blankHint}` : ""}`}
              truncate
            />
          ) : null}
          {globalWords?.blankHint ? (
            <HeaderChip
              icon={CircleHelp}
              label={globalWords.blankHint}
              title={`白板：${globalWords.blankHint}`}
              truncate
              // 白板提示是三枚里最次要的一枚：中栏到 xl 才放得下三枚完整徽章，更窄时只留在平民/卧底词的 title 里
              className="hidden xl:inline-flex"
            />
          ) : null}
          {/* 词语停靠位。真实词语由 AssignedWord 以固定定位覆盖在此，
              此处只占位撑开顶栏空间，避免停靠时挤动相邻元素；停靠后的词语对读屏隐藏，由这里读出。 */}
          {privateInfoVisible && assignedWordText ? (
            <span
              ref={wordAnchorRef}
              className="relative shrink-0"
              style={{ width: dockSize.width, height: dockSize.height }}
            >
              <span className="sr-only">你的词语 {assignedWordText}</span>
            </span>
          ) : null}
        </>}
        connectionIssue={connected ? null : "断线中..."}
        player={<>
          {/* 布局占位：使游戏区不因玩家栏展开而收缩 */}
          <div className="hidden shrink-0 md:block" style={{ width: PLAYER_COLUMN_WIDTH }} aria-hidden="true" />

          {/* 玩家栏（桌面）。展开时向右扩张覆盖游戏区 */}
          <motion.aside
            data-room-part="player"
            className="absolute inset-y-0 left-0 z-drawer hidden flex-col rounded-md border bg-panel md:flex"
            initial={false}
            animate={{
              width: historyOpen ? "100%" : PLAYER_COLUMN_WIDTH,
              boxShadow: historyOpen ? "var(--shadow-lg)" : "var(--shadow-2xs)",
            }}
            transition={{ width: spring.settle, boxShadow: { duration: duration.base } }}
          >
            {/* 展开/收起按钮：仅在游戏开始后显示。
                收起时骑在面板右边框上；展开后面板已占满整段，按钮内收，
                否则会落到 section 的裁切区外被切掉。 */}
            {historyAvailable ? (
              <motion.div
                className="absolute top-1/2 z-dropdown -translate-y-1/2"
                initial={false}
                animate={{ right: historyOpen ? "0.5rem" : "-1rem" }}
                transition={spring.settle}
              >
                <motion.button
                  type="button"
                  aria-label={historyOpen ? "收起发言历史" : "展开发言历史"}
                  aria-expanded={historyOpen}
                  onClick={() => setHistoryRoundKey(historyOpen ? null : roundKey)}
                  {...iconTappable}
                  className="flex h-8 w-8 items-center justify-center floating-surface text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  {/* 箭头指向面板将要移动的方向：收起时向右展开，展开时向左收回 */}
                  {historyOpen ? (
                    <ChevronLeft className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </motion.button>
              </motion.div>
            ) : null}

            <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-md">
              {playerList(historyRendered)}
            </div>
          </motion.aside>
        </>}
        gameRef={stageRef}
        game={<GameArea wordRevealed={wordRevealed} />}
        chat={<ChatColumn>
          <ChatPanel
            messages={snapshot?.chat ?? []}
            players={snapshot?.players ?? []}
            myPlayerId={privateState?.playerId}
            onSendMessage={handleSendChatMessage}
          />
        </ChatColumn>}
        openDrawer={openDrawer}
        onDrawerChange={(key) => {
          setHistoryDrawerRoundKey(key === "history" ? roundKey : null);
          setMobilePanel(key === "players" || key === "chat" ? key : "none");
        }}
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
          ...(historyAvailable ? [{
            key: "history",
            icon: History,
            label: historyDrawerOpen ? "收起发言历史" : "展开发言历史",
            side: "left" as const,
            title: "发言历史",
            closeFrom: "md" as const,
            // 发言历史需要横向空间：面板占满游戏区宽度，玩家列换成只有头像与名字的窄列
            className: "w-full",
            content: playerList(true, true),
          }] : []),
          {
            key: "chat",
            icon: MessageSquare,
            label: "聊天",
            side: "right",
            title: "聊天",
            closeFrom: "xl",
            content: (
              <ChatPanel
                messages={snapshot?.chat ?? []}
                players={snapshot?.players ?? []}
                myPlayerId={privateState?.playerId}
                onSendMessage={handleSendChatMessage}
              />
            ),
          },
        ]}
      />

      {/* 词语本体：始终是同一个元素，在居中揭示位与顶栏停靠位之间连续移动 */}
      {privateInfoVisible && assignedWordText ? (
        <AssignedWord
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
