import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { sonGuessrWs } from "@/lib/SonGuessrWs";
import {
  clearSongSoloRoomId,
  getSavedUsername,
  getSongSoloRoomId,
  saveSongSoloRoomId,
  saveUsername,
} from "@/lib/Storage";
import { randomRoomId } from "@/lib/Random";
import {
  clearStoredSongMusicSession,
  getStoredSongMusicSession,
  saveSongMusicSession,
  SONGUESSR_MUSIC_SESSION_CHANGED,
} from "@/lib/SonGuessrMusicSession";
import { isValidRoomId, ROOM_ID_TEST_MODE } from "@/types";
import type { SonGuessrMusicAccount } from "@/types";

const LONG_RUNNING_COMMANDS = ["song.game.start", "song.game.nextRound"] as const;
const LONG_RUNNING_POLL_INTERVAL_MS = 3_000;

export const isLongRunningCommand = (type: string): boolean =>
  (LONG_RUNNING_COMMANDS as readonly string[]).includes(type);

export function useSongRoomLifecycle({ solo = false }: { solo?: boolean } = {}) {
  const navigate = useNavigate();
  const { roomId: routeRoomId = "" } = useParams();
  const [soloRoomId, setSoloRoomId] = useState(() =>
    solo ? getSongSoloRoomId() || randomRoomId() : "",
  );
  const roomId = solo
    ? soloRoomId
    : routeRoomId.trim().toLowerCase() === ROOM_ID_TEST_MODE.toLowerCase()
      ? ROOM_ID_TEST_MODE
      : routeRoomId.trim();
  const exitPath = solo ? "/" : "/songuessr";

  const snapshot = useSonGuessrStore((state) => state.snapshot);
  const privateState = useSonGuessrStore((state) => state.privateState);
  const storedRoomId = useSonGuessrStore((state) => state.roomId);
  const roomClosedAt = useSonGuessrStore((state) => state.roomClosedAt);
  const connected = useSonGuessrStore((state) => state.connected);
  const createRoom = useSonGuessrStore((state) => state.createRoom);
  const joinRoom = useSonGuessrStore((state) => state.joinRoom);
  const reconnectRoom = useSonGuessrStore((state) => state.reconnectRoom);
  const leaveRoom = useSonGuessrStore((state) => state.leaveRoom);
  const sendCommand = useSonGuessrStore((state) => state.sendCommand);
  const setNotice = useSonGuessrStore((state) => state.setNotice);

  const alreadyInRoom = storedRoomId === roomId && snapshot?.roomId === roomId;
  const [joining, setJoining] = useState(!alreadyInRoom);
  const [needsName, setNeedsName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [pendingJoinName, setPendingJoinName] = useState("");
  const [musicSessionRevision, setMusicSessionRevision] = useState(0);

  const sendCommandRef = useRef(sendCommand);
  const leavingRef = useRef(false);
  const mountedMusicSessionRef = useRef<string | null>(null);
  const inFlightCommandsRef = useRef<Set<string>>(new Set());
  const [pendingCommands, setPendingCommands] = useState<Record<string, boolean>>({});

  useEffect(() => {
    sendCommandRef.current = sendCommand;
  }, [sendCommand]);

  const isPending = useCallback(
    (type: string) => Boolean(pendingCommands[type]),
    [pendingCommands],
  );

  const longRunningPending = LONG_RUNNING_COMMANDS.some((type) => Boolean(pendingCommands[type]));
  useEffect(() => {
    if (!longRunningPending) return;
    const timer = setInterval(() => {
      void sendCommandRef.current("song.room.requestSync").catch(() => {});
    }, LONG_RUNNING_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [longRunningPending]);

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
        navigate(exitPath, { replace: true });
      }
    },
    [createRoom, exitPath, joinRoom, navigate, roomId, setNotice],
  );

  const createSoloRoom = useCallback(
    async (targetRoomId: string) => {
      await createRoom({
        roomId: targetRoomId,
        name: "单人模式",
        visibility: "public",
        allowSpectators: false,
        userName: getSavedUsername() || "单人玩家",
        solo: true,
      });
      saveSongSoloRoomId(targetRoomId);
    },
    [createRoom],
  );

  const enterSoloRoom = useCallback(
    async (targetRoomId: string) => {
      try {
        await createSoloRoom(targetRoomId);
        setJoining(false);
        return;
      } catch (error) {
        if ((error as { code?: string }).code !== "ROOM_EXISTS") {
          setNotice((error as { message?: string }).message ?? "创建单人房间失败", "error");
          navigate("/", { replace: true });
          return;
        }
      }
      const nextRoomId = randomRoomId();
      setSoloRoomId(nextRoomId);
      try {
        await createSoloRoom(nextRoomId);
        setJoining(false);
      } catch (error) {
        setNotice((error as { message?: string }).message ?? "创建单人房间失败", "error");
        navigate("/", { replace: true });
      }
    },
    [createSoloRoom, navigate, setNotice],
  );

  useEffect(() => {
    if (!roomId || alreadyInRoom) return;
    if (!isValidRoomId(roomId)) {
      setNotice("房间号无效，请检查链接", "error");
      navigate(exitPath, { replace: true });
      return;
    }

    let cancelled = false;
    const tryEnter = async () => {
      setJoining(true);
      try {
        await sonGuessrWs.waitForConnection(8_000);
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
      if (cancelled || useSonGuessrStore.getState().roomClosedAt) return;
      if (solo) {
        await enterSoloRoom(roomId);
        return;
      }
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
    if (!roomClosedAt || leavingRef.current) return;
    if (solo) clearSongSoloRoomId();
    navigate(exitPath, { replace: true });
  }, [exitPath, navigate, roomClosedAt, solo]);

  useEffect(() => {
    const handleSessionChanged = () => setMusicSessionRevision((revision) => revision + 1);
    window.addEventListener(SONGUESSR_MUSIC_SESSION_CHANGED, handleSessionChanged);
    return () => window.removeEventListener(SONGUESSR_MUSIC_SESSION_CHANGED, handleSessionChanged);
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
    void sendCommand<{ account: SonGuessrMusicAccount }>("song.auth.useCookie", { cookie: storedSession.cookie })
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

  const runCommand = async (type: string, payload: Record<string, unknown> = {}, success?: string) => {
    if (inFlightCommandsRef.current.has(type)) return;
    inFlightCommandsRef.current.add(type);
    setPendingCommands((prev) => ({ ...prev, [type]: true }));
    try {
      await sendCommand(type, payload, isLongRunningCommand(type) ? { timeout: 0 } : undefined);
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
    } finally {
      inFlightCommandsRef.current.delete(type);
      setPendingCommands((prev) => {
        if (!prev[type]) return prev;
        const next = { ...prev };
        delete next[type];
        return next;
      });
    }
  };

  const leave = async () => {
    leavingRef.current = true;
    if (solo) clearSongSoloRoomId();
    await leaveRoom();
    navigate(exitPath, { replace: true });
  };

  return {
    roomId,
    exitPath,
    snapshot,
    privateState,
    joining,
    needsName,
    setNeedsName,
    nameDraft,
    setNameDraft,
    needsPassword,
    setNeedsPassword,
    passwordDraft,
    setPasswordDraft,
    pendingJoinName,
    handleConfirmName,
    handleConfirmPassword,
    runCommand,
    isPending,
    leave,
    sendCommand,
  };
}
