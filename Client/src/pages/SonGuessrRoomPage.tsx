import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Eye,
  Flag,
  FlaskConical,
  Gamepad2,
  Globe,
  Headphones,
  Link,
  Lock,
  Menu,
  MessageSquare,
  Minus,
  Music2,
  Play,
  Plus,
  RotateCcw,
  Settings,
  UserCheck,
  Users,
  Volume2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Label } from "@/components/ui/Label";
import { Switch } from "@/components/ui/Switch";
import { ScrollArea } from "@/components/ui/ScrollArea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { PLAYER_COLUMN_WIDTH } from "@/components/whoisfaker/layout/PlayerList";
import { SongChatPanel } from "@/components/songguessr/SongChatPanel";
import { SongAccountSettings } from "@/components/songguessr/SongAccountSettings";
import { SongPlayerList } from "@/components/songguessr/SongPlayerList";
import { SongSearchDialog } from "@/components/songguessr/SongSearchDialog";
import { getSavedUsername, saveUsername } from "@/lib/Storage";
import { sonGuessrWs as songGuessrWs } from "@/lib/SonGuessrWs";
import {
  clearStoredSongMusicSession,
  getStoredSongMusicSession,
  saveSongMusicSession,
  SON_MUSIC_SESSION_CHANGED as SONG_MUSIC_SESSION_CHANGED,
} from "@/lib/SonGuessrMusicSession";
import {
  backdrop,
  collapsible,
  duration,
  ease,
  headerTappable,
  listContainer,
  listItem,
  phaseSwap,
  pressable,
  selectable,
  spinner,
  spring,
} from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { useAutoSave } from "@/hooks/UseAutoSave";
import { useSonGuessrStore as useSongGuessrStore } from "@/stores/UseSonGuessrStore";
import { isValidRoomId, ROOM_ID_TEST_MODE } from "@/types";
import type {
  SongArtistFilter,
  SongArtistSearchResult,
  SongPlaylistInfo,
  SongGuessAttempt,
  SongGuessDirection,
  SonGuessrMusicAccount as SongGuessrMusicAccount,
  SonGuessrPrivateState as SongGuessrPrivateState,
  SonGuessrPlayerView as SongGuessrPlayerView,
  SonGuessrRoomSnapshot as SongGuessrRoomSnapshot,
} from "@/types";

const SONG_VOLUME_KEY = "songuessr_volume";

const directionSymbol: Record<SongGuessDirection, string> = {
  higher: "↑",
  lower: "↓",
  equal: "=",
  unknown: "?",
};

export default function SonGuessrRoomPage() {
  const navigate = useNavigate();
  const { roomId: routeRoomId = "" } = useParams();
  const roomId = routeRoomId.trim().toLowerCase() === ROOM_ID_TEST_MODE.toLowerCase()
    ? ROOM_ID_TEST_MODE
    : routeRoomId.trim();
  const snapshot = useSongGuessrStore((state) => state.snapshot);
  const privateState = useSongGuessrStore((state) => state.privateState);
  const storedRoomId = useSongGuessrStore((state) => state.roomId);
  const roomClosedAt = useSongGuessrStore((state) => state.roomClosedAt);
  const connected = useSongGuessrStore((state) => state.connected);
  const createRoom = useSongGuessrStore((state) => state.createRoom);
  const joinRoom = useSongGuessrStore((state) => state.joinRoom);
  const reconnectRoom = useSongGuessrStore((state) => state.reconnectRoom);
  const leaveRoom = useSongGuessrStore((state) => state.leaveRoom);
  const sendCommand = useSongGuessrStore((state) => state.sendCommand);
  const setNotice = useSongGuessrStore((state) => state.setNotice);
  const alreadyInRoom = storedRoomId === roomId && snapshot?.roomId === roomId;
  const [joining, setJoining] = useState(!alreadyInRoom);
  const [needsName, setNeedsName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [pendingJoinName, setPendingJoinName] = useState("");
  const [searchMode, setSearchMode] = useState<"submit" | "guess" | null>(null);
  const [mobilePanel, setMobilePanel] = useState<"none" | "players" | "chat">("none");
  const [volume, setVolume] = useState(() => {
    const saved = Number(window.localStorage.getItem(SONG_VOLUME_KEY));
    return Number.isFinite(saved) ? Math.max(0, Math.min(1, saved)) : 0.65;
  });
  const [audioStatus, setAudioStatus] = useState<"loading" | "ready" | "error">("loading");
  const [audioPlaybackState, setAudioPlaybackState] = useState<"idle" | "playing" | "completed">("idle");
  const [audioRetryToken, setAudioRetryToken] = useState(0);
  const [musicSessionRevision, setMusicSessionRevision] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioReadyKey = useRef<string | null>(null);
  const audioAutoPlayKey = useRef<string | null>(null);
  const sendCommandRef = useRef(sendCommand);
  const leavingRef = useRef(false);
  const volumeRef = useRef(volume);
  const mountedMusicSessionRef = useRef<string | null>(null);

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
          try {
            await createRoom({
              roomId,
              name: roomId === ROOM_ID_TEST_MODE ? "Songuessr 测试房" : `${name}的房间`,
              visibility: "public",
              allowSpectators: true,
              userName: name,
            });
            setJoining(false);
            return;
          } catch (createError) {
            setNotice((createError as { message?: string }).message ?? "创建房间失败", "error");
          }
        } else if (appError.code === "PASSWORD_INCORRECT" || appError.code === "PASSWORD_REQUIRED") {
          setPendingJoinName(name);
          setPasswordDraft("");
          setNeedsPassword(true);
          setJoining(false);
          return;
        } else {
          setNotice(appError.message ?? "加入房间失败", "error");
        }
        navigate("/songuessr", { replace: true });
      }
    },
    [createRoom, joinRoom, navigate, roomId, setNotice],
  );

  useEffect(() => {
    if (!roomId || alreadyInRoom) return;
    if (!isValidRoomId(roomId)) {
      setNotice("房间号无效，请检查链接", "error");
      navigate("/songuessr", { replace: true });
      return;
    }

    let cancelled = false;
    const tryEnter = async () => {
      setJoining(true);
      try {
        await songGuessrWs.waitForConnection(8_000);
      } catch {
        if (!cancelled) {
          setNotice("连接服务器超时，请刷新重试", "error");
      navigate("/songuessr", { replace: true });
        }
        return;
      }
      if (cancelled) return;
      if (await reconnectRoom(roomId)) {
        if (!cancelled) setJoining(false);
        return;
      }
      if (cancelled || useSongGuessrStore.getState().roomClosedAt) return;
      const savedName = getSavedUsername();
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
    if (roomClosedAt && !leavingRef.current) navigate("/songuessr", { replace: true });
  }, [navigate, roomClosedAt]);

  const round = snapshot?.currentRound;
  const roundNumber = round?.roundNumber;
  const roundAudioUrl = round?.audioUrl;
  const lyricStartTime = round?.lyricClip.startTime;
  const lyricEndTime = round?.lyricClip.endTime;

  useEffect(() => {
    sendCommandRef.current = sendCommand;
  }, [sendCommand]);

  useEffect(() => {
    const audio = audioRef.current;
    if (
      !audio ||
      roundNumber === undefined ||
      !roundAudioUrl ||
      lyricStartTime === undefined ||
      lyricEndTime === undefined
    ) return;
    const loadKey = `${roomId}:${roundNumber}:${roundAudioUrl}:${lyricStartTime}:${lyricEndTime}:${audioRetryToken}`;
    setAudioStatus("loading");
    setAudioPlaybackState("idle");
    audio.volume = volumeRef.current;
    const startSeconds = lyricStartTime / 1_000;
    const endSeconds = lyricEndTime / 1_000;

    const moveToStart = () => {
      if (Math.abs(audio.currentTime - startSeconds) > 0.15) audio.currentTime = startSeconds;
    };
    const stopAtEnd = () => {
      if (audio.currentTime >= endSeconds) {
        audio.pause();
        audio.currentTime = startSeconds;
        setAudioPlaybackState("completed");
      }
    };
    const keepPlaybackInClip = () => {
      if (audio.currentTime < startSeconds - 0.25 || audio.currentTime >= endSeconds) {
        audio.currentTime = startSeconds;
      }
    };
    let readyState = false;
    let disposed = false;
    const ready = () => {
      if (disposed) return;
      moveToStart();
      readyState = true;
      setAudioStatus("ready");
      const state = useSongGuessrStore.getState();
      const currentPrivateState = state.privateState;
      const currentSnapshot = state.snapshot;
      const currentPlayer = currentSnapshot?.players.find(
        (player) => player.id === currentPrivateState?.playerId,
      );
      if (
        currentPrivateState &&
        !(currentPrivateState.isSubmitter && !currentSnapshot?.testMode) &&
        currentPlayer?.membership === "active" &&
        audioReadyKey.current !== loadKey
      ) {
        audioReadyKey.current = loadKey;
        void sendCommandRef.current("song.game.audioReady", { roundNumber }).catch(() => {
          if (audioReadyKey.current === loadKey) audioReadyKey.current = null;
        });
      }

      // 加载完成后自动播放；浏览器禁止自动播放时保留小型播放按钮作为后备。
      if (audioAutoPlayKey.current !== loadKey) {
        audioAutoPlayKey.current = loadKey;
        void audio.play().catch(() => {
          if (!disposed) setAudioPlaybackState("idle");
        });
      }
    };
    const failed = () => {
      if (disposed || readyState) return;
      setAudioPlaybackState("idle");
      setAudioStatus("error");
    };
    const playing = () => setAudioPlaybackState("playing");
    const completed = () => {
      audio.currentTime = startSeconds;
      setAudioPlaybackState("completed");
    };

    audio.addEventListener("loadedmetadata", moveToStart);
    audio.addEventListener("timeupdate", stopAtEnd);
    audio.addEventListener("play", keepPlaybackInClip);
    audio.addEventListener("play", playing);
    audio.addEventListener("ended", completed);
    audio.addEventListener("canplay", ready);
    audio.addEventListener("canplaythrough", ready);
    audio.addEventListener("loadeddata", ready);
    audio.addEventListener("error", failed);
    audio.src = roundAudioUrl;
    audio.load();
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) moveToStart();
    if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) ready();
    const loadTimeout = window.setTimeout(() => {
      if (!disposed && !readyState && audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        setAudioStatus("error");
      }
    }, 15_000);
    return () => {
      disposed = true;
      window.clearTimeout(loadTimeout);
      audio.pause();
      audio.removeEventListener("loadedmetadata", moveToStart);
      audio.removeEventListener("timeupdate", stopAtEnd);
      audio.removeEventListener("play", keepPlaybackInClip);
      audio.removeEventListener("play", playing);
      audio.removeEventListener("ended", completed);
      audio.removeEventListener("canplay", ready);
      audio.removeEventListener("canplaythrough", ready);
      audio.removeEventListener("loadeddata", ready);
      audio.removeEventListener("error", failed);
    };
  }, [audioRetryToken, lyricEndTime, lyricStartTime, roomId, roundAudioUrl, roundNumber]);

  // 音频可能先于房间私有状态完成加载；私有状态到达后补发一次准备通知。
  useEffect(() => {
    if (
      audioStatus !== "ready" ||
      roundNumber === undefined ||
      !roundAudioUrl ||
      lyricStartTime === undefined ||
      lyricEndTime === undefined
    ) return;
    const currentPlayer = snapshot?.players.find((player) => player.id === privateState?.playerId);
    if (
      !privateState ||
      (privateState.isSubmitter && !snapshot?.testMode) ||
      currentPlayer?.membership !== "active"
    ) return;
    const loadKey = `${roomId}:${roundNumber}:${roundAudioUrl}:${lyricStartTime}:${lyricEndTime}:${audioRetryToken}`;
    if (audioReadyKey.current === loadKey) return;
    audioReadyKey.current = loadKey;
    void sendCommandRef.current("song.game.audioReady", { roundNumber }).catch(() => {
      if (audioReadyKey.current === loadKey) audioReadyKey.current = null;
    });
  }, [
    audioRetryToken,
    audioStatus,
    lyricEndTime,
    lyricStartTime,
    privateState,
    privateState?.isSubmitter,
    privateState?.playerId,
    roomId,
    roundAudioUrl,
    roundNumber,
    snapshot?.testMode,
    snapshot?.players,
  ]);

  const playAudio = useCallback(async () => {
    const audio = audioRef.current;
    if (
      !audio ||
      audioStatus !== "ready" ||
      audioPlaybackState === "playing" ||
      lyricStartTime === undefined ||
      lyricEndTime === undefined
    ) return;
    const startSeconds = lyricStartTime / 1_000;
    const endSeconds = lyricEndTime / 1_000;
    if (audio.currentTime < startSeconds - 0.25 || audio.currentTime >= endSeconds) {
      audio.currentTime = startSeconds;
    }
    try {
      await audio.play();
    } catch {
      setAudioPlaybackState("idle");
    }
  }, [audioPlaybackState, audioStatus, lyricEndTime, lyricStartTime]);


  useEffect(() => {
    volumeRef.current = volume;
    window.localStorage.setItem(SONG_VOLUME_KEY, String(volume));
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    const handleSessionChanged = () => setMusicSessionRevision((revision) => revision + 1);
    window.addEventListener(SONG_MUSIC_SESSION_CHANGED, handleSessionChanged);
    return () => window.removeEventListener(SONG_MUSIC_SESSION_CHANGED, handleSessionChanged);
  }, []);

  useEffect(() => {
    if (!connected) {
      mountedMusicSessionRef.current = null;
      return;
    }
    if (
      !snapshot ||
      !privateState ||
      snapshot.roomId !== roomId ||
      snapshot.hostPlayerId !== privateState.playerId
    ) {
      mountedMusicSessionRef.current = null;
      return;
    }
    const storedSession = getStoredSongMusicSession();
    if (!storedSession) {
      mountedMusicSessionRef.current = null;
      return;
    }
    const mountKey = `${snapshot.roomId}:${privateState.playerId}:${storedSession.cookie}`;
    if (mountedMusicSessionRef.current === mountKey) return;
    mountedMusicSessionRef.current = mountKey;
    void sendCommand<{ account: SongGuessrMusicAccount }>("song.auth.useCookie", { cookie: storedSession.cookie })
      .then((result) => {
        if (!result?.account) return;
        saveSongMusicSession(
          { cookie: storedSession.cookie, account: result.account },
          storedSession.persistent,
        );
      })
      .catch((error) => {
        mountedMusicSessionRef.current = null;
        const appError = error as { code?: string; message?: string };
        if (appError.code === "MUSIC_SESSION_INVALID") {
          clearStoredSongMusicSession();
          setNotice("网易云登录状态已失效，请重新扫码登录", "error");
        }
      });
  }, [
    connected,
    musicSessionRevision,
    privateState,
    roomId,
    sendCommand,
    setNotice,
    snapshot,
  ]);

  const guessDeadlineAt = privateState?.guessDeadlineAt;
  useEffect(() => {
    if (!guessDeadlineAt) return;
    const timer = window.setInterval(() => setClock(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [guessDeadlineAt]);

  const secondsLeft = guessDeadlineAt
    ? Math.max(0, Math.ceil((guessDeadlineAt - clock) / 1_000))
    : 0;

  const handleConfirmName = async () => {
    const name = nameDraft.trim();
    if (!name) {
      setNotice("请输入用户名", "error");
      return;
    }
    saveUsername(name);
    setNeedsName(false);
    await enterWithName(name);
  };

  const handleConfirmPassword = async () => {
    if (!pendingJoinName || !passwordDraft.trim()) return;
    setNeedsPassword(false);
    await enterWithName(pendingJoinName, passwordDraft);
  };

  if (joining || needsName || needsPassword || !snapshot || !privateState || snapshot.roomId !== roomId) {
    return (
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
    );
  }

  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  const isHost = snapshot.hostPlayerId === privateState.playerId;
  const isSpectator = me?.membership === "spectator";

  const run = async (type: string, payload: Record<string, unknown> = {}, success?: string) => {
    try {
      await sendCommand(type, payload);
      if (success) setNotice(success, "success");
    } catch (error) {
      const appError = error as { code?: string; message?: string };
      if (appError.code === "MUSIC_SESSION_INVALID") {
        mountedMusicSessionRef.current = null;
        clearStoredSongMusicSession();
        setNotice("网易云登录状态已失效，请重新扫码登录", "error");
        return;
      }
      setNotice(appError.message ?? "操作失败", "error");
    }
  };

  const leave = async () => {
    leavingRef.current = true;
    await leaveRoom();
    navigate("/songuessr", { replace: true });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <audio
        ref={audioRef}
        src={roundAudioUrl}
        className="hidden"
        preload="auto"
        playsInline
        autoPlay
        crossOrigin="anonymous"
      />
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
          <span className="hidden truncate text-base font-semibold md:block">{snapshot.name}</span>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">#{snapshot.roomId}</span>
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
            <span className="mr-1 hidden shrink-0 animate-pulse text-xs text-destructive sm:inline">断线中...</span>
          ) : null}
          <VolumeControl volume={volume} onVolumeChange={setVolume} />
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
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 gap-2 overflow-hidden px-2 pb-2 md:gap-3 md:px-3 md:pb-3">
        <section className="relative flex min-h-0 min-w-0 flex-1 gap-2 overflow-hidden rounded-xl md:gap-3">
          <div
            className="hidden shrink-0 md:block"
            style={{ width: PLAYER_COLUMN_WIDTH }}
            aria-hidden="true"
          />

          <motion.aside
            className="absolute inset-y-0 left-0 z-30 hidden flex-col rounded-xl border bg-panel md:flex"
            initial={false}
            animate={{ width: PLAYER_COLUMN_WIDTH, boxShadow: "var(--shadow-2xs)" }}
            transition={{ width: spring.settle, boxShadow: { duration: duration.base } }}
          >
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl">
              <SongPlayerList
                players={snapshot.players}
                myPlayerId={privateState.playerId}
                isHost={isHost}
                phase={snapshot.phase}
                allowSpectators={snapshot.allowSpectators}
              />
            </div>
          </motion.aside>

          <main className="isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-panel">
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
              onRetryAudio={() => setAudioRetryToken((token) => token + 1)}
              openSearch={setSearchMode}
              searchMode={searchMode}
              closeSearch={() => setSearchMode(null)}
              onSelectSearchSong={async (songId, mode) => {
                await sendCommand(mode === "submit" ? "song.game.submitSong" : "song.game.guess", { songId });
              }}
              run={run}
            />
          </main>
        </section>

        <aside className="hidden min-h-0 w-80 shrink-0 flex-col overflow-hidden rounded-xl border bg-panel lg:flex">
          <SongChatPanel />
        </aside>

        <AnimatePresence>
          {mobilePanel === "players" ? (
            <motion.aside
              initial={{ x: "-100%" }}
              animate={{ x: 0, transition: spring.swift }}
              exit={{ x: "-100%", transition: { duration: duration.quick, ease: ease.inOut } }}
              className="absolute inset-y-0 left-0 z-30 flex w-72 min-w-0 flex-col overflow-hidden border-r bg-panel shadow-xl md:hidden"
            >
              <SongPlayerList
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
              <SongChatPanel />
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
  );
}

interface SongGameAreaProps {
  snapshot: SongGuessrRoomSnapshot;
  privateState: SongGuessrPrivateState;
  me?: SongGuessrPlayerView;
  isHost: boolean;
  secondsLeft: number;
  volume: number;
  onVolumeChange: (value: number) => void;
  audioStatus: "loading" | "ready" | "error";
  audioPlaybackState: "idle" | "playing" | "completed";
  onPlayAudio: () => void;
  onRetryAudio: () => void;
  openSearch: (mode: "submit" | "guess") => void;
  searchMode: "submit" | "guess" | null;
  closeSearch: () => void;
  onSelectSearchSong: (songId: string, mode: "submit" | "guess") => Promise<void>;
  run: (type: string, payload?: Record<string, unknown>, success?: string) => Promise<void>;
}

function SongGameArea(props: SongGameAreaProps) {
  const phaseRef = useRef<HTMLDivElement>(null);

  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col overflow-hidden", props.snapshot.testMode && "pb-16")}>
      <ScrollArea data-testid="game-area-scroll" className="min-h-0 flex-1">
        <div className="p-6 md:p-8">
          <AnimatePresence mode="wait">
            <motion.div
              key={props.snapshot.phase}
              variants={phaseSwap}
              initial="initial"
              animate="animate"
              exit="exit"
              onAnimationComplete={(definition) => {
                if (definition !== "animate") return;
                const node = phaseRef.current;
                if (node) node.style.transform = "";
              }}
              ref={phaseRef}
              style={{ willChange: "transform, opacity" }}
            >
              <GameStage {...props} />
            </motion.div>
          </AnimatePresence>
          {props.searchMode ? (
            <SongSearchDialog
              open
              onOpenChange={(open) => {
                if (!open) props.closeSearch();
              }}
              title={props.searchMode === "submit" ? "选择本回合答案" : "提交你的猜测"}
              description={
                props.searchMode === "submit"
                  ? "歌曲信息只会在回合结束后公开。"
                  : "每次错误猜测会提供年代、热度、语种与标签反馈。"
              }
              actionLabel={props.searchMode === "submit" ? "设为答案" : "猜这首"}
              onSelect={(song) => props.onSelectSearchSong(song.id, props.searchMode!)}
            />
          ) : null}
        </div>
      </ScrollArea>
      {props.snapshot.testMode ? <SongTestController run={props.run} snapshot={props.snapshot} /> : null}
    </div>
  );
}

function GameStage({
  snapshot,
  privateState,
  me,
  isHost,
  secondsLeft,
  audioStatus,
  audioPlaybackState,
  onPlayAudio,
  onRetryAudio,
  openSearch,
  run,
}: SongGameAreaProps) {
  if (snapshot.phase === "waiting") {
    return <SongWaitingPhase snapshot={snapshot} me={me} isHost={isHost} run={run} />;
  }

  if (snapshot.phase === "choosingSubmitter") {
    const activeCandidates = snapshot.players.filter(
      (player) => player.membership === "active" && player.online && !player.isBot,
    );
    const spectatorCandidates = snapshot.players.filter(
      (player) => player.membership === "spectator" && player.online && !player.isBot,
    );
    return (
      <div className="flex flex-col items-center gap-6">
        <PhaseHeader icon={UserCheck} title="指定出题人" />
        {isHost ? (
          <div className="w-full max-w-xl space-y-5">
            {spectatorCandidates.length > 0 ? (
              <section>
                <SectionHeader title="旁观玩家" icon={<Eye className="h-3.5 w-3.5" />} />
                <CandidateGrid
                  candidates={spectatorCandidates}
                  tone="recommended"
                  onPick={(playerId) => run("song.game.chooseSubmitter", { playerId })}
                />
              </section>
            ) : null}
            <section>
              <SectionHeader title="玩家" icon={<UserCheck className="h-3.5 w-3.5" />} />
              <CandidateGrid
                candidates={activeCandidates}
                tone="default"
                onPick={(playerId) => run("song.game.chooseSubmitter", { playerId })}
              />
            </section>
          </div>
        ) : null}
      </div>
    );
  }

  if (snapshot.phase === "submittingSong") {
    const submitter = snapshot.players.find(
      (player) => player.id === snapshot.pendingSubmitterPlayerId,
    );
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-6 text-center">
        <PhaseHeader
          icon={Music2}
          title={privateState.canSubmitSong ? "轮到你出题" : "等待出题人选歌"}
        />
        {privateState.canSubmitSong ? (
          <>
            <p className="text-sm text-muted-foreground">
              搜索一首可播放的网易云音乐歌曲。
            </p>
            <Button size="lg" className="min-w-[120px] gap-2" onClick={() => openSearch("submit")}>
              <Music2 className="h-4 w-4" />选择歌曲
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {submitter?.name ?? "出题人"} 正在选择歌曲
          </p>
        )}
      </div>
    );
  }

  if (snapshot.phase === "playing" && snapshot.currentRound) {
    const canObserveAllAttempts = privateState.isSubmitter || me?.membership === "spectator";
    const hasGivenUp = privateState.visibleAttempts.some(
      (attempt) => attempt.playerId === privateState.playerId && attempt.result === "gaveUp",
    );
    return (
      <div className="mx-auto max-w-2xl space-y-5">
        <PhaseHeader icon={Headphones} title="听歌猜曲" />
        <section className="space-y-5 rounded-md bg-muted p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {snapshot.settings.showLyrics ? "歌词片段" : "音乐片段"}
            </h3>
            <div className="flex items-center gap-2">
              {snapshot.settings.showGuessTimer && privateState.canGuess && privateState.guessDeadlineAt ? (
                <Badge variant={secondsLeft <= 10 ? "destructive" : "outline"} className="gap-1 font-mono">
                  <Clock3 className="h-3.5 w-3.5" />{secondsLeft}s
                </Badge>
              ) : null}
              {audioStatus === "loading" ? (
                <Button variant="ghost" size="icon" className="h-8 w-8" disabled aria-label="音频加载中">
                  <motion.span
                    className="h-3.5 w-3.5 rounded-full border-2 border-primary border-t-transparent"
                    {...spinner}
                  />
                </Button>
              ) : audioStatus === "error" ? (
                <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={onRetryAudio} aria-label="重新加载音频">
                  <RotateCcw className="h-4 w-4" />
                </Button>
              ) : audioPlaybackState === "playing" ? (
                <Button variant="ghost" size="icon" className="h-8 w-8" disabled aria-label="音频播放中">
                  <motion.span
                    className="h-3.5 w-3.5 rounded-full border-2 border-primary border-t-transparent"
                    {...spinner}
                  />
                </Button>
              ) : audioPlaybackState === "completed" ? (
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onPlayAudio} aria-label="重播音频">
                  <RotateCcw className="h-4 w-4" />
                </Button>
              ) : (
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onPlayAudio} aria-label="播放音频">
                  <Play className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
          {snapshot.settings.questionMode === "automatic" ? (
            <SongAutoFilterSummary snapshot={snapshot} />
          ) : null}
          {snapshot.settings.showLyrics ? (
            <div
              className="select-none space-y-2 rounded-md bg-background/60 p-5 text-center"
              draggable={false}
              onDragStart={(event) => event.preventDefault()}
            >
              {snapshot.currentRound.lyricClip.lines.length > 0 ? (
                snapshot.currentRound.lyricClip.lines.map((line) => (
                  <p key={`${line.time}-${line.text}`} className="leading-relaxed">{line.text}</p>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">本房间未显示歌词提示</p>
              )}
            </div>
          ) : (
            <div className="rounded-md bg-background/60 p-5 text-center text-sm text-muted-foreground">
              本房间已关闭歌词提示，请根据音乐进行猜测
            </div>
          )}
          {privateState.submittedSong ? (
            <div className="break-words rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
              本轮答案：<strong>{privateState.submittedSong.title}</strong> · {privateState.submittedSong.artist}
            </div>
          ) : null}
          {me?.membership === "spectator" ? (
            <p className="text-center text-sm text-muted-foreground">你正在旁观本轮游戏</p>
          ) : privateState.canGuess || privateState.canGiveUp ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              {privateState.canGuess ? (
                <Button className="flex-1 gap-2" onClick={() => openSearch("guess")}>
                  <Play className="h-4 w-4" />提交猜测（剩余 {privateState.remainingGuesses} 次）
                </Button>
              ) : null}
              {privateState.canGiveUp ? (
                <Button
                  variant="outline"
                  className="gap-2"
                  onClick={() => void run("song.game.giveUp")}
                >
                  <Flag className="h-4 w-4" />投降
                </Button>
              ) : null}
            </div>
          ) : hasGivenUp ? (
            <p className="text-center text-sm text-muted-foreground">你已放弃本回合，等待其他玩家</p>
          ) : !privateState.isSubmitter ? (
            <p className="text-center text-sm text-muted-foreground">本轮操作已完成</p>
          ) : null}
        </section>
        <AttemptList
          attempts={privateState.visibleAttempts}
          title={canObserveAllAttempts ? "全房猜测" : "我的猜测"}
          showPlayerName={canObserveAllAttempts}
        />
      </div>
    );
  }

  if (snapshot.phase === "roundResult" && snapshot.roundSummary) {
    const summary = snapshot.roundSummary;
    return (
      <div className="mx-auto max-w-2xl space-y-5">
        <PhaseHeader icon={Music2} title="答案揭晓" />
        <section className="rounded-md bg-muted p-4">
          <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
            {summary.song.pictureUrl ? (
              <img src={summary.song.pictureUrl} alt="" className="h-28 w-28 rounded-md object-cover shadow-md" />
            ) : (
              <div className="flex h-28 w-28 items-center justify-center rounded-md bg-background/60">
                <Music2 className="h-9 w-9" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h2 className="break-words text-2xl font-bold">{summary.song.title}</h2>
              <p className="mt-1 text-muted-foreground">
                {summary.song.artist}{summary.song.album ? ` · ${summary.song.album}` : ""}
              </p>
              <div className="mt-3 flex flex-wrap justify-center gap-2 text-xs sm:justify-start">
                {summary.song.releaseYear ? <Badge variant="outline">{summary.song.releaseYear}</Badge> : null}
                {summary.song.language ? <Badge variant="outline">{summary.song.language}</Badge> : null}
                {summary.song.encyclopedia.tags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
              </div>
              {summary.song.encyclopedia.aliases?.length ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  别名：{summary.song.encyclopedia.aliases.join("、")}
                </p>
              ) : null}
              {summary.song.encyclopedia.summary ? (
                <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-muted-foreground">
                  {summary.song.encyclopedia.summary}
                </p>
              ) : null}
            </div>
          </div>
        </section>
        <ScoreTable scores={summary.scores} />
        {isHost ? (
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => void run("song.game.finish")}>返回等待阶段</Button>
            <Button
              disabled={snapshot.settings.questionMode === "automatic" && !snapshot.musicAccountReady}
              onClick={() => void run("song.game.nextRound")}
            >
              再来一轮
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  // 阶段快照不完整时直接回退到可操作的等待界面，避免留下悬空页面。
  return <SongWaitingPhase snapshot={snapshot} me={me} isHost={isHost} run={run} />;
}

function SongWaitingPhase({
  snapshot,
  me,
  isHost,
  run,
}: {
  snapshot: SongGuessrRoomSnapshot;
  me?: SongGuessrPlayerView;
  isHost: boolean;
  run: SongGameAreaProps["run"];
}) {
  const activePlayers = snapshot.players.filter((player) => player.membership === "active");
  const nonHostActive = activePlayers.filter((player) => !player.isHost);
  const readyCount = nonHostActive.filter((player) => player.isReady).length;
  const showProgress = nonHostActive.length > 0;
  const allReady = activePlayers.length >= 2 && nonHostActive.every((player) => player.isReady);

  if (isHost) {
    return (
      <SongHostWaitingPanel
        snapshot={snapshot}
        showProgress={showProgress}
        readyCount={readyCount}
        nonHostTotal={nonHostActive.length}
        allReady={allReady}
        canStart={allReady && snapshot.musicAccountReady}
        run={run}
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6">
      <PhaseHeader icon={Gamepad2} title="等待开始" />
      <SongRoomLinkShare roomId={snapshot.roomId} />
      <SongSettingsPreview snapshot={snapshot} />
      {showProgress ? (
        <div className="w-full space-y-2 text-center">
          <p className="text-sm text-muted-foreground">
            {readyCount}/{nonHostActive.length} 名玩家已准备
          </p>
          <div className="mx-auto h-1.5 w-48 overflow-hidden rounded-full bg-muted">
            <motion.div
              className="h-full rounded-full bg-primary"
              initial={false}
              animate={{ width: `${(readyCount / nonHostActive.length) * 100}%` }}
              transition={spring.settle}
            />
          </div>
        </div>
      ) : null}
      {me?.membership === "active" ? (
        <Button
          variant={me.isReady ? "outline" : "default"}
          size="lg"
          onClick={() => void run("song.player.setReady", { ready: !me.isReady })}
          className="gap-2 min-w-[120px]"
        >
          {me.isReady ? <><X className="h-4 w-4" />取消准备</> : <><Check className="h-4 w-4" />准备</>}
        </Button>
      ) : null}
    </div>
  );
}

function SongHostWaitingPanel({
  snapshot,
  showProgress,
  readyCount,
  nonHostTotal,
  allReady,
  canStart,
  run,
}: {
  snapshot: SongGuessrRoomSnapshot;
  showProgress: boolean;
  readyCount: number;
  nonHostTotal: number;
  allReady: boolean;
  canStart: boolean;
  run: SongGameAreaProps["run"];
}) {
  const [questionSettingsOpen, setQuestionSettingsOpen] = useState(false);
  const [gameSettingsOpen, setGameSettingsOpen] = useState(false);
  const [roomSettingsOpen, setRoomSettingsOpen] = useState(false);

  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      <PhaseHeader icon={Gamepad2} title="等待玩家加入" />

      <SongRoomLinkShare roomId={snapshot.roomId} />

      {showProgress ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>玩家准备进度</span>
            <span>{readyCount}/{nonHostTotal}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <motion.div
              className="h-full rounded-full bg-primary"
              initial={false}
              animate={{ width: `${(readyCount / nonHostTotal) * 100}%` }}
              transition={spring.settle}
            />
          </div>
        </div>
      ) : null}

      <SongAccountSettings snapshot={snapshot} />

      <SettingsAccordion
        icon={<Music2 className="h-4 w-4 text-muted-foreground" />}
        title="题目设置"
        open={questionSettingsOpen}
        onOpenChange={setQuestionSettingsOpen}
      >
        <SongQuestionSettings snapshot={snapshot} />
      </SettingsAccordion>

      <SettingsAccordion
        icon={<Settings className="h-4 w-4 text-muted-foreground" />}
        title="猜测设置"
        open={gameSettingsOpen}
        onOpenChange={setGameSettingsOpen}
      >
        <SongGameSettings snapshot={snapshot} />
      </SettingsAccordion>

      <SettingsAccordion
        icon={<Settings className="h-4 w-4 text-muted-foreground" />}
        title="房间设置"
        open={roomSettingsOpen}
        onOpenChange={setRoomSettingsOpen}
      >
        <SongRoomSettings snapshot={snapshot} />
      </SettingsAccordion>

      <Button
        size="lg"
        disabled={!canStart}
        onClick={() => void run("song.game.start")}
        className="w-full text-base"
      >
        {!snapshot.musicAccountReady && allReady
          ? "请先扫码登录网易云账号"
          : allReady
          ? "开始游戏"
          : nonHostTotal === 0
            ? "等待玩家加入"
            : `等待玩家准备 (${readyCount}/${nonHostTotal})`}
      </Button>
    </div>
  );
}

function SongRoomLinkShare({ roomId }: { roomId: string }) {
  const [copied, setCopied] = useState(false);
  const setNotice = useSongGuessrStore((state) => state.setNotice);
  const shareUrl = `${window.location.origin}/songuessr/room/${roomId}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setNotice("复制失败，请手动复制", "error");
    }
  };

  return (
    <div className="w-full space-y-2">
      <Label className="text-xs text-muted-foreground">房间链接</Label>
      <div className="flex gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
          <Link className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {shareUrl}
          </span>
        </div>
        <motion.button
          type="button"
          {...pressable}
          onClick={() => void handleCopy()}
          className={cn(
            "flex h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors",
            copied
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
              : "hover:bg-accent/60",
          )}
        >
          <Copy className="h-3.5 w-3.5" />
          {copied ? "已复制" : "复制"}
        </motion.button>
      </div>
    </div>
  );
}

function SettingsAccordion({
  icon,
  title,
  open,
  onOpenChange,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border">
      <motion.button
        type="button"
        {...pressable}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium transition-colors hover:bg-accent/40"
      >
        {icon}
        <span className="flex-1 text-left">{title}</span>
        <motion.span
          className="inline-flex text-muted-foreground"
          animate={{ rotate: open ? 180 : 0 }}
          transition={spring.snap}
        >
          <ChevronDown className="h-4 w-4" />
        </motion.span>
      </motion.button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            variants={collapsible}
            initial="initial"
            animate="animate"
            exit="exit"
            className="overflow-hidden"
          >
            <div className="border-t px-4 py-4">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function SongQuestionSettings({
  snapshot,
}: {
  snapshot: SongGuessrRoomSnapshot;
}) {
  const sendCommand = useSongGuessrStore((state) => state.sendCommand);
  const setNotice = useSongGuessrStore((state) => state.setNotice);
  const [questionType, setQuestionType] = useState(snapshot.settings.questionType);
  const [questionMode, setQuestionMode] = useState(snapshot.settings.questionMode);
  const [autoRotateSubmitter, setAutoRotateSubmitter] = useState(snapshot.settings.autoRotateSubmitter);
  const [playlistDraft, setPlaylistDraft] = useState(snapshot.settings.autoFilters.playlist?.id ?? "");
  const [playlist, setPlaylist] = useState(snapshot.settings.autoFilters.playlist);
  const [artistDraft, setArtistDraft] = useState("");
  const [artists, setArtists] = useState<SongArtistFilter[]>(snapshot.settings.autoFilters.artists);
  const [artistResults, setArtistResults] = useState<SongArtistSearchResult[]>([]);
  const [searchingArtists, setSearchingArtists] = useState(false);
  const [minPopularity, setMinPopularity] = useState(snapshot.settings.autoFilters.minPopularity);

  const resolvePlaylist = async () => {
    try {
      const result = await sendCommand<{ playlist: SongPlaylistInfo }>("song.music.playlist.resolve", {
        value: playlistDraft,
      });
      setPlaylist(result.playlist);
      setNotice(`已读取歌单：${result.playlist.name}（${result.playlist.songCount} 首）`, "success");
    } catch (error) {
      setNotice((error as { message?: string }).message ?? "读取歌单失败", "error");
    }
  };

  const searchArtists = async () => {
    const keyword = artistDraft.trim();
    if (!keyword) return;
    setSearchingArtists(true);
    try {
      const result = await sendCommand<{ results: SongArtistSearchResult[] }>("song.music.artist.search", { keyword });
      setArtistResults(result.results);
    } catch (error) {
      setNotice((error as { message?: string }).message ?? "搜索歌手失败", "error");
    } finally {
      setSearchingArtists(false);
    }
  };

  useAutoSave(
    {
      questionType,
      questionMode,
      autoRotateSubmitter,
      autoFilters: { playlist, artists, minPopularity },
    },
    (payload) => sendCommand("song.room.updateSettings", payload),
    {
      onError: (error) =>
        setNotice((error as { message?: string }).message ?? "保存设置失败", "error"),
    },
  );


  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant={questionType === "song" ? "default" : "outline"}
          className="h-10"
          onClick={() => setQuestionType("song")}
        >
          听歌识曲
        </Button>
        <Button type="button" variant="outline" className="h-10" disabled>
          听歌识番（即将推出）
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant={questionMode === "manual" ? "default" : "outline"}
          className="h-10"
          onClick={() => setQuestionMode("manual")}
        >
          手动出题
        </Button>
        <Button
          type="button"
          variant={questionMode === "automatic" ? "default" : "outline"}
          className="h-10"
          onClick={() => setQuestionMode("automatic")}
        >
          自动出题
        </Button>
      </div>

      {questionMode === "manual" ? (
        <div className="flex items-center justify-between rounded-md bg-muted/40 p-3">
          <div>
            <Label className="text-xs">自动轮流出题</Label>
            <p className="mt-1 text-[11px] text-muted-foreground">每轮按玩家加入顺序自动指定下一位出题人。</p>
          </div>
          <Switch checked={autoRotateSubmitter} onCheckedChange={setAutoRotateSubmitter} />
        </div>
      ) : null}

      {questionMode === "automatic" ? (
        <div className="space-y-4 rounded-md bg-muted/40 p-3">
          <div className="space-y-2">
            <Label className="text-xs">歌单筛选</Label>
            <div className="flex gap-2">
              <Input
                value={playlistDraft}
                onChange={(event) => setPlaylistDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void resolvePlaylist();
                  }
                }}
                placeholder="粘贴网易云歌单链接或 ID"
                className="h-9"
              />
              <Button type="button" size="sm" variant="outline" onClick={() => void resolvePlaylist()}>
                读取
              </Button>
            </div>
            {playlist ? (
              <div className="flex items-center justify-between gap-2 rounded border bg-background px-2.5 py-2 text-xs">
                <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                  <span className="truncate">{playlist.name ?? playlist.id}</span>
                  <span className="shrink-0 text-muted-foreground">{playlist.songCount ?? ""} 首</span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    setPlaylist(undefined);
                    setPlaylistDraft("");
                  }}
                  aria-label="清除歌单筛选"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label className="text-xs">歌手筛选（可多选）</Label>
            <div className="flex gap-2">
              <Input
                value={artistDraft}
                onChange={(event) => setArtistDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void searchArtists();
                  }
                }}
                placeholder="输入歌手名后搜索"
                className="h-9"
              />
              <Button type="button" size="sm" variant="outline" onClick={() => void searchArtists()}>
                {searchingArtists ? "搜索中" : "搜索"}
              </Button>
            </div>
            {artistResults.length > 0 ? (
              <div className="space-y-1 rounded border bg-background p-2">
                {artistResults.map((artist) => {
                  const selected = artists.some((item) => item.id === artist.id);
                  return (
                    <button
                      key={artist.id}
                      type="button"
                      className={cn("flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-muted", selected && "bg-primary/10 text-primary")}
                      onClick={() => setArtists((current) => selected ? current.filter((item) => item.id !== artist.id) : [...current, { id: artist.id, name: artist.name }])}
                    >
                      <span>{artist.name}</span>
                      <span>{selected ? "已选" : "选择"}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {artists.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {artists.map((artist) => (
                  <button
                    key={artist.id}
                    type="button"
                    className="rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary"
                    onClick={() => setArtists((current) => current.filter((item) => item.id !== artist.id))}
                    title="移除歌手筛选"
                  >
                    {artist.name} ×
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label className="text-xs">热度筛选</Label>
            <div className="grid grid-cols-4 gap-1.5">
              {([0, 1_000, 10_000, 100_000] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={minPopularity === value ? "default" : "outline"}
                  onClick={() => setMinPopularity(value)}
                >
                  {value === 0 ? "不限" : `${value}+`}
                </Button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">网易云对超高热度可能返回近似值，筛选按接口返回值判断。</p>
          </div>
          {!playlist && artists.length === 0 ? (
            <p className="rounded border border-dashed px-3 py-2 text-[11px] text-muted-foreground">
              未填写歌单和歌手时，将从网易云热歌榜中自动出题；任一筛选项都可以单独使用。
            </p>
          ) : null}
        </div>
      ) : null}

    </div>
  );
}

function SongGameSettings({
  snapshot,
}: {
  snapshot: SongGuessrRoomSnapshot;
}) {
  const sendCommand = useSongGuessrStore((state) => state.sendCommand);
  const setNotice = useSongGuessrStore((state) => state.setNotice);
  const [showLyrics, setShowLyrics] = useState(snapshot.settings.showLyrics);
  const [bloodMode, setBloodMode] = useState(snapshot.settings.bloodMode);
  const [showGuessTimer, setShowGuessTimer] = useState(snapshot.settings.showGuessTimer);
  const [lyricsLineCount, setLyricsLineCount] = useState(snapshot.settings.lyricsLineCount);
  const [maxGuesses, setMaxGuesses] = useState(snapshot.settings.maxGuessesPerRound);
  const [guessDuration, setGuessDuration] = useState(snapshot.settings.guessDurationSeconds);

  useAutoSave(
    {
      lyricsLineCount,
      showLyrics,
      maxGuessesPerRound: maxGuesses,
      guessDurationSeconds: guessDuration,
      showGuessTimer,
      bloodMode,
    },
    (payload) => sendCommand("song.room.updateSettings", payload),
    {
      onError: (error) =>
        setNotice((error as { message?: string }).message ?? "保存设置失败", "error"),
    },
  );

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-xs">显示歌词</Label>
            <p className="mt-1 text-[11px] text-muted-foreground">关闭后只播放音乐，不显示歌词提示。</p>
          </div>
          <Switch checked={showLyrics} onCheckedChange={setShowLyrics} />
        </div>
        {showLyrics ? (
          <CountStepper
            label="歌词行数"
            value={lyricsLineCount}
            minimum={1}
            maximum={10}
            onChange={setLyricsLineCount}
          />
        ) : null}
      </div>
      <CountStepper
        label="猜测次数"
        value={maxGuesses}
        minimum={1}
        maximum={10}
        onChange={setMaxGuesses}
      />
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-xs">猜测时限</Label>
            <p className="mt-1 text-[11px] text-muted-foreground">关闭后本轮不会倒计时。</p>
          </div>
          <Switch checked={showGuessTimer} onCheckedChange={setShowGuessTimer} />
        </div>
        {showGuessTimer ? (
          <CountStepper
            label="每次猜测时限"
            value={guessDuration}
            minimum={10}
            maximum={180}
            step={10}
            onChange={setGuessDuration}
          />
        ) : null}
      </div>
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-xs">血战模式</Label>
          <p className="mt-1 text-[11px] text-muted-foreground">首位答对获得正式玩家数分，之后每位答对者依次少 1 分。</p>
        </div>
        <Switch checked={bloodMode} onCheckedChange={setBloodMode} />
      </div>
    </div>
  );
}

function SongRoomSettings({
  snapshot,
}: {
  snapshot: SongGuessrRoomSnapshot;
}) {
  const sendCommand = useSongGuessrStore((state) => state.sendCommand);
  const setNotice = useSongGuessrStore((state) => state.setNotice);
  const [name, setName] = useState(snapshot.name);
  const [isPrivate, setIsPrivate] = useState(snapshot.visibility === "private");
  const [password, setPassword] = useState("");
  const [allowSpectators, setAllowSpectators] = useState(snapshot.allowSpectators);

  useAutoSave(
    {
      name: name || undefined,
      visibility: isPrivate ? "private" : "public",
      password: isPrivate ? password || undefined : "",
      allowSpectators,
    },
    (payload) => sendCommand("song.room.updateSettings", payload),
    {
      enabled: !isPrivate || snapshot.hasPassword || password.trim().length > 0,
      onError: (error) =>
        setNotice((error as { message?: string }).message ?? "保存设置失败", "error"),
    },
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs">房间名称</Label>
        <Input value={name} onChange={(event) => setName(event.target.value)} className="h-9" />
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isPrivate ? <Lock className="h-3.5 w-3.5 text-muted-foreground" /> : <Globe className="h-3.5 w-3.5 text-muted-foreground" />}
          <Label className="text-xs">私密房间</Label>
        </div>
        <Switch checked={isPrivate} onCheckedChange={setIsPrivate} />
      </div>
      <AnimatePresence initial={false}>
        {isPrivate ? (
          <motion.div variants={collapsible} initial="initial" animate="animate" exit="exit" className="overflow-hidden">
            <div className="space-y-1.5 pt-1">
              <Label className="text-xs">密码</Label>
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="留空则保留当前密码"
                className="h-9"
              />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-3.5 w-3.5 text-muted-foreground" />
          <Label className="text-xs">允许旁观</Label>
        </div>
        <Switch checked={allowSpectators} onCheckedChange={setAllowSpectators} />
      </div>
    </div>
  );
}

function CountStepper({
  label,
  value,
  minimum,
  maximum,
  step = 1,
  onChange,
  disabled = false,
}: {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  step?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.max(minimum, Math.min(maximum, Math.round(parsed)));
    setDraft(String(next));
    onChange(next);
  };

  return (
    <div className="flex items-center justify-between">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => commit(String(Math.max(minimum, value - step)))}
          disabled={disabled || value <= minimum}
          aria-label={`减少${label}`}
        >
          <Minus className="h-3 w-3" />
        </Button>
        <Input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={draft}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            if (event.target.value !== "") commit(event.target.value);
          }}
          onBlur={() => commit(draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(draft);
          }}
          aria-label={label}
          className="h-9 w-16 bg-muted/30 px-1 text-center text-base font-medium tabular-nums shadow-inner"
        />
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => commit(String(Math.min(maximum, value + step)))}
          disabled={disabled || value >= maximum}
          aria-label={`增加${label}`}
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

function SongSettingsPreview({ snapshot }: { snapshot: SongGuessrRoomSnapshot }) {
  const items = [
    snapshot.settings.questionMode === "automatic"
      ? "自动出题"
      : snapshot.settings.autoRotateSubmitter ? "手动轮流出题" : "手动出题",
    snapshot.visibility === "private" ? "私密房间" : "公开房间",
    snapshot.allowSpectators ? "允许旁观" : "不允许旁观",
    snapshot.settings.showLyrics ? `${snapshot.settings.lyricsLineCount} 行歌词` : "歌词已关闭",
    `每人 ${snapshot.settings.maxGuessesPerRound} 次猜测`,
    snapshot.settings.showGuessTimer ? `每次 ${snapshot.settings.guessDurationSeconds} 秒` : "猜测时限已关闭",
    snapshot.settings.bloodMode ? "血战模式" : "普通模式",
  ];
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {items.map((item) => (
        <span key={item} className="rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">
          {item}
        </span>
      ))}
    </div>
  );
}

function SongAutoFilterSummary({ snapshot }: { snapshot: SongGuessrRoomSnapshot }) {
  const filters = snapshot.settings.autoFilters;
  const popularityLabel = filters.minPopularity === 0
    ? "不限热度"
    : `热度 ≥ ${filters.minPopularity >= 100_000 ? "100000" : filters.minPopularity}`;
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
      <span className="font-medium text-primary">自动出题筛选</span>
      {filters.playlist ? <Badge variant="outline">歌单：{filters.playlist.name ?? filters.playlist.id}</Badge> : <Badge variant="outline">默认热歌榜</Badge>}
      {filters.artists.map((artist) => <Badge key={artist.id} variant="outline">歌手：{artist.name}</Badge>)}
      <Badge variant="outline">{popularityLabel}</Badge>
    </div>
  );
}

function VolumeControl({
  volume,
  onVolumeChange,
}: {
  volume: number;
  onVolumeChange: (value: number) => void;
}) {
  const percentage = Math.round(volume * 100);
  return (
    <motion.div
      layout
      className="flex items-center gap-2 rounded-md border border-border/70 bg-panel px-2.5 py-1.5 shadow-sm"
      title={`播放音量 ${percentage}%`}
    >
      <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="relative h-4 w-20 sm:w-28">
        <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted" />
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary"
          animate={{ width: `${Math.max(0, Math.min(1, volume)) * 100}%` }}
          transition={spring.settle}
        />
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow-sm"
          animate={{ left: `${Math.max(0, Math.min(1, volume)) * 100}%` }}
          transition={spring.settle}
        />
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={(event) => onVolumeChange(Number(event.target.value))}
          className="absolute inset-0 h-4 w-full cursor-pointer opacity-0"
          aria-label="播放音量"
        />
      </div>
      <motion.span
        key={percentage}
        initial={{ opacity: 0.5, y: 2, scale: 0.92 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={spring.snap}
        className="min-w-10 text-right text-sm font-semibold tabular-nums text-foreground"
      >
        {percentage}%
      </motion.span>
    </motion.div>
  );
}

function SongTestController({
  snapshot,
  run,
}: {
  snapshot: SongGuessrRoomSnapshot;
  run: SongGameAreaProps["run"];
}) {
  const [open, setOpen] = useState(true);
  const botCount = snapshot.players.filter((player) => player.isBot).length;

  return (
    <div className="pointer-events-none absolute bottom-3 left-3 right-3 z-30 md:bottom-5 md:left-auto md:right-5">
      <div className="pointer-events-auto flex justify-end">
        <motion.div
          layout
          transition={spring.settle}
          className="w-full max-w-full overflow-hidden rounded-xl border bg-background/95 shadow-xl backdrop-blur-md md:w-96"
        >
          <motion.button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            {...headerTappable}
            className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-muted/40"
          >
            <FlaskConical className="h-4 w-4 text-primary" />
            <span>测试控制器</span>
            <motion.span
              aria-hidden="true"
              className="ml-auto inline-flex text-muted-foreground"
              animate={{ rotate: open ? 180 : 0 }}
              transition={spring.snap}
            >
              <ChevronDown className="h-4 w-4" />
            </motion.span>
          </motion.button>
          <AnimatePresence initial={false}>
            {open ? (
              <motion.div
                variants={collapsible}
                initial="initial"
                animate="animate"
                exit="exit"
                className="overflow-hidden"
              >
                <div className="space-y-2 border-t px-4 pb-4 pt-3">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <Users className="h-3.5 w-3.5 text-sky-500" />
                    测试人机
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 flex-1 gap-1 text-xs"
                      aria-label="移除一个测试人机"
                      disabled={botCount === 0}
                      onClick={() => void run("song.test.removeBot", { count: 1 })}
                    >
                      <Minus className="h-3 w-3" />
                      减一个
                    </Button>
                    <span className="w-10 text-center text-sm font-medium tabular-nums">
                      {botCount}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 flex-1 gap-1 text-xs"
                      aria-label="添加一个测试人机"
                      disabled={snapshot.players.length >= snapshot.maxPlayers}
                      onClick={() => void run("song.test.addBot", { count: 1 })}
                    >
                      <Plus className="h-3 w-3" />
                      加一个
                    </Button>
                  </div>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </motion.div>
      </div>
    </div>
  );
}

function SectionHeader({ title, icon }: { title: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-2.5 px-1">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {icon ?? <UserCheck className="h-3.5 w-3.5" />}
        {title}
      </div>
    </div>
  );
}

function CandidateGrid({
  candidates,
  tone,
  onPick,
}: {
  candidates: Array<{ id: string; name: string }>;
  tone: "recommended" | "default";
  onPick: (playerId: string) => void;
}) {
  if (candidates.length === 0) {
    return <div className="px-1 py-3 text-xs text-muted-foreground">暂无玩家</div>;
  }

  return (
    <motion.div
      className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      variants={listContainer(candidates.length)}
      initial="initial"
      animate="animate"
    >
      {candidates.map((candidate) => (
        <motion.button
          key={candidate.id}
          type="button"
          variants={listItem}
          {...selectable}
          onClick={() => onPick(candidate.id)}
          className={cn(
            "cursor-pointer rounded-md border px-3 py-2.5 text-left text-sm transition-[background,border-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            tone === "recommended"
              ? "border-primary/30 bg-primary/5 hover:border-primary/50 hover:bg-primary/10"
              : "hover:border-primary/40 hover:bg-primary/5",
          )}
        >
          <div className="flex items-center gap-1.5">
            {tone === "recommended" ? (
              <Eye className="h-3.5 w-3.5 shrink-0 text-primary" />
            ) : (
              <UserCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="break-words font-medium">{candidate.name}</span>
          </div>
        </motion.button>
      ))}
    </motion.div>
  );
}

function AttemptList({
  attempts,
  title,
  showPlayerName = false,
}: {
  attempts: SongGuessAttempt[];
  title: string;
  showPlayerName?: boolean;
}) {
  if (attempts.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-md bg-muted">
      <div className="border-b border-background px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      </div>
      <div>
        {attempts.map((attempt) => (
          <div
            key={attempt.id}
            className="flex flex-col gap-2 border-b border-background px-4 py-3 last:border-b-0 sm:flex-row sm:items-center"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {attempt.result === "correct" ? (
                <Check className="h-4 w-4 text-emerald-600" />
              ) : attempt.result === "timeout" ? (
                <Clock3 className="h-4 w-4 text-amber-600" />
              ) : attempt.result === "gaveUp" ? (
                <Flag className="h-4 w-4 text-muted-foreground" />
              ) : (
                <X className="h-4 w-4 text-red-500" />
              )}
              <span className="min-w-0 break-words text-sm">
                {showPlayerName ? `${attempt.playerName}：` : ""}
                {attempt.guessedSong
                  ? `${attempt.guessedSong.title} · ${attempt.guessedSong.artist}`
                  : attempt.result === "gaveUp"
                    ? "投降"
                    : "超时"}
              </span>
            </div>
            {attempt.feedback ? (
              <div className="flex flex-wrap gap-1 text-[11px]">
                <Badge variant="outline">
                  年份 {attempt.feedback.releaseYear ?? "?"} {directionSymbol[attempt.feedback.releaseYearDirection]}
                </Badge>
                <Badge variant="outline">
                  热度 {attempt.feedback.popularity ?? "?"} {directionSymbol[attempt.feedback.popularityDirection]}
                </Badge>
                {attempt.feedback.languageMatch !== undefined ? (
                  <Badge variant="outline">语种 {attempt.feedback.languageMatch ? "✓" : "×"}</Badge>
                ) : null}
                {attempt.feedback.sharedTags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function ScoreTable({
  scores,
}: {
  scores: Array<{
    playerId: string;
    playerName: string;
    score: number;
    delta: number;
    correctGuesses: number;
    totalGuesses: number;
  }>;
}) {
  return (
    <section className="overflow-hidden rounded-md bg-muted">
      <div className="border-b border-background px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">得分统计</h3>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-background text-xs text-muted-foreground">
            <th className="px-4 py-2 text-left font-medium">玩家</th>
            <th className="px-4 py-2 text-right font-medium">本轮</th>
            <th className="px-4 py-2 text-right font-medium">总分</th>
            <th className="px-4 py-2 text-right font-medium">命中</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((score, index) => (
            <tr key={score.playerId} className="border-b border-background last:border-b-0">
              <td className="px-4 py-2.5 font-medium">{index === 0 ? "🏆 " : ""}{score.playerName}</td>
              <td className="px-4 py-2.5 text-right">{score.delta >= 0 ? "+" : ""}{score.delta}</td>
              <td className="px-4 py-2.5 text-right font-semibold">{score.score}</td>
              <td className="px-4 py-2.5 text-right text-muted-foreground">
                {score.correctGuesses}/{score.totalGuesses}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
