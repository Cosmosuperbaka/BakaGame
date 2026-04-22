import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  RefreshCw,
  Plus,
  Lock,
  Users,
  Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { useGame } from "@/contexts/GameContext";
import { getSavedUsername, saveUsername } from "@/lib/cookie";
import { PHASE_LABELS, randomRoomId } from "@/lib/helpers";
import faviconUrl from "@/assets/favicon.png";
import type { RoomSummaryItem } from "@/types";

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

// 列表项的进入动画：轻微位移 + 极短错开，避免齐刷刷的"AI 感"。
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
  const { state, createRoom, joinRoom, reconnectRoom, subscribeLobby, addToast } = useGame();
  const [userName, setUserName] = useState(getSavedUsername);
  const [createOpen, setCreateOpen] = useState(false);
  const [joinTarget, setJoinTarget] = useState<RoomSummaryItem | null>(null);
  const [joinPassword, setJoinPassword] = useState("");
  const [versionOpen, setVersionOpen] = useState(false);
  const [changelog, setChangelog] = useState<ChangelogData | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // 静默保存用户名
  useEffect(() => {
    if (userName.trim()) saveUsername(userName.trim());
  }, [userName]);

  // 获取更新日志
  useEffect(() => {
    fetch("/changelog.json")
      .then((r) => r.json())
      .then((data: ChangelogData) => setChangelog(data))
      .catch(() => {});
  }, []);

  // 手动刷新房间列表
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

  // 加入房间
  const handleJoinRoom = useCallback(
    async (room: RoomSummaryItem) => {
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
      {/* 标题区 — 仅标题 */}
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

      {/* 主内容区 */}
      <main className="flex-1 w-full max-w-3xl mx-auto px-6 md:px-10 pb-10">
        {/* 操作栏 */}
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

        {/* 房间列表 */}
        <div className="space-y-3">
          <AnimatePresence mode="popLayout" initial={false}>
            {state.rooms.length === 0 ? (
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
              state.rooms.map((room, i) => (
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
                            {room.testMode && (
                              <Badge variant="secondary" className="text-xs py-0.5">
                                测试
                              </Badge>
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

      {/* 创建房间弹窗 — 无 roomId 字段，自动随机 */}
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

      {/* 密码输入弹窗 */}
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

      {/* 版本信息弹窗 */}
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

// ==================== 创建房间弹窗（无 roomId 字段） ====================

function CreateRoomDialog({
  open,
  onOpenChange,
  defaultName,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  onCreate: (params: {
    name: string;
    visibility: "public" | "private";
    password?: string;
    allowSpectators: boolean;
  }) => Promise<void>;
}) {
  const [roomName, setRoomName] = useState(defaultName);
  const [isPrivate, setIsPrivate] = useState(false);
  const [password, setPassword] = useState("");
  const [allowSpectators, setAllowSpectators] = useState(true);
  const [loading, setLoading] = useState(false);
  const { addToast } = useGame();

  useEffect(() => {
    if (open) {
      setRoomName(defaultName);
      setIsPrivate(false);
      setPassword("");
      setAllowSpectators(true);
    }
  }, [open, defaultName]);

  const handleCreate = async () => {
    if (isPrivate && !password.trim()) {
      addToast("私密房间需要设置密码", "error");
      return;
    }
    setLoading(true);
    try {
      await onCreate({
        name: roomName || "新房间",
        visibility: isPrivate ? "private" : "public",
        password: isPrivate ? password : undefined,
        allowSpectators,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建房间</DialogTitle>
          <DialogDescription>设置房间参数</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div className="space-y-2">
            <Label className="text-sm">房间名称</Label>
            <Input value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="输入房间名称" className="h-10" />
          </div>
          <div className="flex items-center justify-between py-1">
            <Label className="text-sm">私密房间</Label>
            <Switch checked={isPrivate} onCheckedChange={setIsPrivate} />
          </div>
          <AnimatePresence>
            {isPrivate && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25, ease: "easeInOut" }}
                className="overflow-hidden"
              >
                <div className="space-y-2 pb-1">
                  <Label className="text-sm">房间密码</Label>
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="设置房间密码" className="h-10" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="flex items-center justify-between py-1">
            <Label className="text-sm">允许旁观</Label>
            <Switch checked={allowSpectators} onCheckedChange={setAllowSpectators} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleCreate} disabled={loading}>
            {loading ? "创建中..." : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
