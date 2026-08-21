import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { listItem, selectable, backdrop, spinner, spring, useOriginTracker } from "@/lib/motion";
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
  const createOrigin = useOriginTracker();
  const joinOrigin = useOriginTracker();

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
    async (room: RoomSummary, event: React.MouseEvent<HTMLElement>) => {
      joinOrigin.capture(event);
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
    // joinOrigin.capture 是稳定的闭包，无需纳入依赖
    [userName, joinRoom, reconnectRoom, navigate, addToast] // eslint-disable-line react-hooks/exhaustive-deps
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
    <div className="scrollbar-hidden flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto bg-background">
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
          <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight md:text-4xl">
            <span>Who is</span>
            <img
              src="/assets/Faker.webp"
              alt="Faker"
              className="h-[1.4em] w-[1.4em] rounded-[10px] object-cover"
            />
          </h1>
        </div>
      </header>

      <main className="flex-1 w-full max-w-3xl mx-auto px-6 md:px-10 pb-10">
        <div className="mb-5 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 md:flex">
          <h2 className="col-span-3 shrink-0 text-xl font-semibold md:col-auto">房间列表</h2>
          <div className="hidden flex-1 md:block" />
          <Input
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            placeholder="用户名"
            className="h-9 min-w-0 w-full text-sm md:w-40"
            maxLength={20}
          />
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={handleRefresh}
            disabled={refreshing}
            aria-label="刷新房间列表"
          >
            {/* 刷新中持续旋转；结束时缓出停下，不做角度回弹 */}
            <motion.span
              className="inline-flex"
              animate={refreshing ? spinner.animate : { rotate: 0 }}
              transition={refreshing ? spinner.transition : spring.settle}
            >
              <RefreshCw className="h-4 w-4" />
            </motion.span>
          </Button>
          <Button
            size="default"
            onClick={(event) => {
              createOrigin.capture(event);
              setCreateOpen(true);
            }}
            className="shrink-0 gap-2"
          >
            <Plus className="h-4 w-4" />
            创建房间
          </Button>
        </div>

        <div className="flex flex-col gap-3">
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
                  layout="position"
                  {...selectable}
                >
                  <Card
                    role="button"
                    tabIndex={0}
                    className="cursor-pointer transition-[background,border-color,box-shadow] duration-150 hover:border-primary/40 hover:bg-accent/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    onClick={(event) => handleJoinRoom(room, event)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleJoinRoom(room, event as unknown as React.MouseEvent<HTMLElement>);
                      }
                    }}
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
        origin={createOrigin.origin}
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

      <Dialog
        open={!!joinTarget}
        onOpenChange={() => setJoinTarget(null)}
        origin={joinOrigin.origin}
      >
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
