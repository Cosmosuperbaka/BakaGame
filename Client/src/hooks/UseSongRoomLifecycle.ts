import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { waitForConnection } from "@/lib/SonGuessrWs";
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
  type StoredSongMusicSession,
} from "@/lib/SonGuessrMusicSession";
import {
  isValidRoomId,
  ROOM_ID_TEST_MODE,
  type SonGuessrAck,
  type SonGuessrCommand,
  type SonGuessrPayload,
} from "@bakagame/shared";

const LONG_RUNNING_COMMANDS = ["song.game.start", "song.game.nextRound"] as const;
const LONG_RUNNING_POLL_INTERVAL_MS = 3_000;

/**
 * 把本机凭据装载进房间的退避重试节奏。
 *
 * 这一步要等网易云校验凭据，属于上游决定耗时的操作：单发一次失败时，房间徽标会一直停在
 * 「正在连接」，直到下一次与凭据无关的快照变化（房间活动，空闲房间则是 60 秒全量校准）
 * 才重新触发。固定退避把这种情况收敛到秒级，同时重试次数有界，不会放大上游压力。
 */
const MUSIC_SESSION_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

/** 上游抖动与传输层失败值得重试；会话失效、非房主这类业务拒绝重试也不会变好。 */
const TRANSIENT_MUSIC_SESSION_ERROR_CODES = new Set([
  "MUSIC_API_RATE_LIMITED",
  "MUSIC_API_BUSY",
  "MUSIC_API_FAILED",
  "TIMEOUT",
  "DISCONNECTED",
  "NOT_CONNECTED",
]);

const isTransientMusicSessionError = (error: { code?: string }): boolean =>
  error.code === undefined || TRANSIENT_MUSIC_SESSION_ERROR_CODES.has(error.code);

/** 同一房间、席位与凭据只允许一个装载事务；`settled` 表示已经落定，不再重复上传。 */
interface MusicSessionTask {
  key: string;
  keyPrefix?: string;
  cancelled: boolean;
  settled: boolean;
}

/** `song.auth.useCookie` 的回包：装载凭据后服务端确认的账号与本次实际生效的 cookie。 */
type MusicSessionAuthResult = SonGuessrAck<"song.auth.useCookie">;

/** 上游给出账号资料后，把本次实际生效的 cookie 写回本地凭据与事务键。 */
function settleMusicSessionUpload(
  task: MusicSessionTask,
  platform: "netease" | "qq",
  storedSession: StoredSongMusicSession,
  result: MusicSessionAuthResult | undefined
): void {
  if (!result?.account) return;
  const nextCookie = result.cookie || storedSession.cookie;
  if (task.keyPrefix) {
    task.key = `${task.keyPrefix}:${nextCookie}`;
  }
  saveSongMusicSession(
    { cookie: nextCookie, account: { ...result.account, platform } },
    storedSession.persistent,
    platform
  );
}

/** 返回 `undefined` 表示不再重试：重试用尽或确定性拒绝，交回给下一次快照变化（房间活动或周期校准）再装一次。 */
function musicSessionRetryDelay(attempt: number, error: { code?: string }): number | undefined {
  const delay = MUSIC_SESSION_RETRY_DELAYS_MS[attempt];
  if (delay === undefined || !isTransientMusicSessionError(error)) return undefined;
  return delay;
}

/** 密码缺失与密码错误都要重新弹出密码框，而不是直接退出房间。 */
const needsPasswordPrompt = (code?: string): boolean =>
  code === "PASSWORD_INCORRECT" || code === "PASSWORD_REQUIRED";

export const isLongRunningCommand = (type: string): boolean =>
  (LONG_RUNNING_COMMANDS as readonly string[]).includes(type);

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
  const musicSessionTasksRef = useRef<{
    netease: MusicSessionTask | null;
    qq: MusicSessionTask | null;
  }>({ netease: null, qq: null });
  const inFlightCommandsRef = useRef<Set<string>>(new Set());
  const [pendingCommands, setPendingCommands] = useState<Record<string, boolean>>({});

  useEffect(() => {
    sendCommandRef.current = sendCommand;
  }, [sendCommand]);

  /** 终止指定或全部平台的当前装载事务：在途请求与待执行的退避都作废，下一次快照变化可重新发起。 */
  const cancelMusicSessionUpload = useCallback((platform?: "netease" | "qq") => {
    if (!platform || platform === "netease") {
      const task = musicSessionTasksRef.current.netease;
      if (task) task.cancelled = true;
      musicSessionTasksRef.current.netease = null;
    }
    if (!platform || platform === "qq") {
      const task = musicSessionTasksRef.current.qq;
      if (task) task.cancelled = true;
      musicSessionTasksRef.current.qq = null;
    }
  }, []);

  const uploadMusicSession = useCallback(
    async (
      task: MusicSessionTask,
      platform: "netease" | "qq",
      storedSession: StoredSongMusicSession
    ) => {
      const platformName = platform === "qq" ? "QQ音乐" : "网易云";
      for (let attempt = 0; ; attempt += 1) {
        if (task.cancelled) return;
        try {
          const result = await sendCommand("song.auth.useCookie", {
            cookie: storedSession.cookie,
            platform,
          });
          if (task.cancelled) return;
          task.settled = true;
          settleMusicSessionUpload(task, platform, storedSession, result);
          return;
        } catch (error) {
          if (task.cancelled) return;
          const appError = error as { code?: string; message?: string };
          if (appError.code === "MUSIC_SESSION_INVALID") {
            cancelMusicSessionUpload(platform);
            clearStoredSongMusicSession(platform);
            setNotice(`${platformName}登录状态已失效，请重新扫码登录`, "error");
            return;
          }
          const delay = musicSessionRetryDelay(attempt, appError);
          if (delay === undefined) {
            cancelMusicSessionUpload(platform);
            return;
          }
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, delay);
          });
        }
      }
    },
    [cancelMusicSessionUpload, sendCommand, setNotice]
  );

  useEffect(() => () => cancelMusicSessionUpload(), [cancelMusicSessionUpload]);

  const isPending = useCallback(
    (type: string) => Boolean(pendingCommands[type]),
    [pendingCommands]
  );

  const longRunningPending = LONG_RUNNING_COMMANDS.some((type) => Boolean(pendingCommands[type]));
  useEffect(() => {
    if (!longRunningPending) return;
    const timer = setInterval(() => {
      void sendCommandRef.current("song.room.requestSync").catch(() => {});
    }, LONG_RUNNING_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [longRunningPending]);

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
        setNotice((createError as { message?: string }).message ?? "创建房间失败", "error");
        return false;
      }
    },
    [createRoom, roomId, setNotice]
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
        const appError = error as { code?: string; message?: string };
        if (appError.code === "ROOM_NOT_FOUND") {
          if (await createMissingRoom(name, signal)) return;
        } else if (needsPasswordPrompt(appError.code)) {
          setPendingJoinName(name);
          setPasswordDraft("");
          setNeedsPassword(true);
          setJoining(false);
          return;
        } else {
          setNotice(appError.message ?? "加入房间失败", "error");
        }
        void navigate(exitPath, { replace: true });
      }
    },
    [createMissingRoom, exitPath, joinRoom, navigate, roomId, setNotice]
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
        if ((error as { code?: string }).code !== "ROOM_EXISTS") {
          setNotice((error as { message?: string }).message ?? "创建单人房间失败", "error");
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
        setNotice((error as { message?: string }).message ?? "创建单人房间失败", "error");
        void navigate("/", { replace: true });
      }
    },
    [createSoloRoom, navigate, setNotice]
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
      void navigate(exitPath, { replace: true });
      return cleanup;
    }

    useSonGuessrStore.getState().clearRoomClosed();
    const tryEnter = async () => {
      setJoining(true);
      try {
        await waitForConnection(8_000);
      } catch {
        if (signal.aborted) return;
        setNotice("连接服务器超时，请刷新重试", "error");
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
        setNotice((error as { message?: string }).message ?? "恢复房间失败，请重试", "error");
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

  useEffect(() => {
    const handleSessionChanged = () => setMusicSessionRevision((revision) => revision + 1);
    window.addEventListener(SONGUESSR_MUSIC_SESSION_CHANGED, handleSessionChanged);
    return () => window.removeEventListener(SONGUESSR_MUSIC_SESSION_CHANGED, handleSessionChanged);
  }, []);

  useEffect(() => {
    if (!connected) {
      cancelMusicSessionUpload();
      return;
    }
    if (
      !snapshot ||
      !privateState ||
      snapshot.roomId !== roomId ||
      // 账号只在准备页自动装载：B4 之后谁都能贡献自己的号，但共享开关是「等待阶段才可改」，
      // 局中把本机凭据塞进池子只会让池子与实际生效的开关状态对不上（服务端 installMusicSession
      // 也按这一条决定新号是否默认入池）。
      snapshot.phase !== "waiting"
    ) {
      cancelMusicSessionUpload();
      return;
    }

    const platforms: ("netease" | "qq")[] = ["netease", "qq"];
    for (const platform of platforms) {
      const storedSession = getStoredSongMusicSession(platform);
      if (!storedSession) {
        cancelMusicSessionUpload(platform);
        continue;
      }
      const keyPrefix = `${snapshot.roomId}:${privateState.playerId}:${platform}`;
      const mountKey = `${keyPrefix}:${storedSession.cookie}`;
      const active = musicSessionTasksRef.current[platform];
      // 同一房间、席位与凭据：在途或已落定的装载都不重发；快照变化不能取消正在退避重试的装载。
      if (active?.key === mountKey && (active.settled || !active.cancelled)) continue;

      // 只看我自己那条池记录：池里排在前面的往往是别人的号，拿它判「已在房」会永远跳过自己的装载。
      const mine = snapshot.musicPool?.find(
        (entry) => entry.playerId === privateState.playerId && entry.platform === platform
      );
      const myAccount = mine
        ? mine.account
        : snapshot.musicPool === undefined
          ? snapshot.musicAccounts?.[platform]
          : undefined;
      // 池里已经是我这一份凭据（同一个账号）就不用再传：服务端已经有了，重传只会多跑一次上游校验。
      // 服务端对「同一份凭据」不改共享开关，所以这里也读不出开或关，开关状态仍以服务端快照为准。
      if (
        (myAccount?.userId && myAccount.userId === storedSession.account?.userId) ||
        (active?.key === mountKey && active.settled)
      ) {
        continue;
      }

      cancelMusicSessionUpload(platform);
      const task: MusicSessionTask = { key: mountKey, keyPrefix, cancelled: false, settled: false };
      musicSessionTasksRef.current[platform] = task;
      void uploadMusicSession(task, platform, storedSession);
    }
  }, [
    cancelMusicSessionUpload,
    connected,
    musicSessionRevision,
    privateState,
    roomId,
    snapshot,
    uploadMusicSession,
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

  const runCommand: SongRunCommand = async (type, payload, success) => {
    if (inFlightCommandsRef.current.has(type)) return;
    inFlightCommandsRef.current.add(type);
    setPendingCommands((prev) => ({ ...prev, [type]: true }));
    try {
      await sendCommand(type, payload, isLongRunningCommand(type) ? { timeout: 0 } : undefined);
      if (success) setNotice(success, "success");
    } catch (error) {
      const appError = error as { code?: string; message?: string };
      if (appError.code === "MUSIC_SESSION_INVALID") {
        cancelMusicSessionUpload();
        setNotice(appError.message ?? "音乐登录会话已失效，请重新确认登录状态", "error");
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
