import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { RefreshCw, Plus, Lock, Users, Eye } from "lucide-react";
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
import faviconUrl from "@/assets/favicon.png";
import type { RoomSummary } from "@/types";

interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  content: string;
}

interface ChangelogData {
  currentVersion: string;
  entries: ChangelogEntry[];
}

const listItemVariants = {
  hidden: { opacity: 0, y: 6 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: {
      delay: Math.min(i, 4) * 0.02,
      duration: 0.22,
      ease: [0.22, 1, 0.36, 1] as const,
    },
  }),
  exit: { opacity: 0, transition: { duration: 0.15 } },
};

export default function HomePage() {
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
  const [versionOpen, setVersionOpen] = useState(false);
  const [changelog, setChangelog] = useState<ChangelogData | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (userName.trim()) saveUsername(userName.trim());
  }, [userName]);

  useEffect(() => {
    fetch("/changelog.json")
      .then((r) => r.json())
      .then((data: ChangelogData) => setChangelog(data))
      .catch(() => {});
  }, []);

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
        navigate(`/room/${room.roomId}`);
        return;
      }
      if (room.hasPassword) {
        setJoinTarget(room);
        setJoinPassword("");
      } else {
        try {
          await joinRoom(room.roomId, userName.trim());
          navigate(`/room/${room.roomId}`);
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
      navigate(`/room/${joinTarget.roomId}`);
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [joinTarget, joinPassword, userName, joinRoom, navigate, addToast]);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="pt-16 md:pt-20 pb-6 md:pb-8 text-center px-6">
        <h1 className="text-5xl md:text-6xl font-bold tracking-tight flex items-center justify-center gap-4">
          Who is{" "}
          <img
            src={faviconUrl}
            alt="Faker"
            className="h-14 md:h-16 inline-block rounded-lg"
          />
        </h1>
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
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="text-center py-20 text-muted-foreground text-base"
              >
                暂无房间，点击上方按钮创建一个吧
              </motion.div>
            ) : (
              rooms.map((room, i) => (
                <motion.div
                  key={room.roomId}
                  custom={i}
                  variants={listItemVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  layout
                >
                  <Card
                    className="cursor-pointer transition-[background,border-color,box-shadow] duration-150 hover:bg-primary/5 hover:border-primary/40"
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
            navigate(`/room/${rid}`);
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

      <Dialog open={versionOpen} onOpenChange={setVersionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>版本信息</DialogTitle>
            <DialogDescription>WhoIsFaker 更新日志</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm max-h-[60vh] overflow-y-auto">
            {changelog?.entries.map((entry, idx) => (
              <div key={entry.version} className="space-y-2">
                <div className="flex items-baseline gap-2">
                  <strong className="text-foreground text-base">v{entry.version}</strong>
                  <span className="text-muted-foreground text-xs">{entry.date}</span>
                  <span className="text-muted-foreground">— {entry.title}</span>
                </div>
                <div
                  className="text-muted-foreground [&_ul]:list-disc [&_ul]:list-inside [&_ul]:ml-3 [&_ul]:space-y-0.5 [&_li]:text-sm [&_a]:text-primary [&_a]:underline"
                  dangerouslySetInnerHTML={{ __html: entry.content }}
                />
                {idx < changelog.entries.length - 1 && (
                  <div className="border-t my-3" />
                )}
              </div>
            ))}
            {!changelog && (
              <div className="text-muted-foreground">加载中...</div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
