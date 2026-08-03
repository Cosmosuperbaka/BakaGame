import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { listItem, pressable, backdrop } from "@/lib/motion";
import { ArrowLeft, RefreshCw, Plus, Lock, Users, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { useGameStore } from "@/stores/useGameStore";
import { CreateRoomDialog } from "@/components/home/CreateRoomDialog";
import { getSavedUsername, saveUsername } from "@/lib/cookie";
import { PHASE_LABELS, randomRoomId } from "@/lib/helpers";
import type { RoomSummary } from "@/types";


export default function WhoIsFakerPage() {
  const navigate = useNavigate();
  const rooms = useGameStore((state) => state.rooms);
  const createRoom = useGameStore((state) => state.createRoom);
  const joinRoom = useGameStore((state) => state.joinRoom);
  const reconnectRoom = useGameStore((state) => state.reconnectRoom);
  const subscribeLobby = useGameStore((state) => state.subscribeLobby);
  const addToast = useGameStore((state) => state.addToast);

  const [userName, setUserName] = useState(getSavedUsername);
  const [createOpen, setCreateOpen] = useState(false);
  const [joinTarget, setJoinTarget] = useState<RoomSummary | null>(null);
  const [joinPassword, setJoinPassword] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (userName.trim()) saveUsername(userName.trim());
  }, [userName]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await subscribeLobby();
    } catch {
      addToast("刷新失败", "error");
    } finally {
      setTimeout(() => setRefreshing(false), 500);
    }
  }, [subscribeLobby, addToast]);

  const handleJoinRoom = useCallback(
    async (room: RoomSummary) => {
      if (!userName.trim()) {
        addToast("请先设置用户名", "error");
        return;
      }
      const reconnected = await reconnectRoom(room.roomId);
      if (reconnected) {
        navigate(`/whoisfaker/room/${room.roomId}`);
        return;
      }
      if (room.hasPassword) {
        setJoinTarget(room);
        setJoinPassword("");
      } else {
        try {
          await joinRoom(room.roomId, userName.trim());
          navigate(`/whoisfaker/room/${room.roomId}`);
        } catch (e) {
          addToast((e as { message: string }).message, "error");
        }
      }
    },
    [userName, joinRoom, reconnectRoom, navigate, addToast]
  );

  const handlePasswordJoin = useCallback(async () => {
    if (!joinTarget) return;
    try {
      await joinRoom(joinTarget.roomId, userName.trim(), joinPassword);
      setJoinTarget(null);
      navigate(`/whoisfaker/room/${joinTarget.roomId}`);
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [joinTarget, joinPassword, userName, joinRoom, navigate, addToast]);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="pt-12 md:pt-16 pb-5 md:pb-6 px-6">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-2 mb-4">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground -ml-2 h-8"
              onClick={() => navigate("/")}
            >
              <ArrowLeft className="h-4 w-4" />
              返回主页
            </Button>
          </div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Who is Faker</h1>
          <p className="text-muted-foreground text-sm mt-1.5">谁是卧底 · 多人派对游戏</p>
        </div>
      </header>

      <main className="flex-1 w-full max-w-3xl mx-auto px-6 md:px-10 pb-10">
        <div className="flex items-center gap-3 mb-5">
          <h2 className="text-xl font-semibold shrink-0">房间列表</h2>
          <div className="flex-1" />
          <Input
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            placeholder="用户名"
            className="w-32 md:w-40 h-9 text-sm"
            maxLength={20}
          />
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <RefreshCw className={`h-4 w-4 transition-transform ${refreshing ? "animate-spin" : ""}`} />
          </Button>
          <Button size="default" onClick={() => setCreateOpen(true)} className="gap-2 shrink-0">
            <Plus className="h-4 w-4" />
            创建房间
          </Button>
        </div>

        <div className="space-y-3">
          <AnimatePresence mode="popLayout" initial={false}>
            {rooms.length === 0 ? (
              <motion.div
                key="empty"
                variants={backdrop}
                initial="initial"
                animate="animate"
                exit="exit"
                className="text-center py-20 text-muted-foreground text-base"
              >
                暂无房间，点击上方按钮创建一个吧
              </motion.div>
            ) : (
              rooms.map((room) => (
                <motion.div
                  key={room.roomId}
                  variants={listItem}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  layout
                  {...pressable}
                >
                  <Card
                    className="cursor-pointer transition-[background,border-color,box-shadow] duration-150 hover:border-primary/40 hover:bg-accent/40 hover:shadow-sm"
                    onClick={() => handleJoinRoom(room)}
                  >
                    <CardContent className="py-4 px-5 flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div>
                          <div className="text-base font-medium flex items-center gap-2">
                            {room.name}
                            {room.hasPassword && (
                              <Lock className="h-4 w-4 text-muted-foreground" />
                            )}
                          </div>
                          <div className="text-sm text-muted-foreground mt-1">
                            房间号: {room.roomId}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 text-sm text-muted-foreground">
                        <Badge variant="outline" className="font-normal text-xs">
                          {PHASE_LABELS[room.phase] ?? room.phase}
                        </Badge>
                        <span className="flex items-center gap-1.5">
                          <Users className="h-4 w-4" />
                          {room.onlineCount}/{room.playerCount}
                        </span>
                        {room.allowSpectators && (
                          <Eye className="h-4 w-4" />
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ))
            )}
          </AnimatePresence>
        </div>
      </main>

      <CreateRoomDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaultName={userName.trim() ? `${userName.trim()}的房间` : "新房间"}
        onCreate={async (params) => {
          if (!userName.trim()) {
            addToast("请先设置用户名", "error");
            return;
          }
          try {
            const rid = randomRoomId();
            await createRoom({ ...params, roomId: rid, userName: userName.trim() });
            setCreateOpen(false);
            navigate(`/whoisfaker/room/${rid}`);
          } catch (e) {
            addToast((e as { message: string }).message, "error");
          }
        }}
      />

      <Dialog open={!!joinTarget} onOpenChange={() => setJoinTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>输入房间密码</DialogTitle>
            <DialogDescription>房间 &ldquo;{joinTarget?.name}&rdquo; 需要密码</DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            value={joinPassword}
            onChange={(e) => setJoinPassword(e.target.value)}
            placeholder="请输入密码"
            className="h-10 text-base"
            onKeyDown={(e) => e.key === "Enter" && handlePasswordJoin()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setJoinTarget(null)}>取消</Button>
            <Button onClick={handlePasswordJoin}>加入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
