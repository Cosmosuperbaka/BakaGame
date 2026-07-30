import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Settings,
  Menu,
  MessageSquare,
  ChevronRight,
  ChevronLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGame } from "@/contexts/GameContext";
import { getSavedUsername, isTestRoomId } from "@/lib/cookie";
import { waitForConnection } from "@/lib/ws";
import { useGameStore } from "@/stores/useGameStore";
import { PlayerList } from "@/components/room/PlayerList";
import { GameArea } from "@/components/room/GameArea";
import { ChatPanel } from "@/components/room/ChatPanel";
import { RoomSettings } from "@/components/room/RoomSettings";
import { DescriptionTable } from "@/components/game/DescriptionHistory";
import { cn } from "@/lib/utils";

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const { state, createRoom, joinRoom, reconnectRoom, leaveRoom, addToast } = useGame();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [joining, setJoining] = useState(true);
  // 移动端侧栏
  const [mobilePanel, setMobilePanel] = useState<"none" | "players" | "chat">("none");
  // 左侧玩家面板：展开后显示描述历史
  const [playerPanelExpanded, setPlayerPanelExpanded] = useState(false);

  // 房间关闭后自动返回主页（room.closed 事件清空 roomId/snapshot）
  useEffect(() => {
    if (!joining && !state.snapshot && !state.roomId) {
      navigate("/");
    }
  }, [joining, state.snapshot, state.roomId, navigate]);

  // 进入房间时，先等连接就绪，再尝试重连/加入/创建；测试房间为离线模式无需联网
  useEffect(() => {
    if (!roomId) return;

    if (isTestRoomId(roomId)) {
      useGameStore.getState().initTestRoomOffline();
      setJoining(false);
      return;
    }

    // 如果已经在这个房间，不重复
    if (state.roomId === roomId && state.snapshot) {
      setJoining(false);
      return;
    }

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

  const snapshot = state.snapshot;
  const privateState = state.privateState;
  const me = snapshot?.players.find((p) => p.id === privateState?.playerId);
  const isHost = me?.isHost ?? false;

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

  const started = snapshot.status.started;
  const day = snapshot.status.day ?? 0;

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-muted/30">
      {/* 顶部栏 — 三段式布局：左/中/右 */}
      <header className="h-14 grid grid-cols-3 items-center px-4 lg:px-6 shrink-0 bg-background gap-2">
        {/* 左段：返回 + 房间信息 */}
        <div className="flex items-center gap-2 min-w-0">
          <Button variant="ghost" size="icon" onClick={handleLeave} className="shrink-0">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <span className="text-base font-semibold truncate">{snapshot.name}</span>
          <span className="text-xs text-muted-foreground shrink-0">#{snapshot.roomId}</span>
          {snapshot.testMode && (
            <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-medium shrink-0">
              测试
            </span>
          )}
        </div>

        {/* 中段：第N天 + 词语 pill */}
        <div className="flex items-center justify-center gap-2">
          {started && day > 0 && (
            <span className="text-sm font-semibold text-muted-foreground shrink-0">
              第 {day} 天
            </span>
          )}
          {privateState?.isQuestioner && (
            <span className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 px-2.5 py-0.5 rounded-md font-medium shrink-0">
              出题人
            </span>
          )}
          {privateState?.word && (
            <span className="text-sm font-bold bg-primary/10 text-primary px-2.5 py-0.5 rounded-md shrink-0">
              {privateState.word}
            </span>
          )}
          {privateState?.angelWordOptions && (
            <span className="text-sm font-bold text-amber-700 dark:text-amber-400 bg-amber-500/10 px-2.5 py-0.5 rounded-md shrink-0">
              {privateState.angelWordOptions[0]} / {privateState.angelWordOptions[1]}
            </span>
          )}
          {privateState?.blankHint && (
            <span className="text-sm font-bold text-amber-700 dark:text-amber-400 bg-amber-500/10 px-2.5 py-0.5 rounded-md shrink-0">
              提示：{privateState.blankHint}
            </span>
          )}
        </div>

        {/* 右段：断线状态 + 移动端切换 + 设置 */}
        <div className="flex items-center justify-end gap-1">
          {!state.connected && (
            <span className="text-xs text-destructive animate-pulse shrink-0 mr-1">断线中...</span>
          )}
          <div className="flex md:hidden gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobilePanel(mobilePanel === "players" ? "none" : "players")}
            >
              <Menu className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobilePanel(mobilePanel === "chat" ? "none" : "chat")}
            >
              <MessageSquare className="h-5 w-5" />
            </Button>
          </div>
          {isHost && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSettingsOpen(true)}
              className="shrink-0"
            >
              <Settings className="h-5 w-5" />
            </Button>
          )}
        </div>
      </header>

      {/* 三栏布局 */}
      <div className="flex-1 flex overflow-hidden relative px-2 md:px-3 pb-2 md:pb-3 pt-0 gap-2 md:gap-3">
        {/* 左栏：玩家列表（可展开显示描述历史） */}
        <aside
          className={cn(
            "shrink-0 hidden md:flex flex-col relative bg-background rounded-xl border transition-all duration-200",
            playerPanelExpanded ? "w-[580px]" : "w-64"
          )}
        >
          <div className="flex h-full overflow-hidden rounded-xl">
            {/* 玩家列表列（固定宽度） */}
            <div className="w-64 shrink-0 flex flex-col border-r overflow-hidden">
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
            {/* 描述历史列（展开时显示） */}
            {playerPanelExpanded && (
              <div className="flex-1 min-w-0 overflow-auto p-4">
                <DescriptionTable descriptions={snapshot.descriptions} />
              </div>
            )}
          </div>
          {/* 展开/收起按钮，悬浮在右边框中点 */}
          <button
            type="button"
            aria-label={playerPanelExpanded ? "收起历史" : "展开描述历史"}
            onClick={() => setPlayerPanelExpanded((v) => !v)}
            className="absolute -right-3 top-1/2 -translate-y-1/2 z-10 h-6 w-6 rounded-full bg-background border shadow-sm flex items-center justify-center hover:bg-muted transition-colors"
          >
            {playerPanelExpanded ? (
              <ChevronLeft className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
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
        <main className="flex-1 overflow-hidden flex flex-col min-w-0 bg-background rounded-xl border">
          <GameArea />
        </main>

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
