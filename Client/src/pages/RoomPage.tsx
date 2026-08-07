import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Settings,
  History,
  Menu,
  MessageSquare,
  ShieldCheck,
  Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { getSavedUsername, isTestRoomId } from "@/lib/cookie";
import { waitForConnection } from "@/lib/ws";
import {
  backdrop,
  duration,
  ease,
  iconTappable,
  spinner,
  spring,
  useOriginTracker,
} from "@/lib/motion";
import { useGameStore } from "@/stores/useGameStore";
import {
  PlayerList,
  type PlayerListHistory,
  type PlayerMark,
  type PlayerMarks,
} from "@/components/room/PlayerList";
import { buildDescriptionColumns } from "@/lib/descriptionColumns";
import { AssignedWord } from "@/components/room/AssignedWord";
import { GameArea } from "@/components/room/GameArea";
import { ChatPanel } from "@/components/room/ChatPanel";
import { RoomSettings } from "@/components/room/RoomSettings";
import type { PlayerRole, PublicPlayerView } from "@/types";

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const offlineTestRoom = roomId ? isTestRoomId(roomId) : false;
  const navigate = useNavigate();
  const connected = useGameStore((s) => s.connected);
  const storeRoomId = useGameStore((s) => s.roomId);
  const snapshot = useGameStore((s) => s.snapshot);
  const privateState = useGameStore((s) => s.privateState);
  const createRoom = useGameStore((s) => s.createRoom);
  const joinRoom = useGameStore((s) => s.joinRoom);
  const reconnectRoom = useGameStore((s) => s.reconnectRoom);
  const leaveRoom = useGameStore((s) => s.leaveRoom);
  const addToast = useGameStore((s) => s.addToast);
  const alreadyInRoom = storeRoomId === roomId && snapshot !== null;

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [joining, setJoining] = useState(!alreadyInRoom);
  const [mobilePanel, setMobilePanel] = useState<"none" | "players" | "chat" | "history">("none");
  const [historyOpen, setHistoryOpen] = useState(false);
  // 延迟清除：宽度动画收回期间保持 history prop，避免 PlayerList 瞬间膨胀
  const [historyRendered, setHistoryRendered] = useState(false);
  const [playerMarks, setPlayerMarks] = useState<PlayerMarks>({});
  // 词语揭示：true 时居中放大，false 时停靠顶栏；始终是同一个元素在移动
  const [wordRevealed, setWordRevealed] = useState(false);
  const [dockSize, setDockSize] = useState({ width: 0, height: 0 });
  const hasRevealedThisGameRef = useRef(false);
  const wordAnchorRef = useRef<HTMLSpanElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const settingsOrigin = useOriginTracker();

  // 展开：立即渲染；收起：等动画结束后再移除列，避免 PlayerList 瞬间膨胀
  useEffect(() => {
    const t = window.setTimeout(() => setHistoryRendered(historyOpen), historyOpen ? 0 : 380);
    return () => window.clearTimeout(t);
  }, [historyOpen]);

  // Escape 收起历史
  useEffect(() => {
    if (!historyOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setHistoryOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [historyOpen]);

  // 房间关闭后自动返回大厅
  useEffect(() => {
    if (!joining && !snapshot && !storeRoomId) navigate("/whoisfaker");
  }, [joining, snapshot, storeRoomId, navigate]);

  // 进入房间：等待连接、尝试重连/加入/创建
  useEffect(() => {
    if (!roomId) return;

    if (offlineTestRoom) {
      let cancelled = false;
      useGameStore.getState().initTestRoomOffline();
      queueMicrotask(() => { if (!cancelled) setJoining(false); });
      return () => { cancelled = true; };
    }

    if (alreadyInRoom) return;

    let cancelled = false;
    const tryEnter = async () => {
      setJoining(true);
      try {
        await waitForConnection(8000);
      } catch {
        if (cancelled) return;
        addToast("连接服务器超时，请刷新重试", "error");
        navigate("/whoisfaker");
        return;
      }
      if (cancelled) return;

      const ok = await reconnectRoom(roomId);
      if (ok) { if (!cancelled) setJoining(false); return; }
      if (cancelled) return;

      const name = getSavedUsername();
      if (!name) {
        addToast("请先在主页设置用户名", "error");
        navigate("/whoisfaker");
        return;
      }

      try {
        await joinRoom(roomId, name);
        if (!cancelled) setJoining(false);
      } catch (e) {
        if (cancelled) return;
        const err = e as { code?: string; message?: string };
        if (err.code === "ROOM_NOT_FOUND") {
          try {
            await createRoom({ roomId, name: `${name}的房间`, visibility: "public", allowSpectators: true, userName: name });
            if (!cancelled) setJoining(false);
          } catch (createErr) {
            if (cancelled) return;
            addToast((createErr as { message: string }).message ?? "创建房间失败", "error");
            navigate("/whoisfaker");
          }
        } else {
          addToast(err.message ?? "加入房间失败", "error");
          navigate("/whoisfaker");
        }
      }
    };

    tryEnter();
    return () => { cancelled = true; };
  }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLeave = useCallback(async () => {
    await leaveRoom();
    navigate("/whoisfaker");
  }, [leaveRoom, navigate]);

  const handleMarkChange = useCallback((playerId: string, mark: PlayerMark) => {
    setPlayerMarks((cur) => ({ ...cur, [playerId]: mark }));
  }, []);

  const me = snapshot?.players.find((p) => p.id === privateState?.playerId);
  const isHost = me?.isHost ?? false;
  const isSpectator = me?.membership === "spectator";
  const phase = snapshot?.status.phase ?? "waiting";
  const day = snapshot?.status.day ?? 0;
  const roleConfig = snapshot?.settings.roleConfig ?? { undercoverCount: 1, hasAngel: false, hasBlank: false };

  // 游戏开始前不显示发言历史按钮
  const showHistoryToggle = !["waiting", "assigningQuestioner", "wordSubmission"].includes(phase);

  // 结算后身份公开，与出题人视角合并成一张身份表交给玩家栏。
  const revealedRoles = useMemo(() => {
    const roles = new Map<string, PlayerRole>();
    for (const entry of snapshot?.summary?.revealedRoles ?? []) roles.set(entry.playerId, entry.role);
    return roles.size > 0 ? roles : undefined;
  }, [snapshot?.summary?.revealedRoles]);

  const assignedWordText =
    !isSpectator && !privateState?.isQuestioner
      ? privateState?.word ??
        (privateState?.angelWordOptions
          ? `${privateState.angelWordOptions[0]} / ${privateState.angelWordOptions[1]}`
          : privateState?.blankHint ? `提示：${privateState.blankHint}` : undefined)
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
    const show = window.setTimeout(() => setWordRevealed(true), 60);
    const dock = window.setTimeout(() => setWordRevealed(false), duration.hold * 1000 + 400);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(dock);
      // 揭示途中离开该阶段时收回停靠态，避免下一局残留居中放大。
      setWordRevealed(false);
    };
  }, [phase, day, assignedWordText]);

  // 发言历史列模型。展开侧栏时按行嵌入玩家列表，与玩家名同行。
  const history = useMemo<PlayerListHistory>(() => {
    const descriptions = snapshot?.descriptions ?? [];
    const { columns, byPlayer } = buildDescriptionColumns(descriptions, snapshot?.status);
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
    return { columns, byPlayer, departedPlayers: [...departed.values()] };
  }, [snapshot?.descriptions, snapshot?.players, snapshot?.status]);

  const dayVisible = ["description", "voting", "tieBreak", "night", "blankGuess", "gameOver"].includes(phase);
  const privateInfoVisible = !["waiting", "assigningQuestioner", "wordSubmission"].includes(phase);

  // 加载中或等待加入
  if (joining || !snapshot) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: duration.base, ease: ease.out }}
          className="flex flex-col items-center gap-3"
        >
          <motion.div
            className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent"
            {...spinner}
          />
          <span className="text-sm text-muted-foreground">正在加入房间...</span>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* ── 顶栏 ── */}
      <header className="grid h-14 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 bg-background px-2 md:grid-cols-3 md:gap-2 md:px-4 lg:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleLeave}
            className="shrink-0"
            aria-label="离开房间"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <span className="hidden truncate text-base font-semibold md:block">{snapshot.name}</span>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">#{snapshot.roomId}</span>
        </div>

        <div className="flex min-w-0 items-center justify-center gap-1 overflow-hidden md:gap-2">
          {dayVisible && day > 0 && (
            <span className="shrink-0 text-xs font-semibold text-muted-foreground sm:text-sm">
              第 {day} 天
            </span>
          )}
          {privateState?.isQuestioner && (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs font-semibold text-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />主持人视角
            </span>
          )}
          {isSpectator && (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
              <Eye className="h-3.5 w-3.5" />旁观视角
            </span>
          )}
          {/* 词语停靠位。真实词语由 AssignedWord 以固定定位覆盖在此，
              此处只占位撑开顶栏空间，避免停靠时挤动相邻元素。 */}
          {privateInfoVisible && assignedWordText ? (
            <span
              ref={wordAnchorRef}
              aria-label={`你的词语 ${assignedWordText}`}
              className="shrink-0"
              style={{ width: dockSize.width, height: dockSize.height }}
            />
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-0 md:gap-1">
          {!connected && (
            <span className="mr-1 hidden shrink-0 animate-pulse text-xs text-destructive sm:inline">断线中...</span>
          )}
          <div className="flex gap-1 md:hidden">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              aria-label="玩家列表"
              aria-expanded={mobilePanel === "players"}
              onClick={() => setMobilePanel(mobilePanel === "players" ? "none" : "players")}
            >
              <Menu className="h-5 w-5" />
            </Button>
            {/* 移动端发言历史：仅游戏中显示 */}
            {showHistoryToggle && (
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                aria-label={mobilePanel === "history" ? "收起发言历史" : "展开发言历史"}
                aria-expanded={mobilePanel === "history"}
                onClick={() => setMobilePanel(mobilePanel === "history" ? "none" : "history")}
              >
                <History className="h-5 w-5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              aria-label="聊天"
              aria-expanded={mobilePanel === "chat"}
              onClick={() => setMobilePanel(mobilePanel === "chat" ? "none" : "chat")}
            >
              <MessageSquare className="h-5 w-5" />
            </Button>
          </div>
          {isHost && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="房间设置"
              onClick={(event) => {
                settingsOrigin.capture(event);
                setSettingsOpen(true);
              }}
              className="h-9 w-9 shrink-0 md:h-10 md:w-10"
            >
              <Settings className="h-5 w-5" />
            </Button>
          )}
        </div>
      </header>

      {/* ── 主体三栏 ── */}
      <div className="relative flex flex-1 gap-2 overflow-hidden px-2 pb-2 md:gap-3 md:px-3 md:pb-3">

        {/* 玩家栏 + 游戏区（共享同一个 section 以便 aside 绝对定位覆盖游戏区） */}
        <section className="relative flex min-w-0 flex-1 gap-2 overflow-hidden rounded-xl md:gap-3">

          {/* 布局占位：使游戏区不因 aside 展开而收缩 */}
          <div className="hidden w-64 shrink-0 md:block" aria-hidden="true" />

          {/* 玩家栏（桌面）。展开时向右扩张覆盖游戏区 */}
          <motion.aside
            className="absolute inset-y-0 left-0 z-30 hidden flex-col rounded-xl border bg-panel md:flex"
            initial={false}
            animate={{
              width: historyOpen ? "100%" : "16rem",
              boxShadow: historyOpen ? "var(--shadow-xl)" : "var(--shadow-2xs)",
            }}
            transition={{ width: spring.settle, boxShadow: { duration: duration.base } }}
          >
            {/* 展开/收起按钮：仅在游戏开始后显示。
                收起时骑在面板右边框上；展开后面板已占满整段，按钮内收，
                否则会落到 section 的裁切区外被切掉。 */}
            {showHistoryToggle && (
              <motion.div
                className="absolute top-1/2 z-40 -translate-y-1/2"
                initial={false}
                animate={{ right: historyOpen ? "0.5rem" : "-1rem" }}
                transition={spring.settle}
              >
                <motion.button
                  type="button"
                  aria-label={historyOpen ? "收起发言历史" : "展开发言历史"}
                  aria-expanded={historyOpen}
                  onClick={() => setHistoryOpen(!historyOpen)}
                  {...iconTappable}
                  className="flex h-8 w-8 items-center justify-center rounded-md border bg-secondary text-secondary-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {/* 箭头指向面板将要移动的方向：收起时向右展开，展开时向左收回 */}
                  {historyOpen ? (
                    <ChevronLeft className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </motion.button>
              </motion.div>
            )}

            <div className="min-h-0 flex-1 overflow-auto rounded-xl">
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
                history={historyRendered ? history : undefined}
              />
            </div>
          </motion.aside>

          {/* 游戏区。`isolate` 使揭词背板、天亮提示等区内浮层只在游戏区内部
              分层，不会越过玩家面板去盖住骑缝的展开按钮。 */}
          <main
            ref={stageRef}
            className="isolate flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-panel"
          >
            <GameArea wordRevealed={wordRevealed} />
          </main>
        </section>

        {/* 右栏：聊天（桌面） */}
        <aside className="hidden w-80 shrink-0 flex-col overflow-hidden rounded-xl border bg-panel lg:flex">
          <ChatPanel />
        </aside>

        {/* 移动端玩家列表覆盖层 */}
        <AnimatePresence>
          {mobilePanel === "players" && (
            <motion.aside
              initial={{ x: "-100%" }}
              animate={{ x: 0, transition: spring.swift }}
              exit={{ x: "-100%", transition: { duration: duration.quick, ease: ease.inOut } }}
              className="absolute inset-y-0 left-0 z-30 flex w-72 flex-col overflow-y-auto border-r bg-panel shadow-xl md:hidden"
            >
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
              />
            </motion.aside>
          )}
        </AnimatePresence>

        {/* 移动端发言历史覆盖层 */}
        <AnimatePresence>
          {mobilePanel === "history" && (
            <motion.aside
              initial={{ x: "-100%" }}
              animate={{ x: 0, transition: spring.swift }}
              exit={{ x: "-100%", transition: { duration: duration.quick, ease: ease.inOut } }}
              className="absolute inset-y-0 left-0 z-30 flex w-full max-w-sm flex-col overflow-auto bg-panel shadow-xl md:hidden"
            >
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
                history={history}
              />
            </motion.aside>
          )}
        </AnimatePresence>

        {/* 移动端聊天覆盖层 */}
        <AnimatePresence>
          {mobilePanel === "chat" && (
            <motion.aside
              initial={{ x: "100%" }}
              animate={{ x: 0, transition: spring.swift }}
              exit={{ x: "100%", transition: { duration: duration.quick, ease: ease.inOut } }}
              className="absolute inset-y-0 right-0 z-30 flex w-80 flex-col overflow-hidden border-l bg-panel shadow-xl lg:hidden"
            >
              <ChatPanel />
            </motion.aside>
          )}
        </AnimatePresence>

        {/* 移动端遮罩 */}
        <AnimatePresence>
          {mobilePanel !== "none" && (
            <motion.div
              variants={backdrop}
              initial="initial"
              animate="animate"
              exit="exit"
              className="absolute inset-0 z-20 bg-foreground/20 md:hidden"
              onClick={() => setMobilePanel("none")}
            />
          )}
        </AnimatePresence>
      </div>

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

      <RoomSettings
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        origin={settingsOrigin.origin}
      />
    </div>
  );
}
