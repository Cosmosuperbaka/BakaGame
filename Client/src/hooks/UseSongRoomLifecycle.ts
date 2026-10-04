import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { usePageNavigate } from "@/hooks/UsePageTransition";
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
  const navigate = usePageNavigate();
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
  const entryRef = useRef<AbortController | null>(null);
  const [mountTime] = useState(() => Date.now());
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
    async (name: string, signal: AbortSignal, password?: string) => {
      if (signal.aborted) return;
      setJoining(true);
      try {
        await joinRoom(roomId, name, password, signal);
        if (signal.aborted) return;
        setNeedsPassword(false);
        setJoining(false);
      } catch (error) {
        if (signal.aborted) return;
        const appError = error as { code?: string; message?: string };
        if (appError.code === "ROOM_NOT_FOUND") {
          try {
            await createRoom({
              roomId,
              name: roomId === ROOM_ID_TEST_MODE ? "Songuessr 测试房" : `${name}的房间`,
              visibility: "public",
              allowSpectators: true,
              userName: name,
            }, signal);
            if (signal.aborted) return;
            setJoining(false);
            return;
          } catch (createError) {
            if (signal.aborted) return;
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
    async (targetRoomId: string, signal: AbortSignal) => {
      if (signal.aborted) return;
      await createRoom({
        roomId: targetRoomId,
        name: "单人模式",
        visibility: "public",
        allowSpectators: false,
        userName: getSavedUsername() || "单人玩家",
        solo: true,
      }, signal);
      if (signal.aborted) return;
      saveSongSoloRoomId(targetRoomId);
    },
    [createRoom],
  );

  const enterSoloRoom = useCallback(
    async (targetRoomId: string, signal: AbortSignal) => {
      if (signal.aborted) return;
      try {
        await createSoloRoom(targetRoomId, signal);
        if (signal.aborted) return;
        setJoining(false);
        return;
      } catch (error) {
        if (signal.aborted) return;
        if ((error as { code?: string }).code !== "ROOM_EXISTS") {
          setNotice((error as { message?: string }).message ?? "创建单人房间失败", "error");
          navigate("/", { replace: true });
          return;
        }
      }
      const nextRoomId = randomRoomId();
      try {
        await createSoloRoom(nextRoomId, signal);
        if (signal.aborted) return;
        // ACK 落定后才切换路由身份，避免 roomId effect 清理取消本次重试。
        setSoloRoomId(nextRoomId);
        setJoining(false);
      } catch (error) {
        if (signal.aborted) return;
        setNotice((error as { message?: string }).message ?? "创建单人房间失败", "error");
        navigate("/", { replace: true });
      }
    },
    [createSoloRoom, navigate, setNotice],
  );

  useEffect(() => {
    useSonGuessrStore.getState().clearRoomClosed();
    return () => {
      useSonGuessrStore.getState().clearRoomClosed();
    };
  }, []);

  useEffect(() => {
    const entry = new AbortController();
    entryRef.current = entry;
    leavingRef.current = false;
    const { signal } = entry;
    const cleanup = () => {
      entry.abort();
      if (entryRef.current === entry) entryRef.current = null;
    };
    // 只按房间身份清理；snapshot/ACK 更新不能取消已成功接入的会话。
    if (!roomId || alreadyInRoom) return cleanup;
    if (!isValidRoomId(roomId)) {
      setNotice("房间号无效，请检查链接", "error");
      navigate(exitPath, { replace: true });
      return cleanup;
    }

    useSonGuessrStore.getState().clearRoomClosed();
    const tryEnter = async () => {
      setJoining(true);
      try {
        await sonGuessrWs.waitForConnection(8_000);
      } catch {
        if (signal.aborted) return;
        setNotice("连接服务器超时，请刷新重试", "error");
        navigate(exitPath, { replace: true });
        return;
      }
      if (signal.aborted) return;
      let restored: boolean;
      try {
        restored = await reconnectRoom(roomId, signal);
      } catch (error) {
        if (signal.aborted) return;
        // 临时恢复失败不是“没有可恢复会话”，不能继续自动创建。
        setNotice((error as { message?: string }).message ?? "恢复房间失败，请重试", "error");
        navigate(exitPath, { replace: true });
        return;
      }
      if (signal.aborted) return;
      if (restored) {
        setJoining(false);
        return;
      }
      const closedAt = useSonGuessrStore.getState().roomClosedAt;
      if (closedAt !== null && closedAt >= mountTime) return;
      if (solo) {
        await enterSoloRoom(roomId, signal);
        if (signal.aborted) return;
        return;
      }
      const savedName = getSavedUsername();
      if (!savedName) {
        setJoining(false);
        setNameDraft("");
        setNeedsName(true);
        return;
      }
      await enterWithName(savedName, signal);
      if (signal.aborted) return;
    };
    void tryEnter();
    return cleanup;
  }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!roomClosedAt || roomClosedAt < mountTime || leavingRef.current) return;
    entryRef.current?.abort();
    useSonGuessrStore.getState().clearRoomClosed();
    if (solo) clearSongSoloRoomId();
    navigate(exitPath, { replace: true });
  }, [exitPath, mountTime, navigate, roomClosedAt, solo]);

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
    const signal = entryRef.current?.signal;
    if (!signal || signal.aborted) return;
    await enterWithName(name, signal);
    if (signal.aborted) return;
  };

  const handleConfirmPassword = async () => {
    if (!pendingJoinName || !passwordDraft.trim()) return;
    setNeedsPassword(false);
    const signal = entryRef.current?.signal;
    if (!signal || signal.aborted) return;
    await enterWithName(pendingJoinName, signal, passwordDraft);
    if (signal.aborted) return;
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

  // 先换页、页面卸载后再退房：退房会清空快照，若先退再走，跨页过渡拍下的旧页就成了加入中的占位（Animation §2.4）。
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    if (!exiting) return;
    return () => void useSonGuessrStore.getState().leaveRoom();
  }, [exiting]);

  const leave = () => {
    entryRef.current?.abort();
    leavingRef.current = true;
    if (solo) clearSongSoloRoomId();
    setExiting(true);
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
