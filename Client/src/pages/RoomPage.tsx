import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
  ArrowLeft,
  Settings,
  Menu,
  MessageSquare,
  ShieldCheck,
  Eye,
  ChevronRight,
  ChevronLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { getSavedUsername, isTestRoomId } from "@/lib/cookie";
import { waitForConnection } from "@/lib/ws";
import { spring } from "@/lib/motion";
import { useGameStore } from "@/stores/useGameStore";
import {
  PlayerList,
  type PlayerMark,
  type PlayerMarks,
} from "@/components/room/PlayerList";
import { GameArea } from "@/components/room/GameArea";
import { ChatPanel } from "@/components/room/ChatPanel";
import { RoomSettings } from "@/components/room/RoomSettings";
import { DescriptionTable, type DescriptionTableContext } from "@/components/game/DescriptionHistory";
import { cn } from "@/lib/utils";
import type { PlayerRole } from "@/types";

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
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);
  const alreadyInRoom = storeRoomId === roomId && snapshot !== null;

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [joining, setJoining] = useState(!alreadyInRoom);
  const [mobilePanel, setMobilePanel] = useState<"none" | "players" | "chat">("none");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [playerMarks, setPlayerMarks] = useState<PlayerMarks>({});
  // 词语揭示状态：有值时居中显示，清空后顶栏小片接手（layoutId 共享元素）
  const [revealedWord, setRevealedWord] = useState<string | undefined>(undefined);
  const hasRevealedThisGameRef = useRef(false);

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

  const handleKick = useCallback(async (playerId: string) => {
    try { await sendCommand("room.kick", { playerId }); }
    catch (e) { addToast((e as { message?: string }).message ?? "踢出玩家失败", "error"); }
  }, [addToast, sendCommand]);

  const handleTransferHost = useCallback(async (playerId: string) => {
    try { await sendCommand("room.transferHost", { playerId }); }
    catch (e) { addToast((e as { message?: string }).message ?? "转移房主失败", "error"); }
  }, [addToast, sendCommand]);

  const me = snapshot?.players.find((p) => p.id === privateState?.playerId);
  const isHost = me?.isHost ?? false;
  const isSpectator = me?.membership === "spectator";
  const phase = snapshot?.status.phase ?? "waiting";
  const day = snapshot?.status.day ?? 0;
  const roleConfig = snapshot?.settings.roleConfig ?? { undercoverCount: 1, hasAngel: false, hasBlank: false };

  const canMarkPlayers =
    me?.membership === "active" &&
    !privateState?.isQuestioner &&
    !["waiting", "assigningQuestioner", "wordSubmission", "gameOver"].includes(phase);

  const availableMarks = useMemo<PlayerMark[]>(
    () => [
      "unknown", "civilian", "undercover",
      ...(roleConfig.hasBlank ? (["blank"] as PlayerMark[]) : []),
      ...(roleConfig.hasAngel ? (["angel"] as PlayerMark[]) : []),
    ],
    [roleConfig.hasAngel, roleConfig.hasBlank],
  );

  const actualRoleByPlayerId = useMemo(() => {
    const roles = new Map<string, PlayerRole>();
    for (const entry of privateState?.questionerView ?? []) roles.set(entry.playerId, entry.role);
    for (const entry of snapshot?.summary?.revealedRoles ?? []) roles.set(entry.playerId, entry.role);
    return roles;
  }, [privateState?.questionerView, snapshot?.summary?.revealedRoles]);

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
    if (phase !== "description" || day !== 1 || !assignedWordText || hasRevealedThisGameRef.current) return;
    hasRevealedThisGameRef.current = true;
    const t1 = window.setTimeout(() => setRevealedWord(assignedWordText), 60);
    const t2 = window.setTimeout(() => setRevealedWord(undefined), 3300);
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
  }, [phase, day, assignedWordText]);

  const playerRowContext: DescriptionTableContext = {
    myPlayerId: privateState?.playerId,
    isHostViewer: isHost,
    waitingPhase: phase === "waiting",
    hideSpectatorStatus: false,
    canMark: Boolean(canMarkPlayers),
    availableMarks,
    onMarkChange: handleMarkChange,
    onKick: handleKick,
    onTransferHost: handleTransferHost,
    actualRoleByPlayerId,
    playerMarks,
  };

  const dayVisible = ["description", "voting", "tieBreak", "night", "blankGuess", "gameOver"].includes(phase);
  const privateInfoVisible = !["waiting", "assigningQuestioner", "wordSubmission"].includes(phase);

  // 加载中或等待加入
  if (joining || !snapshot) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-3">
          <motion.div
            className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent"
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
          />
          <span className="text-sm text-muted-foreground">正在加入房间...</span>
        </motion.div>
      </div>
    );
  }

  return (
    <LayoutGroup id="assigned-word-reveal">
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* ── 顶栏 ── */}
      <header className="grid h-14 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 bg-background px-2 md:grid-cols-3 md:gap-2 md:px-4 lg:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon" onClick={handleLeave} className="shrink-0">
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
              <ShieldCheck className="h-3.5 w-3.5" />出题人视角
            </span>
          )}
          {isSpectator && (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
              <Eye className="h-3.5 w-3.5" />旁观视角
            </span>
          )}
          {/* 揭词结束后词语以 layoutId 共享元素飞入此处 */}
          {privateInfoVisible && assignedWordText && !revealedWord ? (
            <motion.span
              layoutId="assigned-word"
              transition={{ layout: spring.drift }}
              className="max-w-32 shrink truncate rounded-md bg-primary/10 px-2.5 py-1 text-xs font-bold text-primary sm:max-w-none sm:text-sm"
            >
              {assignedWordText}
            </motion.span>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-0 md:gap-1">
          {!connected && (
            <span className="mr-1 hidden shrink-0 animate-pulse text-xs text-destructive sm:inline">断线中...</span>
          )}
          <div className="flex gap-1 md:hidden">
            <Button variant="ghost" size="icon" className="h-9 w-9"
              onClick={() => setMobilePanel(mobilePanel === "players" ? "none" : "players")}>
              <Menu className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-9 w-9"
              onClick={() => setMobilePanel(mobilePanel === "chat" ? "none" : "chat")}>
              <MessageSquare className="h-5 w-5" />
            </Button>
          </div>
          {isHost && (
            <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)}
              className="h-9 w-9 shrink-0 md:h-10 md:w-10">
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

          {/* 玩家栏（桌面），展开时宽度动画覆盖游戏区 */}
          <aside
            className={cn(
              "absolute inset-y-0 left-0 z-30 hidden flex-col overflow-hidden rounded-xl border bg-panel",
              "md:flex",
              "transition-[width] duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
              historyOpen ? "w-[calc(100%-0rem)] shadow-xl" : "w-64",
            )}
          >
            {/* 展开/收起切换按钮 */}
            <button
              type="button"
              aria-label={historyOpen ? "收起发言历史" : "展开发言历史"}
              onClick={() => setHistoryOpen(!historyOpen)}
              className="absolute right-2 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-muted text-muted-foreground shadow-sm transition-colors hover:bg-accent"
            >
              {historyOpen ? <ChevronLeft className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>

            <div className="flex h-full overflow-hidden">
              {/* 第一列：玩家栏，固定宽度，始终可见 */}
              <div className={cn("flex w-64 shrink-0 flex-col overflow-hidden", historyOpen && "border-r")}>
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
                />
              </div>

              {/* 后续列：发言历史，展开时淡入 */}
              <div className={cn(
                "min-w-0 flex-1 overflow-hidden transition-opacity duration-200",
                historyOpen ? "opacity-100 delay-[80ms]" : "opacity-0 pointer-events-none",
              )}>
                <DescriptionTable
                  descriptions={snapshot.descriptions}
                  players={snapshot.players}
                  playerRowContext={playerRowContext}
                />
              </div>
            </div>
          </aside>

          {/* 游戏区 */}
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-panel">
            <GameArea revealedWord={revealedWord} />
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
              initial={{ x: -288 }}
              animate={{ x: 0 }}
              exit={{ x: -288 }}
              transition={spring.swift}
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
              />
            </motion.aside>
          )}
        </AnimatePresence>

        {/* 移动端聊天覆盖层 */}
        <AnimatePresence>
          {mobilePanel === "chat" && (
            <motion.aside
              initial={{ x: 320 }}
              animate={{ x: 0 }}
              exit={{ x: 320 }}
              transition={spring.swift}
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
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-20 bg-black/20 md:hidden"
              onClick={() => setMobilePanel("none")}
            />
          )}
        </AnimatePresence>
      </div>

      <RoomSettings open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
    </LayoutGroup>
  );
}
