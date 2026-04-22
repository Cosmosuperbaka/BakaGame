import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, Settings, Menu, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useGame } from "@/contexts/GameContext";
import { getSavedUsername } from "@/lib/cookie";
import { waitForConnection } from "@/lib/ws";
import { PHASE_LABELS } from "@/lib/helpers";
import { PlayerList } from "@/components/room/PlayerList";
import { GameArea } from "@/components/room/GameArea";
import { ChatPanel } from "@/components/room/ChatPanel";
import { RoomSettings } from "@/components/room/RoomSettings";

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const { state, createRoom, joinRoom, reconnectRoom, leaveRoom, addToast } = useGame();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [joining, setJoining] = useState(true);
  // 移动端侧栏
  const [mobilePanel, setMobilePanel] = useState<"none" | "players" | "chat">("none");

  // 房间关闭后自动返回主页（room.closed 事件清空 roomId/snapshot）
  useEffect(() => {
    if (!joining && !state.snapshot && !state.roomId) {
      navigate("/");
    }
  }, [joining, state.snapshot, state.roomId, navigate]);

  // 进入房间时，先等连接就绪，再尝试重连/加入/创建
  useEffect(() => {
    if (!roomId) return;
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
          // 房间不存在，自动以此 roomId 创建（名称缺省用 "{user}的房间"）
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
  const me = snapshot?.players.find((p) => p.id === state.privateState?.playerId);
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

  const phase = snapshot.status.phase;
  const started = snapshot.status.started;

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-muted/30">
      {/* 顶部栏 — 合并游戏状态信息 */}
      <header className="h-14 flex items-center px-4 lg:px-6 gap-3 shrink-0 bg-background">
        <Button variant="ghost" size="icon" onClick={handleLeave} className="shrink-0">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-base font-semibold truncate">{snapshot.name}</span>
          <span className="text-xs text-muted-foreground">#{snapshot.roomId}</span>
          {snapshot.testMode && (
            <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-medium">
              测试
            </span>
          )}
          <Badge variant="outline" className="text-xs py-0.5 px-2 shrink-0">
            {PHASE_LABELS[phase]}
          </Badge>
          {started && snapshot.status.day > 0 && (
            <span className="text-xs text-muted-foreground shrink-0">
              第{snapshot.status.day}天
            </span>
          )}
        </div>
        {!state.connected && (
          <span className="text-xs text-destructive animate-pulse shrink-0">断线中...</span>
        )}
        {/* 移动端切换 */}
        <div className="flex md:hidden gap-1">
          <Button variant="ghost" size="icon" onClick={() => setMobilePanel(mobilePanel === "players" ? "none" : "players")}>
            <Menu className="h-5 w-5" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setMobilePanel(mobilePanel === "chat" ? "none" : "chat")}>
            <MessageSquare className="h-5 w-5" />
          </Button>
        </div>
        {isHost && (
          <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)} className="shrink-0">
            <Settings className="h-5 w-5" />
          </Button>
        )}
      </header>

      {/* 三栏布局 */}
      <div className="flex-1 flex overflow-hidden relative p-2 md:p-3 gap-2 md:gap-3">
        {/* 左栏：玩家列表 */}
        <aside className="w-64 overflow-y-auto shrink-0 hidden md:flex flex-col bg-background rounded-xl border">
          <PlayerList
            players={snapshot.players}
            hostPlayerId={snapshot.hostPlayerId}
            myPlayerId={state.privateState?.playerId}
            isHost={isHost}
            phase={snapshot.status.phase}
            allowSpectators={snapshot.allowSpectators}
            privateState={state.privateState}
          />
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
              myPlayerId={state.privateState?.playerId}
              isHost={isHost}
              phase={snapshot.status.phase}
              allowSpectators={snapshot.allowSpectators}
              privateState={state.privateState}
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
