import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
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
import { PlayerList } from "@/components/room/PlayerList";
import { GameArea } from "@/components/room/GameArea";
import { ChatPanel } from "@/components/room/ChatPanel";
import { RoomSettings } from "@/components/room/RoomSettings";
import { DescriptionHistoryOverlay } from "@/components/game/DescriptionHistory";

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
  // 移动端侧栏
  const [mobilePanel, setMobilePanel] = useState<"none" | "players" | "chat">("none");
  const [descriptionHistoryOpen, setDescriptionHistoryOpen] = useState(false);

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
      navigate("/");
    }
  }, [joining, snapshot, storeRoomId, navigate]);

  // 进入房间时，先等连接就绪，再尝试重连/加入/创建；测试房间为离线模式无需联网
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
        navigate("/");
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
        navigate("/");
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
            navigate("/");
          }
        } else {
          addToast(err.message ?? "加入房间失败", "error");
          navigate("/");
        }
      }
    };

    tryEnter();
    return () => { cancelled = true; };
  }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLeave = useCallback(async () => {
    await leaveRoom();
    navigate("/");
  }, [leaveRoom, navigate]);

  const me = snapshot?.players.find((p) => p.id === privateState?.playerId);
  const isHost = me?.isHost ?? false;
  const isSpectator = me?.membership === "spectator";

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
    <div className="h-screen flex flex-col overflow-hidden bg-muted/30">
      {/* 顶部栏 — 三段式布局：左/中/右 */}
      <header className="grid h-14 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 bg-background px-2 md:grid-cols-3 md:gap-2 md:px-4 lg:px-6">
        {/* 左段：返回 + 房间信息 */}
        <div className="flex items-center gap-2 min-w-0">
          <Button variant="ghost" size="icon" onClick={handleLeave} className="shrink-0">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <span className="hidden truncate text-base font-semibold md:block">{snapshot.name}</span>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">#{snapshot.roomId}</span>
          {snapshot.testMode && (
            <span className="hidden shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 md:inline">
              测试
            </span>
          )}
        </div>

        {/* 中段：第N天 + 词语 pill */}
        <div className="flex min-w-0 items-center justify-center gap-1 overflow-hidden md:gap-2">
          {dayVisible && day > 0 && (
            <span className="shrink-0 text-xs font-semibold text-muted-foreground sm:text-sm">
              第 {day} 天
            </span>
          )}
          {privateState?.isQuestioner && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1 text-xs font-semibold text-background shadow-sm shrink-0">
              <ShieldCheck className="h-3.5 w-3.5" />
              出题人视角
            </span>
          )}
          {isSpectator && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-sky-300 bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-800 shadow-sm dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-200 shrink-0">
              <Eye className="h-3.5 w-3.5" />
              旁观视角
            </span>
          )}
          {privateInfoVisible && !isSpectator && privateState?.word && (
            <span className="max-w-24 shrink truncate rounded-md bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary sm:max-w-none sm:px-2.5 sm:text-sm">
              {privateState.word}
            </span>
          )}
          {privateInfoVisible && !isSpectator && privateState?.angelWordOptions && (
            <span className="max-w-32 shrink truncate rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-bold text-amber-700 dark:text-amber-400 sm:max-w-none sm:px-2.5 sm:text-sm">
              {privateState.angelWordOptions[0]} / {privateState.angelWordOptions[1]}
            </span>
          )}
          {privateInfoVisible && !isSpectator && !privateState?.isQuestioner && privateState?.blankHint && (
            <span className="max-w-32 shrink truncate rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-bold text-amber-700 dark:text-amber-400 sm:max-w-none sm:px-2.5 sm:text-sm">
              提示：{privateState.blankHint}
            </span>
          )}
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
          <aside className="relative hidden w-64 shrink-0 flex-col rounded-xl border bg-background md:flex">
            <div className="flex h-full flex-col overflow-hidden rounded-xl">
              <PlayerList
                players={snapshot.players}
                hostPlayerId={snapshot.hostPlayerId}
                myPlayerId={privateState?.playerId}
                isHost={isHost}
                phase={snapshot.status.phase}
                allowSpectators={snapshot.allowSpectators}
                privateState={privateState}
              />
            </div>
            <button
              type="button"
              title="发言历史"
              aria-label="打开发言历史"
              onClick={() => setDescriptionHistoryOpen(true)}
              className="absolute -right-3 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border bg-background shadow-sm transition-colors hover:bg-muted"
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
            className="absolute inset-y-0 left-0 w-72 bg-background border-r z-30 md:hidden shadow-xl overflow-y-auto flex flex-col"
          >
            <PlayerList
              players={snapshot.players}
              hostPlayerId={snapshot.hostPlayerId}
              myPlayerId={privateState?.playerId}
              isHost={isHost}
              phase={snapshot.status.phase}
              allowSpectators={snapshot.allowSpectators}
              privateState={privateState}
            />
          </motion.aside>
        )}

          {/* 中栏：游戏区 */}
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background">
            <GameArea />
          </main>

          <AnimatePresence>
            {descriptionHistoryOpen ? (
              <DescriptionHistoryOverlay
                players={snapshot.players}
                descriptions={snapshot.descriptions}
                onClose={() => setDescriptionHistoryOpen(false)}
              />
            ) : null}
          </AnimatePresence>
        </section>

        {/* 右栏：聊天 */}
        <aside className="w-80 overflow-hidden shrink-0 hidden lg:flex flex-col bg-background rounded-xl border">
          <ChatPanel />
        </aside>

        {/* 移动端聊天覆盖层 */}
        {mobilePanel === "chat" && (
          <motion.aside
            initial={{ x: 320 }}
            animate={{ x: 0 }}
            exit={{ x: 320 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="absolute inset-y-0 right-0 w-80 bg-background border-l z-30 lg:hidden shadow-xl flex flex-col"
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
  );
}
