import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { listItem, selectable, backdrop, spring, listContainer } from "@/lib/Motion";
import { ArrowLeft, Plus, Lock, Users, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/Dialog";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { useLobbySession } from "@/hooks/UseLobbySession";
import { CreateRoomDialog } from "@/components/common/CreateRoomDialog";
import { RoomCardSkeleton } from "@/components/common/RoomCardSkeleton";
import { Seo } from "@/components/common/Seo";
import { cn } from "@/lib/Utils";
import type { RoomSummary } from "@/types";

export default function WhoIsFakerPage() {
  const navigate = useNavigate();
  const rooms = useWhoIsFakerStore((state) => state.rooms);
  const connected = useWhoIsFakerStore((state) => state.connected);
  const createRoom = useWhoIsFakerStore((state) => state.createRoom);
  const joinRoom = useWhoIsFakerStore((state) => state.joinRoom);
  const reconnectRoom = useWhoIsFakerStore((state) => state.reconnectRoom);
  const addToast = useWhoIsFakerStore((state) => state.addToast);

  const {
    userName,
    setUserName,
    createOpen,
    setCreateOpen,
    joinTarget,
    setJoinTarget,
    joinPassword,
    setJoinPassword,
    createOrigin,
    joinOrigin,
    handleJoinRoom,
    handlePasswordJoin,
    handleCreateRoom,
    isInitialLoading,
  } = useLobbySession<RoomSummary>({
    gamePath: "/whoisfaker",
    rooms,
    connected,
    createRoom,
    joinRoom,
    reconnectRoom,
    showError: (message) => addToast(message, "error"),
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring.swift}
      className="scrollbar-hidden flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto bg-background"
    >
      <Seo path="/whoisfaker" />
      <header className="border-b border-border/40 pb-4 pt-6 md:pt-8 px-6">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground -ml-2 h-8 px-2"
            onClick={() => navigate("/")}
          >
            <ArrowLeft className="h-4 w-4" />
            <span>返回主页</span>
          </Button>
          <div className="h-4 w-px bg-border/60" />
          <h1 className="flex items-center gap-2 text-xl sm:text-2xl font-bold tracking-tight">
            <span>Who is</span>
            <img
              src="/assets/Faker.png"
              alt="Faker"
              className="h-6 w-6 sm:h-7 sm:w-7 rounded-md object-cover shadow-2xs border border-border/60"
            />
          </h1>
        </div>
      </header>

      <main className="flex-1 w-full max-w-3xl mx-auto px-6 md:px-10 pt-6 pb-10">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight">房间列表</h2>
            <span className="text-xs font-mono text-muted-foreground bg-muted/60 px-2 py-0.5 rounded-md">
              {rooms.length}
            </span>
          </div>
          <div className="flex items-center gap-2.5">
            <Input
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="输入用户名"
              className="h-8 w-28 sm:w-36 text-xs sm:text-sm bg-card/60 border-border/70 shadow-2xs"
              maxLength={20}
            />
            <Button
              size="sm"
              onClick={(event) => {
                createOrigin.capture(event);
                setCreateOpen(true);
              }}
              className="h-8 gap-1.5 shadow-2xs text-xs sm:text-sm shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
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
            {isInitialLoading ? (
              <RoomCardSkeleton count={3} />
            ) : rooms.length === 0 ? (
              <motion.div
                key="empty"
                variants={backdrop}
                initial="initial"
                animate="animate"
                exit="exit"
                className="flex flex-col items-center justify-center rounded-md border border-dashed border-border/80 bg-card/30 py-16 text-center shadow-2xs"
              >
                <p className="text-sm text-muted-foreground">
                  暂无房间，点击上方按钮创建一个吧
                </p>
              </motion.div>
            ) : (
              rooms.map((room) => {
                const isWaiting = room.phase === "waiting" || room.phase === "gameOver";
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
                      onClick={(event) => handleJoinRoom(room, event)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          handleJoinRoom(room, event as unknown as React.MouseEvent<HTMLElement>);
                        }
                      }}
                    >
                      <CardContent className="p-4 sm:py-4 sm:px-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
                        <div className="flex items-center gap-4 min-w-0">
                          <div className="min-w-0">
                            <div className="text-base font-medium flex items-center gap-2 truncate">
                              <span className="truncate">{room.name}</span>
                              {room.hasPassword && (
                                <Lock className="h-4 w-4 text-muted-foreground shrink-0" />
                              )}
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
                            <Users className="h-4 w-4 text-muted-foreground/70 shrink-0" />
                            <span className="flex items-center gap-2">
                              <span>
                                <span className="inline-block w-[2ch] text-right tabular-nums">{room.playerCount}</span>玩家
                              </span>
                              <span>
                                <span className="inline-block w-[2ch] text-right tabular-nums">{room.spectatorCount}</span>旁观
                              </span>
                            </span>
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
        onValidationError={(message) => addToast(message, "error")}
        onCreate={handleCreateRoom}
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
    </motion.div>
  );
}
