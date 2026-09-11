import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Eye, EyeOff, Lock, Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { CreateRoomDialog } from "@/components/common/CreateRoomDialog";
import { getSavedUsername, saveUsername } from "@/lib/Storage";
import { randomRoomId } from "@/lib/Random";
import { backdrop, listItem, selectable, spring, listContainer } from "@/lib/Motion";
import { useOriginTracker } from "@/hooks/UseOriginTracker";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { cn } from "@/lib/Utils";
import type { SonGuessrRoomSummary } from "@/types";

export default function SonGuessrPage() {
  const navigate = useNavigate();
  const rooms = useSonGuessrStore((state) => state.rooms);
  const createRoom = useSonGuessrStore((state) => state.createRoom);
  const joinRoom = useSonGuessrStore((state) => state.joinRoom);
  const reconnectRoom = useSonGuessrStore((state) => state.reconnectRoom);
  const setNotice = useSonGuessrStore((state) => state.setNotice);

  const [userName, setUserName] = useState(getSavedUsername);
  const [createOpen, setCreateOpen] = useState(false);
  const [joinTarget, setJoinTarget] = useState<SonGuessrRoomSummary | null>(null);
  const [joinPassword, setJoinPassword] = useState("");
  const createOrigin = useOriginTracker();
  const joinOrigin = useOriginTracker();

  useEffect(() => {
    if (userName.trim()) saveUsername(userName.trim());
  }, [userName]);

  const handleJoinRoom = useCallback(
    async (room: SonGuessrRoomSummary, event: React.MouseEvent<HTMLElement>) => {
      joinOrigin.capture(event);
      if (!userName.trim()) {
        setNotice("请先设置用户名", "error");
        return;
      }
      const reconnected = await reconnectRoom(room.roomId);
      if (reconnected) {
        navigate(`/songuessr/room/${room.roomId}`);
        return;
      }
      if (room.hasPassword) {
        setJoinTarget(room);
        setJoinPassword("");
      } else {
        try {
          await joinRoom(room.roomId, userName.trim());
          navigate(`/songuessr/room/${room.roomId}`);
        } catch (error) {
          setNotice((error as { message: string }).message, "error");
        }
      }
    },
    [joinRoom, navigate, reconnectRoom, setNotice, userName], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handlePasswordJoin = useCallback(async () => {
    if (!joinTarget) return;
    try {
      await joinRoom(joinTarget.roomId, userName.trim(), joinPassword);
      setJoinTarget(null);
      navigate(`/songuessr/room/${joinTarget.roomId}`);
    } catch (error) {
      setNotice((error as { message: string }).message, "error");
    }
  }, [joinPassword, joinRoom, joinTarget, navigate, setNotice, userName]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring.swift}
      className="scrollbar-hidden flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto bg-background"
    >
      <header className="pt-10 md:pt-14 pb-4 md:pb-6 px-6">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-2 mb-3">
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
          <div className="flex items-center justify-between">
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Songuessr</h1>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-3xl mx-auto px-6 md:px-10 pb-10">
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <h2 className="text-xl font-semibold tracking-tight">房间列表</h2>
            <Badge variant="secondary" className="text-xs font-normal tabular-nums px-2 py-0.5">
              {rooms.length} 间
            </Badge>
          </div>
          <div className="flex items-center gap-2.5 w-full sm:w-auto">
            <Input
              value={userName}
              onChange={(event) => setUserName(event.target.value)}
              placeholder="输入用户名"
              className="h-9 min-w-0 flex-1 sm:w-44 text-sm"
              maxLength={20}
            />
            <Button
              size="default"
              onClick={(event) => {
                createOrigin.capture(event);
                setCreateOpen(true);
              }}
              className="h-9 shrink-0 gap-1.5 shadow-sm"
            >
              <Plus className="h-4 w-4" />
              创建房间
            </Button>
          </div>
        </div>

        <motion.div
          className="flex flex-col gap-3"
          variants={listContainer(rooms.length)}
          initial="initial"
          animate="animate"
        >
          <AnimatePresence initial={false}>
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
              rooms.map((room) => {
                const isWaiting = room.phase === "waiting" || room.phase === "roundResult";
                return (
                  <motion.div
                    key={room.roomId}
                    variants={listItem}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    layout="position"
                    className="rounded-md bg-card"
                    {...selectable}
                  >
                    <Card
                      role="button"
                      tabIndex={0}
                      className="cursor-pointer transition-[background,border-color,box-shadow] duration-150 hover:border-primary/40 hover:bg-accent/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      onClick={(event) => void handleJoinRoom(room, event)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          void handleJoinRoom(room, event as unknown as React.MouseEvent<HTMLElement>);
                        }
                      }}
                    >
                      <CardContent className="p-4 sm:py-4 sm:px-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
                        <div className="flex items-center gap-4 min-w-0">
                          <div className="min-w-0">
                            <div className="text-base font-medium flex items-center gap-2 truncate">
                              <span className="truncate">{room.name}</span>
                              {room.hasPassword && <Lock className="h-4 w-4 text-muted-foreground shrink-0" />}
                            </div>
                            <div className="text-sm text-muted-foreground mt-0.5 sm:mt-1">
                              房间号: <span className="font-mono">{room.roomId}</span>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center justify-between sm:justify-end gap-3 sm:gap-4 text-sm text-muted-foreground shrink-0 border-t border-border/30 pt-2.5 sm:border-0 sm:pt-0">
                          <div className="flex items-center gap-2">
                            <Badge
                              variant={isWaiting ? "outline" : "secondary"}
                              className={cn(
                                "text-xs font-normal",
                                isWaiting
                                  ? "text-muted-foreground border-border/80"
                                  : "bg-primary/10 text-primary border border-primary/20",
                              )}
                            >
                              {isWaiting ? "等待中" : "游戏中"}
                            </Badge>
                            {room.allowSpectators ? (
                              <Badge
                                variant="outline"
                                className="text-xs font-normal gap-1 text-muted-foreground border-border/80"
                              >
                                <Eye className="h-3.5 w-3.5" />
                                可观战
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="text-xs font-normal gap-1 text-muted-foreground/45 border-dashed border-border/60"
                              >
                                <EyeOff className="h-3.5 w-3.5" />
                                禁观战
                              </Badge>
                            )}
                          </div>

                          <div className="flex items-center gap-1.5 tabular-nums text-xs sm:text-sm text-muted-foreground">
                            <Users className="h-4 w-4 text-muted-foreground/70" />
                            <span>{room.playerCount}玩家 {room.spectatorCount}观战</span>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                );
              })
            )}
          </AnimatePresence>
        </motion.div>
      </main>

      <CreateRoomDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        origin={createOrigin.origin}
        defaultName={userName.trim() ? `${userName.trim()}的房间` : "新房间"}
        onValidationError={(message) => setNotice(message, "error")}
        onCreate={async (params) => {
          if (!userName.trim()) {
            setNotice("请先设置用户名", "error");
            return;
          }
          try {
            const generatedRoomId = randomRoomId();
            await createRoom({
              ...params,
              roomId: generatedRoomId,
              userName: userName.trim(),
            });
            setCreateOpen(false);
            navigate(`/songuessr/room/${generatedRoomId}`);
          } catch (error) {
            setNotice((error as { message: string }).message, "error");
          }
        }}
      />

      <Dialog
        open={Boolean(joinTarget)}
        onOpenChange={() => setJoinTarget(null)}
        origin={joinOrigin.origin}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>输入房间密码</DialogTitle>
            <DialogDescription>
              房间 &ldquo;{joinTarget?.name}&rdquo; 需要密码
            </DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            value={joinPassword}
            onChange={(event) => setJoinPassword(event.target.value)}
            placeholder="请输入密码"
            className="h-10 text-base"
            onKeyDown={(event) => event.key === "Enter" && void handlePasswordJoin()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setJoinTarget(null)}>取消</Button>
            <Button onClick={handlePasswordJoin}>加入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
