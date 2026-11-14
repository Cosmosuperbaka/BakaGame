import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { useCommandRunner } from "@/hooks/UseCommandRunner";
import { useSongMusicSessionSync } from "@/components/songuessr/UseSongMusicSessionSync";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import {
  SONGUESSR_COMMAND_POLICY,
  waitForConnection,
  type SonGuessrCommandMap,
} from "@/lib/SonGuessrWs";
import {
  clearSongSoloRoomId,
  getSavedUsername,
  getSongSoloRoomId,
  saveSongSoloRoomId,
  saveUsername,
} from "@/lib/Storage";
import { randomRoomId } from "@/lib/Random";
import { isValidRoomId, ROOM_ID_TEST_MODE } from "@bakagame/shared/values";
import type { SonGuessrCommand, SonGuessrPayload } from "@bakagame/shared";
import { errorCode, errorText } from "@/lib/ErrorMessage";

/** 密码缺失与密码错误都要重新弹出密码框，而不是直接退出房间。 */
const needsPasswordPrompt = (code?: string): boolean =>
  code === "PASSWORD_INCORRECT" || code === "PASSWORD_REQUIRED";

/**
 * 「发一条指令，失败落到横幅提示」的组件侧形状：命令名与载荷沿用 store `sendCommand` 的约束，
 * 组件里写 `run: (type: string, ...)` 会把这条通道又放宽回任意字符串。
 */
export type SongRunCommand = <TCommand extends SonGuessrCommand>(
  type: TCommand,
  payload?: SonGuessrPayload<TCommand>,
  success?: string
) => Promise<void>;

export function useSongRoomLifecycle({ solo = false }: { solo?: boolean } = {}) {
  const navigate = usePageNavigate();
  const { roomId: routeRoomId = "" } = useParams();
  const [soloRoomId, setSoloRoomId] = useState(() =>
    solo ? getSongSoloRoomId() || randomRoomId() : ""
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
  const showToast = useSonGuessrStore((state) => state.showToast);

  const alreadyInRoom = storedRoomId === roomId && snapshot?.roomId === roomId;
  const [joining, setJoining] = useState(!alreadyInRoom);
  const [needsName, setNeedsName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [pendingJoinName, setPendingJoinName] = useState("");

  const leavingRef = useRef(false);
  const entryRef = useRef<AbortController | null>(null);
  const [mountTime] = useState(() => Date.now());

  const { cancelMusicSessionUpload } = useSongMusicSessionSync({
    connected,
    snapshot,
    privateState,
    roomId,
    sendCommand,
    showToast,
  });

  const { run, isPending } = useCommandRunner<SonGuessrCommandMap>({
    send: sendCommand,
    policy: SONGUESSR_COMMAND_POLICY,
    pollSync: () => {
      void sendCommand("song.room.requestSync").catch(() => {});
    },
    onError: (error) => {
      if (errorCode(error) === "MUSIC_SESSION_INVALID") {
        cancelMusicSessionUpload();
        showToast(errorText(error, "音乐登录会话已失效，请重新确认登录状态"), "error");
        return;
      }
      showToast(errorText(error, "操作失败"), "error");
    },
    lock: "command",
  });

  /** 房间不存在时就地建房：建房成功或流程已中断都算收尾，只有建房失败才让调用方继续走退出。 */
  const createMissingRoom = useCallback(
    async (name: string, signal: AbortSignal): Promise<boolean> => {
      try {
        await createRoom(
          {
            roomId,
            name: roomId === ROOM_ID_TEST_MODE ? "Songuessr 测试房" : `${name}的房间`,
            visibility: "public",
            allowSpectators: true,
            userName: name,
          },
          signal
        );
        if (signal.aborted) return true;
        setJoining(false);
        return true;
      } catch (createError) {
        if (signal.aborted) return true;
        showToast(errorText(createError, "创建房间失败"), "error");
        return false;
      }
    },
    [createRoom, roomId, showToast]
  );

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
        const code = errorCode(error);
        if (code === "ROOM_NOT_FOUND") {
          if (await createMissingRoom(name, signal)) return;
        } else if (needsPasswordPrompt(code)) {
          setPendingJoinName(name);
          setPasswordDraft("");
          setNeedsPassword(true);
          setJoining(false);
          return;
        } else {
          showToast(errorText(error, "加入房间失败"), "error");
        }
        void navigate(exitPath, { replace: true });
      }
    },
    [createMissingRoom, exitPath, joinRoom, navigate, roomId, showToast]
  );

  const createSoloRoom = useCallback(
    async (targetRoomId: string, signal: AbortSignal) => {
      if (signal.aborted) return;
      await createRoom(
        {
          roomId: targetRoomId,
          name: "单人模式",
          visibility: "public",
          allowSpectators: false,
          userName: getSavedUsername() || "单人玩家",
          solo: true,
          // 单人房只有一个座位，允许 MCP 接管不会影响任何人；房主仍可在房里关掉。
          allowAgents: true,
        },
        signal
      );
      if (signal.aborted) return;
      saveSongSoloRoomId(targetRoomId);
    },
    [createRoom]
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
        if (errorCode(error) !== "ROOM_EXISTS") {
          showToast(errorText(error, "创建单人房间失败"), "error");
          void navigate("/", { replace: true });
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
        showToast(errorText(error, "创建单人房间失败"), "error");
        void navigate("/", { replace: true });
      }
    },
    [createSoloRoom, navigate, showToast]
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
      showToast("房间号无效，请检查链接", "error");
      void navigate(exitPath, { replace: true });
      return cleanup;
    }

    useSonGuessrStore.getState().clearRoomClosed();
    const tryEnter = async () => {
      setJoining(true);
      try {
        await waitForConnection();
      } catch {
        if (signal.aborted) return;
        showToast("连接服务器超时，请刷新重试", "error");
        void navigate(exitPath, { replace: true });
        return;
      }
      if (signal.aborted) return;
      let restored: boolean;
      try {
        restored = await reconnectRoom(roomId, signal);
      } catch (error) {
        if (signal.aborted) return;
        // 临时恢复失败不是“没有可恢复会话”，不能继续自动创建。
        showToast(errorText(error, "恢复房间失败，请重试"), "error");
        void navigate(exitPath, { replace: true });
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
    void navigate(exitPath, { replace: true });
  }, [exitPath, mountTime, navigate, roomClosedAt, solo]);

  const handleConfirmName = async () => {
    const name = nameDraft.trim();
    if (!name) {
      showToast("请输入用户名", "error");
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

  const runCommand: SongRunCommand = async (type, payload, success) => {
    await run(type, payload, {
      onSuccess: success ? () => showToast(success, "success") : undefined,
    });
  };

  // 先换页、页面卸载后再退房：退房会清空快照，若先退再走，跨页过渡拍下的旧页就成了加入中的占位（DesignGuide §8）。
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
    void navigate(exitPath, { replace: true });
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
