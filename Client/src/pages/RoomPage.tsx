import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
  ArrowLeft,
  Settings,
  Menu,
  MessageSquare,
  History,
  ShieldCheck,
  Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { getSavedUsername, isTestRoomId } from "@/lib/cookie";
import { waitForConnection } from "@/lib/ws";
import { useGameStore } from "@/stores/useGameStore";
import {
  PlayerList,
  type PlayerMark,
  type PlayerMarks,
} from "@/components/room/PlayerList";
import { GameArea } from "@/components/room/GameArea";
import { ChatPanel } from "@/components/room/ChatPanel";
import { RoomSettings } from "@/components/room/RoomSettings";
import { DescriptionHistoryOverlay } from "@/components/game/DescriptionHistory";
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
  // 移动端侧栏
  const [mobilePanel, setMobilePanel] = useState<"none" | "players" | "chat">("none");
  const [descriptionHistoryOpen, setDescriptionHistoryOpen] = useState(false);
  const [playerMarks, setPlayerMarks] = useState<PlayerMarks>({});
  const [wordRevealActive, setWordRevealActive] = useState(false);
  const [revealedWord, setRevealedWord] = useState<string>();
  const lastRevealedWordRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!descriptionHistoryOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDescriptionHistoryOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [descriptionHistoryOpen]);

  // 房间关闭后自动返回主页（room.closed 事件清空 roomId/snapshot）
  useEffect(() => {
    if (!joining && !snapshot && !storeRoomId) {
      navigate("/whoisfaker");
    }
  }, [joining, snapshot, storeRoomId, navigate]);

  // 进入房间时，先等连接就绪，再尝试重连/加入/创建；本地模式无需联网
  useEffect(() => {
    if (!roomId) return;

    if (offlineTestRoom) {
      let cancelled = false;
      useGameStore.getState().initTestRoomOffline();
      queueMicrotask(() => {
        if (!cancelled) setJoining(false);
      });
      return () => {
        cancelled = true;
      };
    }

    // 如果已经在这个房间，不重复
    if (alreadyInRoom) return;

    let cancelled = false;

    const tryEnter = async () => {
      setJoining(true);

      // 等 WebSocket 连接就绪
      try {
        await waitForConnection(8000);
      } catch {
        if (cancelled) return;
        addToast("连接服务器超时，请刷新重试", "error");
        navigate("/whoisfaker");
        return;
      }

      if (cancelled) return;

      // 尝试重连
      const ok = await reconnectRoom(roomId);
      if (ok) {
        if (!cancelled) setJoining(false);
        return;
      }

      if (cancelled) return;

      // 获取用户名
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
            await createRoom({
              roomId,
              name: `${name}的房间`,
              visibility: "public",
              allowSpectators: true,
              userName: name,
            });
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
    setPlayerMarks((current) => ({ ...current, [playerId]: mark }));
  }, []);

  const handleKick = useCallback(
    async (playerId: string) => {
      try {
        await sendCommand("room.kick", { playerId });
      } catch (error) {
        addToast((error as { message?: string }).message ?? "踢出玩家失败", "error");
      }
    },
    [addToast, sendCommand],
  );

  const handleTransferHost = useCallback(
    async (playerId: string) => {
      try {
        await sendCommand("room.transferHost", { playerId });
      } catch (error) {
        addToast((error as { message?: string }).message ?? "转移房主失败", "error");
      }
    },
    [addToast, sendCommand],
  );

  const me = snapshot?.players.find((p) => p.id === privateState?.playerId);
  const isHost = me?.isHost ?? false;
  const isSpectator = me?.membership === "spectator";
  const phase = snapshot?.status.phase ?? "waiting";
  const roleConfig = snapshot?.settings.roleConfig ?? {
    undercoverCount: 1,
    hasAngel: false,
    hasBlank: false,
  };
  const canMarkPlayers =
    me?.membership === "active" &&
    !privateState?.isQuestioner &&
    !["waiting", "assigningQuestioner", "wordSubmission", "gameOver"].includes(phase);
  const availableMarks = useMemo<PlayerMark[]>(
    () => [
      "unknown",
      "civilian",
      "undercover",
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
          : privateState?.blankHint
            ? `提示：${privateState.blankHint}`
            : undefined)
      : undefined;

  useEffect(() => {
    if (!assignedWordText) {
      lastRevealedWordRef.current = undefined;
      const resetTimer = window.setTimeout(() => {
        setWordRevealActive(false);
        setRevealedWord(undefined);
      }, 0);
      return () => window.clearTimeout(resetTimer);
    }
    if (lastRevealedWordRef.current === assignedWordText) return;

    lastRevealedWordRef.current = assignedWordText;
    const startTimer = window.setTimeout(() => {
      setRevealedWord(assignedWordText);
      setWordRevealActive(true);
    }, 0);
    const finishTimer = window.setTimeout(() => setWordRevealActive(false), 3000);
    return () => {
      window.clearTimeout(startTimer);
      window.clearTimeout(finishTimer);
    };
  }, [assignedWordText]);

  const playerRowContext = {
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

  if (joining || !snapshot) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center gap-3"
        >
          <motion.div
            className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent"
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
          />
          <span className="text-muted-foreground text-sm">正在加入房间...</span>
        </motion.div>
      </div>
    );
  }

  const day = snapshot.status.day ?? 0;
  const dayVisible = [
    "description",
    "voting",
    "tieBreak",
    "night",
    "blankGuess",
    "gameOver",
  ].includes(snapshot.status.phase);
  const privateInfoVisible = ![
    "waiting",
    "assigningQuestioner",
    "wordSubmission",
  ].includes(snapshot.status.phase);

  return (
    <LayoutGroup id="assigned-word-reveal">
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      {/* 顶部栏 — 三段式布局：左/中/右 */}
      <header className="grid h-14 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 bg-background px-2 md:grid-cols-3 md:gap-2 md:px-4 lg:px-6">
        {/* 左段：返回 + 房间信息 */}
        <div className="flex items-center gap-2 min-w-0">
          <Button variant="ghost" size="icon" onClick={handleLeave} className="shrink-0">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <span className="hidden truncate text-base font-semibold md:block">{snapshot.name}</span>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">#{snapshot.roomId}</span>
        </div>

        {/* 中段：第N天 + 词语 pill */}
        <div className="flex min-w-0 items-center justify-center gap-1 overflow-hidden md:gap-2">
          {dayVisible && day > 0 && (
            <span className="shrink-0 text-xs font-semibold text-muted-foreground sm:text-sm">
              第 {day} 天
            </span>
          )}
          {privateState?.isQuestioner && (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs font-semibold text-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              出题人视角
            </span>
          )}
          {isSpectator && (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
              <Eye className="h-3.5 w-3.5" />
              旁观视角
            </span>
          )}
          {privateInfoVisible &&
          assignedWordText &&
          revealedWord === assignedWordText &&
          !wordRevealActive ? (
            <motion.span
              layoutId="assigned-word"
              transition={{ layout: { duration: 0.65, ease: [0.22, 1, 0.36, 1] } }}
              className="max-w-32 shrink truncate rounded-md bg-primary/10 px-2.5 py-1 text-xs font-bold text-primary sm:max-w-none sm:text-sm"
            >
              {assignedWordText}
            </motion.span>
          ) : null}
        </div>

        {/* 右段：断线状态 + 移动端切换 + 设置 */}
        <div className="flex items-center justify-end gap-0 md:gap-1">
          {!connected && (
            <span className="mr-1 hidden shrink-0 animate-pulse text-xs text-destructive sm:inline">断线中...</span>
          )}
          <div className="flex md:hidden gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={() => setMobilePanel(mobilePanel === "players" ? "none" : "players")}
            >
              <Menu className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={() => setMobilePanel(mobilePanel === "chat" ? "none" : "chat")}
            >
              <MessageSquare className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              title="发言历史"
              aria-label="打开发言历史"
              onClick={() => {
                setMobilePanel("none");
                setDescriptionHistoryOpen(true);
              }}
            >
              <History className="h-5 w-5" />
            </Button>
          </div>
          {isHost && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSettingsOpen(true)}
              className="h-9 w-9 shrink-0 md:h-10 md:w-10"
            >
              <Settings className="h-5 w-5" />
            </Button>
          )}
        </div>
      </header>

      {/* 三栏布局 */}
      <div className="flex-1 flex overflow-hidden relative px-2 md:px-3 pb-2 md:pb-3 pt-0 gap-2 md:gap-3">
        {/* 玩家栏与游戏区共享覆盖层边界，历史展开时不改变布局宽度。 */}
        <section className="relative flex min-w-0 flex-1 gap-2 md:gap-3">
          <aside className="relative hidden w-64 shrink-0 flex-col rounded-xl border bg-card md:flex">
            <div className="flex h-full flex-col overflow-hidden rounded-xl">
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
            <button
              type="button"
              title="发言历史"
              aria-label="打开发言历史"
              onClick={() => setDescriptionHistoryOpen(true)}
            className="absolute -right-3 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border bg-card shadow-sm transition-colors hover:bg-muted"
            >
              <History className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </aside>

        {/* 移动端玩家列表覆盖层 */}
        {mobilePanel === "players" && (
          <motion.aside
            initial={{ x: -280 }}
            animate={{ x: 0 }}
            exit={{ x: -280 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="absolute inset-y-0 left-0 w-72 bg-card border-r z-30 md:hidden shadow-xl overflow-y-auto flex flex-col"
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

          {/* 中栏：游戏区 */}
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
            <GameArea wordRevealText={wordRevealActive ? revealedWord : undefined} />
          </main>

          <AnimatePresence>
            {descriptionHistoryOpen ? (
              <DescriptionHistoryOverlay
                players={snapshot.players}
                descriptions={snapshot.descriptions}
                playerRowContext={playerRowContext}
                onClose={() => setDescriptionHistoryOpen(false)}
              />
            ) : null}
          </AnimatePresence>
        </section>

        {/* 右栏：聊天 */}
        <aside className="w-80 overflow-hidden shrink-0 hidden lg:flex flex-col bg-card rounded-xl border">
          <ChatPanel />
        </aside>

        {/* 移动端聊天覆盖层 */}
        {mobilePanel === "chat" && (
          <motion.aside
            initial={{ x: 320 }}
            animate={{ x: 0 }}
            exit={{ x: 320 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="absolute inset-y-0 right-0 w-80 bg-card border-l z-30 lg:hidden shadow-xl flex flex-col"
          >
            <ChatPanel />
          </motion.aside>
        )}

        {/* 遮罩 */}
        {mobilePanel !== "none" && (
          <div
            className="absolute inset-0 bg-black/20 z-20 md:hidden"
            onClick={() => setMobilePanel("none")}
          />
        )}
      </div>

      {/* 设置弹窗 */}
      <RoomSettings open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
    </LayoutGroup>
  );
}
