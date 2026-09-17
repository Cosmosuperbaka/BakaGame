import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  Eye,
  Headphones,
  Menu,
  MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Seo } from "@/components/common/Seo";
import { ChatPanel } from "@/components/common/ChatPanel";
import { PLAYER_COLUMN_WIDTH } from "@/components/common/PlayerStatusPill";
import { PlayerList } from "@/components/songuessr/PlayerList";
import { VolumeControl } from "@/components/songuessr/layout/VolumeControl";
import { SongGameArea } from "@/components/songuessr/phases/SongGameStage";
import { useAudioClipPlayer } from "@/hooks/UseAudioClipPlayer";
import { useSongRoomLifecycle } from "@/hooks/UseSongRoomLifecycle";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import {
  backdrop,
  duration,
  ease,
  spinner,
  spring,
} from "@/lib/Motion";

export default function SonGuessrRoomPage({ solo = false }: { solo?: boolean }) {
  const navigate = useNavigate();
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const connected = useSonGuessrStore((state) => state.connected);

  const {
    roomId,
    snapshot,
    privateState,
    joining,
    needsName,
    nameDraft,
    setNameDraft,
    needsPassword,
    passwordDraft,
    setPasswordDraft,
    handleConfirmName,
    handleConfirmPassword,
    runCommand,
    isPending,
    leave,
    sendCommand,
  } = useSongRoomLifecycle({ solo });

  const isPlayingPhase = snapshot?.phase === "playing";
  const isRoundResultPhase = snapshot?.phase === "roundResult";
  const round = snapshot?.currentRound;
  const roundSummary = snapshot?.roundSummary;

  const currentPhaseRoundNumber = isPlayingPhase
    ? round?.roundNumber
    : isRoundResultPhase
      ? roundSummary?.roundNumber
      : undefined;

  const currentAudioUrl = isPlayingPhase
    ? round?.audioUrl
    : isRoundResultPhase
      ? roundSummary?.song?.audioUrl
      : undefined;

  const currentClipStartTime = isPlayingPhase
    ? round?.lyricClip?.startTime
    : isRoundResultPhase
      ? (roundSummary?.song?.chorus?.startTime ?? 0)
      : undefined;

  const currentClipEndTime = isPlayingPhase
    ? round?.lyricClip?.endTime
    : isRoundResultPhase
      ? roundSummary?.song?.chorus?.endTime
      : undefined;

  const {
    audioRef,
    volume,
    setVolume,
    audioStatus,
    audioPlaybackState,
    playAudio,
    retryAudio,
  } = useAudioClipPlayer({
    roomId,
    phase: snapshot?.phase,
    currentPhaseRoundNumber,
    currentAudioUrl,
    currentClipStartTime,
    currentClipEndTime,
    isPlayingPhase,
    sendCommand,
  });

  const [searchMode, setSearchMode] = useState<"submit" | "guess" | null>(null);
  const [mobilePanel, setMobilePanel] = useState<"none" | "players" | "chat">("none");
  const [clock, setClock] = useState(() => Date.now());

  const guessDeadlineAt = privateState?.guessDeadlineAt;
  useEffect(() => {
    if (!guessDeadlineAt) return;
    const timer = window.setInterval(() => setClock(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [guessDeadlineAt]);

  const secondsLeft = guessDeadlineAt
    ? Math.max(0, Math.ceil((guessDeadlineAt - clock) / 1_000))
    : 0;

  const handleSendChatMessage = useCallback(
    async (chatText: string) => {
      try {
        await sendCommand("song.chat.send", { text: chatText });
      } catch (error) {
        setNotice((error as { message: string }).message, "error");
      }
    },
    [sendCommand, setNotice],
  );

  const audioNode = (
    <audio
      ref={(node) => {
        audioRef.current = node;
        if (node) node.volume = volume;
      }}
      className="hidden"
      preload="auto"
      playsInline
      crossOrigin="anonymous"
    />
  );

  const seoNode = (
    <Seo
      description="BakaGame 听歌猜歌对局页面，内容由服务端实时状态驱动。"
      path={solo ? "/songuessr/solo" : `/songuessr/room/${roomId}`}
      indexable={false}
    />
  );

  if (joining || needsName || needsPassword || !snapshot || !privateState || snapshot.roomId !== roomId) {
    return (
      <>
        {seoNode}
        {audioNode}
        <div className="flex h-full min-h-0 items-center justify-center overflow-hidden bg-background">
          {!needsName && !needsPassword ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: duration.base, ease: ease.out }}
              className="flex flex-col items-center gap-3"
            >
              <motion.div
                className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent"
                {...spinner}
              />
              <span className="text-sm text-muted-foreground">正在加入房间...</span>
            </motion.div>
          ) : null}

          <Dialog
            open={needsName}
            onOpenChange={(open) => {
              if (!open) navigate("/songuessr", { replace: true });
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>设置用户名</DialogTitle>
                <DialogDescription>
                  进入房间 &ldquo;{roomId}&rdquo; 前先取个名字，其他玩家会看到它。
                </DialogDescription>
              </DialogHeader>
              <Input
                autoFocus
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void handleConfirmName()}
                placeholder="用户名"
                maxLength={20}
              />
              <DialogFooter>
                <Button variant="ghost" onClick={() => navigate("/songuessr", { replace: true })}>
                  返回大厅
                </Button>
                <Button onClick={() => void handleConfirmName()} disabled={!nameDraft.trim()}>
                  进入房间
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog
            open={needsPassword}
            onOpenChange={(open) => {
              if (!open) navigate("/songuessr", { replace: true });
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>输入房间密码</DialogTitle>
                <DialogDescription>该链接指向一个私密房间。</DialogDescription>
              </DialogHeader>
              <Input
                autoFocus
                type="password"
                value={passwordDraft}
                onChange={(event) => setPasswordDraft(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void handleConfirmPassword()}
                placeholder="请输入密码"
              />
              <DialogFooter>
                <Button variant="ghost" onClick={() => navigate("/songuessr", { replace: true })}>
                  返回大厅
                </Button>
                <Button onClick={() => void handleConfirmPassword()} disabled={!passwordDraft.trim()}>
                  加入房间
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </>
    );
  }

  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  const isHost = snapshot.hostPlayerId === privateState.playerId;
  const isSpectator = me?.membership === "spectator";

  return (
    <>
      {seoNode}
      {audioNode}
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <header className="grid h-14 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 bg-background px-2 md:grid-cols-3 md:gap-2 md:px-4 lg:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void leave()}
              className="shrink-0"
              aria-label="离开房间"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <span className="hidden truncate text-base font-semibold md:block">
              {solo ? "单人模式" : snapshot.name}
            </span>
            {solo ? null : (
              <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">
                #{snapshot.roomId}
              </span>
            )}
          </div>

          <div className="flex min-w-0 items-center justify-center gap-1 overflow-hidden md:gap-2">
            {snapshot.roundNumber > 0 ? (
              <span className="shrink-0 text-xs font-semibold text-muted-foreground sm:text-sm">
                第 {snapshot.roundNumber} 轮
              </span>
            ) : null}
            {privateState.isSubmitter ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs font-semibold text-foreground">
                <Headphones className="h-3.5 w-3.5" />出题人视角
              </span>
            ) : null}
            {isSpectator ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                <Eye className="h-3.5 w-3.5" />旁观视角
              </span>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-0 md:gap-1">
            {!connected ? (
              <span className="mr-1 hidden shrink-0 animate-pulse text-xs text-destructive sm:inline">
                断线中...
              </span>
            ) : null}
            <VolumeControl volume={volume} onVolumeChange={setVolume} />
            {!solo ? (
              <div className="flex gap-1 md:hidden">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9"
                  aria-label="玩家列表"
                  aria-expanded={mobilePanel === "players"}
                  onClick={() => setMobilePanel(mobilePanel === "players" ? "none" : "players")}
                >
                  <Menu className="h-5 w-5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9"
                  aria-label="聊天"
                  aria-expanded={mobilePanel === "chat"}
                  onClick={() => setMobilePanel(mobilePanel === "chat" ? "none" : "chat")}
                >
                  <MessageSquare className="h-5 w-5" />
                </Button>
              </div>
            ) : null}
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1 gap-2 overflow-hidden px-2 pb-2 md:gap-3 md:px-3 md:pb-3">
          <section className="relative flex min-h-0 min-w-0 flex-1 gap-2 overflow-hidden md:gap-3">
            {!solo ? (
              <>
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
                      players={snapshot.players}
                      myPlayerId={privateState.playerId}
                      isHost={isHost}
                      phase={snapshot.phase}
                      allowSpectators={snapshot.allowSpectators}
                    />
                  </div>
                </motion.aside>
              </>
            ) : null}

            <main className="isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-panel">
              <SongGameArea
                snapshot={snapshot}
                privateState={privateState}
                me={me}
                isHost={isHost}
                secondsLeft={secondsLeft}
                volume={volume}
                onVolumeChange={setVolume}
                audioStatus={audioStatus}
                audioPlaybackState={audioPlaybackState}
                onPlayAudio={() => void playAudio()}
                onRetryAudio={retryAudio}
                openSearch={setSearchMode}
                searchMode={searchMode}
                closeSearch={() => setSearchMode(null)}
                onSelectSearchSong={async (songId, mode) => {
                  if (snapshot.settings.questionType === "anime") {
                    await sendCommand(mode === "submit" ? "song.game.submitAnime" : "song.game.guessAnime", { subjectId: songId });
                  } else {
                    await sendCommand(mode === "submit" ? "song.game.submitSong" : "song.game.guess", { songId });
                  }
                }}
                run={runCommand}
                isPending={isPending}
              />
            </main>
          </section>

          {!solo ? (
            <aside className="hidden min-h-0 w-80 shrink-0 flex-col overflow-hidden rounded-md border bg-panel lg:flex">
              <ChatPanel
                messages={snapshot.chat ?? []}
                players={snapshot.players}
                myPlayerId={privateState.playerId}
                onSendMessage={handleSendChatMessage}
              />
            </aside>
          ) : null}

          <AnimatePresence>
            {mobilePanel === "players" ? (
              <motion.aside
                initial={{ x: "-100%" }}
                animate={{ x: 0, transition: spring.swift }}
                exit={{ x: "-100%", transition: { duration: duration.quick, ease: ease.inOut } }}
                className="absolute inset-y-0 left-0 z-30 flex w-72 min-w-0 flex-col overflow-hidden border-r bg-panel shadow-xl md:hidden"
              >
                <PlayerList
                  players={snapshot.players}
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
                  players={snapshot.players}
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
    </>
  );
}
