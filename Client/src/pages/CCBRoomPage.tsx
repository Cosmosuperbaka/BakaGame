import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  Bot,
  MessageSquare,
  Play,
  Settings,
  UserRound,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Switch } from "@/components/ui/Switch";
import { ChatPanel } from "@/components/common/ChatPanel";
import { Seo } from "@/components/common/Seo";
import { PLAYER_COLUMN_WIDTH } from "@/components/common/PlayerStatusPill";
import { PlayerList } from "@/components/ccb/PlayerList";
import { backdrop, duration, ease, spring } from "@/lib/Motion";
import { getSavedUsername, saveUsername } from "@/lib/Storage";
import { CCBWs } from "@/lib/CCBWs";
import { useCCBStore } from "@/stores/UseCCBStore";
import { isValidRoomId, ROOM_ID_TEST_MODE } from "@/types";
import type { CCBPlayerView, CCBRoomSnapshot } from "@/types";

type MobilePanel = "none" | "players" | "chat";

export default function CCBRoomPage() {
  const { roomId: paramsRoomId = "" } = useParams();
  const navigate = useNavigate();
  const roomId = paramsRoomId.trim();

  const snapshot = useCCBStore((state) => state.snapshot);
  const privateState = useCCBStore((state) => state.privateState);
  const roomClosedAt = useCCBStore((state) => state.roomClosedAt);
  const createRoom = useCCBStore((state) => state.createRoom);
  const joinRoom = useCCBStore((state) => state.joinRoom);
  const reconnectRoom = useCCBStore((state) => state.reconnectRoom);
  const leaveRoom = useCCBStore((state) => state.leaveRoom);
  const sendCommand = useCCBStore((state) => state.sendCommand);
  const setNotice = useCCBStore((state) => state.setNotice);

  const [nameDraft, setNameDraft] = useState("");
  const [needsName, setNeedsName] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [pendingJoinName, setPendingJoinName] = useState("");
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("none");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [joining, setJoining] = useState(true);
  const [botPending, setBotPending] = useState(false);
  const leavingRef = useRef(false);

  const me = snapshot?.players.find((player) => player.id === privateState?.playerId);
  const isHost = Boolean(me?.isHost);
  const isTestRoom = roomId.toLowerCase() === ROOM_ID_TEST_MODE.toLowerCase();
  const exitPath = "/ccb";

  const enterWithName = useCallback(
    async (name: string, password?: string) => {
      setJoining(true);
      try {
        await joinRoom(roomId, name, password);
        setNeedsPassword(false);
        setJoining(false);
      } catch (error) {
        const appError = error as { code?: string; message?: string };
        if (appError.code === "ROOM_NOT_FOUND") {
          // 直连不存在的房间号视为「我要开这间房」，与另两个游戏的直接链接体验一致。
          try {
            await createRoom({
              roomId,
              name: isTestRoom ? "CCB 测试房" : `${name}的房间`,
              visibility: "public",
              allowSpectators: true,
              userName: name,
            });
            setJoining(false);
            return;
          } catch (createError) {
            setNotice((createError as { message?: string }).message ?? "创建房间失败", "error");
          }
        } else if (
          appError.code === "PASSWORD_INCORRECT" ||
          appError.code === "PASSWORD_REQUIRED"
        ) {
          setPendingJoinName(name);
          setPasswordDraft("");
          setNeedsPassword(true);
          setJoining(false);
          return;
        } else {
          setNotice(appError.message ?? "加入房间失败", "error");
        }
        navigate(exitPath, { replace: true });
      }
    },
    [
      createRoom,
      isTestRoom,
      joinRoom,
      navigate,
      roomId,
      setJoining,
      setNeedsPassword,
      setNotice,
      setPasswordDraft,
      setPendingJoinName,
    ],
  );

  useEffect(() => {
    if (!roomId) return;
    if (!isValidRoomId(roomId)) {
      setNotice("房间号无效，请检查链接", "error");
      navigate(exitPath, { replace: true });
      return;
    }

    let cancelled = false;
    const tryEnter = async () => {
      setJoining(true);
      try {
        await CCBWs.waitForConnection(8_000);
      } catch {
        if (!cancelled) {
          setNotice("连接服务器超时，请刷新重试", "error");
          navigate(exitPath, { replace: true });
        }
        return;
      }
      if (cancelled) return;
      if (await reconnectRoom(roomId)) {
        if (!cancelled) setJoining(false);
        return;
      }
      if (cancelled || useCCBStore.getState().roomClosedAt) return;
      const savedName = getSavedUsername().trim();
      if (!savedName) {
        setJoining(false);
        setNameDraft("");
        setNeedsName(true);
        return;
      }
      await enterWithName(savedName);
    };
    void tryEnter();
    return () => {
      cancelled = true;
    };
  }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!roomClosedAt || leavingRef.current) return;
    navigate(exitPath, { replace: true });
  }, [exitPath, navigate, roomClosedAt]);

  const handleLeave = useCallback(async () => {
    leavingRef.current = true;
    await leaveRoom();
    navigate(exitPath, { replace: true });
  }, [exitPath, leaveRoom, navigate]);

  const handleSendChatMessage = useCallback(
    async (text: string) => {
      try {
        await sendCommand("ccb.chat.send", { text });
      } catch (error) {
        setNotice((error as { message: string }).message, "error");
      }
    },
    [sendCommand, setNotice],
  );

  const handleToggleReady = useCallback(async () => {
    try {
      await sendCommand("ccb.player.setReady", { ready: !me?.isReady });
    } catch (error) {
      setNotice((error as { message: string }).message, "error");
    }
  }, [me, sendCommand, setNotice]);

  const handleBots = useCallback(
    async (add: boolean) => {
      setBotPending(true);
      try {
        await sendCommand(add ? "ccb.test.addBot" : "ccb.test.removeBot", add ? { count: 1 } : {});
      } catch (error) {
        setNotice((error as { message: string }).message, "error");
      } finally {
        setBotPending(false);
      }
    },
    [sendCommand, setBotPending, setNotice],
  );

  const handleSubmitName = useCallback(async () => {
    const name = nameDraft.trim();
    if (!name) {
      setNotice("用户名不能为空", "error");
      return;
    }
    saveUsername(name);
    setNeedsName(false);
    await enterWithName(name);
  }, [enterWithName, nameDraft, setNeedsName, setNotice]);

  const handleSubmitPassword = useCallback(async () => {
    setNeedsPassword(false);
    await enterWithName(pendingJoinName, passwordDraft);
  }, [enterWithName, passwordDraft, pendingJoinName, setNeedsPassword]);

  if (!snapshot || !privateState) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-background">
        <Seo path="/ccb" description="CCB 猜动漫角色房间" indexable={false} />
        <p className="text-sm text-muted-foreground">{joining ? "正在进入房间…" : "房间不可用"}</p>
      </div>
    );
  }

  const players = snapshot.players;
  const activeCount = players.filter((player) => player.membership === "active").length;

  return (
    <>
      <Seo path="/ccb" description="CCB 猜动漫角色房间" indexable={false} />
      <div className="flex h-full min-h-0 flex-col bg-background">
        <header className="grid h-14 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 bg-background px-2 md:grid-cols-3 md:gap-2 md:px-4 lg:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void handleLeave()}
              className="shrink-0"
              aria-label="离开房间"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <span className="hidden truncate text-base font-semibold md:block">{snapshot.name}</span>
            <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">
              #{snapshot.roomId}
            </span>
          </div>

          <div className="flex min-w-0 items-center justify-center gap-1 overflow-hidden md:gap-2">
            <Badge
              variant="outline"
              className="shrink-0 border-border/80 text-xs font-normal text-muted-foreground"
            >
              {snapshot.phase === "waiting" ? "等待中" : "游戏中"}
            </Badge>
            {snapshot.testMode ? (
              <Badge
                variant="outline"
                className="shrink-0 border-border/80 text-xs font-normal text-muted-foreground"
              >
                测试房
              </Badge>
            ) : null}
          </div>

          <div className="flex min-w-0 items-center justify-end gap-1 md:gap-2">
            <div className="flex items-center gap-1.5 tabular-nums text-xs text-muted-foreground">
              <Users className="h-4 w-4 text-muted-foreground/70" />
              <span>
                {activeCount}/{players.length}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="玩家列表"
              onClick={() => setMobilePanel((panel) => (panel === "players" ? "none" : "players"))}
            >
              <UserRound className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="聊天"
              onClick={() => setMobilePanel((panel) => (panel === "chat" ? "none" : "chat"))}
            >
              <MessageSquare className="h-5 w-5" />
            </Button>
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1 gap-2 overflow-hidden px-2 pb-2 md:gap-3 md:px-3 md:pb-3">
          <section className="relative flex min-h-0 min-w-0 flex-1 gap-2 overflow-hidden md:gap-3">
            <div
              className="hidden shrink-0 md:block"
              style={{ width: PLAYER_COLUMN_WIDTH }}
              aria-hidden="true"
            />
            <motion.aside
              className="absolute inset-y-0 left-0 z-30 hidden flex-col rounded-md border bg-panel md:flex"
              initial={false}
              animate={{ width: PLAYER_COLUMN_WIDTH, boxShadow: "var(--shadow-2xs)" }}
              transition={{ width: spring.settle, boxShadow: { duration: duration.base } }}
            >
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-md">
                <PlayerList
                  players={players}
                  myPlayerId={privateState.playerId}
                  isHost={isHost}
                  phase={snapshot.phase}
                  allowSpectators={snapshot.allowSpectators}
                />
              </div>
            </motion.aside>

            <main className="isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-panel">
              <CCBGameArea
                snapshot={snapshot}
                me={me}
                isHost={isHost}
                isTestRoom={isTestRoom}
                botPending={botPending}
                onToggleReady={handleToggleReady}
                onBots={handleBots}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            </main>
          </section>

          <aside className="hidden min-h-0 w-80 shrink-0 flex-col overflow-hidden rounded-md border bg-panel lg:flex">
            <ChatPanel
              messages={snapshot.chat ?? []}
              players={players}
              myPlayerId={privateState.playerId}
              onSendMessage={handleSendChatMessage}
            />
          </aside>

          <AnimatePresence>
            {mobilePanel === "players" ? (
              <motion.aside
                initial={{ x: "-100%" }}
                animate={{ x: 0, transition: spring.swift }}
                exit={{ x: "-100%", transition: { duration: duration.quick, ease: ease.inOut } }}
                className="absolute inset-y-0 left-0 z-30 flex w-72 min-w-0 flex-col overflow-hidden border-r bg-panel shadow-xl md:hidden"
              >
                <PlayerList
                  players={players}
                  myPlayerId={privateState.playerId}
                  isHost={isHost}
                  phase={snapshot.phase}
                  allowSpectators={snapshot.allowSpectators}
                />
              </motion.aside>
            ) : null}
          </AnimatePresence>

          <AnimatePresence>
            {mobilePanel === "chat" ? (
              <motion.aside
                initial={{ x: "100%" }}
                animate={{ x: 0, transition: spring.swift }}
                exit={{ x: "100%", transition: { duration: duration.quick, ease: ease.inOut } }}
                className="absolute inset-y-0 right-0 z-30 flex w-80 flex-col overflow-hidden border-l bg-panel shadow-xl lg:hidden"
              >
                <ChatPanel
                  messages={snapshot.chat ?? []}
                  players={players}
                  myPlayerId={privateState.playerId}
                  onSendMessage={handleSendChatMessage}
                />
              </motion.aside>
            ) : null}
          </AnimatePresence>

          <AnimatePresence>
            {mobilePanel !== "none" ? (
              <motion.div
                variants={backdrop}
                initial="initial"
                animate="animate"
                exit="exit"
                className="absolute inset-0 z-20 bg-foreground/20 md:hidden"
                onClick={() => setMobilePanel("none")}
              />
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      <Dialog open={needsName} onOpenChange={() => undefined}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>设置用户名</DialogTitle>
            <DialogDescription>进入房间前需要一个在房内显示的名字</DialogDescription>
          </DialogHeader>
          <Input
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            placeholder="请输入用户名"
            className="h-10 text-base"
            maxLength={20}
            onKeyDown={(event) => event.key === "Enter" && void handleSubmitName()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => navigate(exitPath, { replace: true })}>
              返回大厅
            </Button>
            <Button onClick={handleSubmitName}>进入房间</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={needsPassword} onOpenChange={() => setNeedsPassword(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>输入房间密码</DialogTitle>
            <DialogDescription>该房间为私密房间，需要密码才能进入</DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            value={passwordDraft}
            onChange={(event) => setPasswordDraft(event.target.value)}
            placeholder="请输入密码"
            className="h-10 text-base"
            onKeyDown={(event) => event.key === "Enter" && void handleSubmitPassword()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNeedsPassword(false)}>取消</Button>
            <Button onClick={handleSubmitPassword}>加入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RoomSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        snapshot={snapshot}
      />
    </>
  );
}

interface CCBGameAreaProps {
  snapshot: CCBRoomSnapshot;
  me?: CCBPlayerView;
  isHost: boolean;
  isTestRoom: boolean;
  botPending: boolean;
  onToggleReady: () => Promise<void>;
  onBots: (add: boolean) => Promise<void>;
  onOpenSettings: () => void;
}

function CCBGameArea({
  snapshot,
  me,
  isHost,
  isTestRoom,
  botPending,
  onToggleReady,
  onBots,
  onOpenSettings,
}: CCBGameAreaProps) {
  const isSpectator = me?.membership === "spectator";

  return (
    <div className="scrollbar-hidden flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-4 py-8">
      <div className="flex flex-col items-center gap-1 text-center">
        <span className="font-mono text-3xl font-semibold tracking-[0.3em] text-foreground/80">
          {snapshot.roomId}
        </span>
        <span className="text-sm text-muted-foreground">
          {isSpectator
            ? "你正在旁观本房间"
            : isHost
              ? "等待你开始本局"
              : "等待房主开始本局"}
        </span>
      </div>

      {isSpectator ? null : (
        <Button
          variant={me?.isReady ? "secondary" : "default"}
          onClick={() => void onToggleReady()}
        >
          {me?.isReady ? "取消准备" : "准备"}
        </Button>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2">
        {isHost ? (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onOpenSettings}>
            <Settings className="h-3.5 w-3.5" />
            房间设置
          </Button>
        ) : null}
        {isHost && isTestRoom ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={botPending}
              onClick={() => void onBots(true)}
            >
              <Bot className="h-3.5 w-3.5" />
              增加人机
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={botPending}
              onClick={() => void onBots(false)}
            >
              移除人机
            </Button>
          </>
        ) : null}
        <Button size="sm" className="gap-1.5" disabled title="在线对局功能开发中">
          <Play className="h-3.5 w-3.5" />
          开始游戏
        </Button>
      </div>

      <p className="max-w-md text-center text-xs text-muted-foreground/70">
        在线对局（出题、逐字段反馈与计分）正在开发中；当前可以创建房间、聊天、准备与旁观。
      </p>
    </div>
  );
}

function RoomSettingsDialog({
  open,
  onOpenChange,
  snapshot,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: CCBRoomSnapshot;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <RoomSettingsForm snapshot={snapshot} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * 表单草稿挂在 Dialog 内容内部：Radix 关闭时会卸载内容，因此每次打开都从当前快照重新初始化，
 * 不需要用 effect 把 props 同步进 state。
 */
function RoomSettingsForm({
  snapshot,
  onClose,
}: {
  snapshot: CCBRoomSnapshot;
  onClose: () => void;
}) {
  const updateSettings = useCCBStore((state) => state.updateSettings);
  const setNotice = useCCBStore((state) => state.setNotice);
  const [name, setName] = useState(snapshot.name);
  const [isPrivate, setIsPrivate] = useState(snapshot.visibility === "private");
  const [password, setPassword] = useState("");
  const [allowSpectators, setAllowSpectators] = useState(snapshot.allowSpectators);
  const [pending, setPending] = useState(false);

  const dirty =
    name.trim() !== snapshot.name ||
    isPrivate !== (snapshot.visibility === "private") ||
    allowSpectators !== snapshot.allowSpectators ||
    password.trim().length > 0;

  const handleSave = async () => {
    setPending(true);
    try {
      await updateSettings({
        name: name.trim() || snapshot.name,
        visibility: isPrivate ? "private" : "public",
        ...(isPrivate && password.trim() ? { password: password.trim() } : {}),
        allowSpectators,
      });
      onClose();
    } catch (error) {
      setNotice((error as { message: string }).message, "error");
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>房间设置</DialogTitle>
        <DialogDescription>修改房间名、可见性与旁观开关</DialogDescription>
      </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="ccb-room-name">房间名</Label>
            <Input
              id="ccb-room-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={40}
              className="h-10"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col">
              <Label htmlFor="ccb-room-private">私密房间</Label>
              <span className="text-xs text-muted-foreground">需要密码才能加入</span>
            </div>
            <Switch
              id="ccb-room-private"
              checked={isPrivate}
              onCheckedChange={setIsPrivate}
            />
          </div>

          {isPrivate ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="ccb-room-password">
                {snapshot.hasPassword ? "新密码（留空表示不修改）" : "密码"}
              </Label>
              <Input
                id="ccb-room-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                maxLength={64}
                className="h-10"
              />
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col">
              <Label htmlFor="ccb-room-spectators">允许旁观</Label>
              <span className="text-xs text-muted-foreground">
                {snapshot.allowSpectators ? "新玩家可以旁观" : "新玩家只能作为正式玩家加入"}
              </span>
            </div>
            <Switch
              id="ccb-room-spectators"
              checked={allowSpectators}
              onCheckedChange={setAllowSpectators}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button disabled={pending || !dirty} onClick={() => void handleSave()}>
            保存
          </Button>
        </DialogFooter>
    </>
  );
}
