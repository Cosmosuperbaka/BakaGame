import { useCallback, useEffect, useRef, useState } from "react";
import { useOriginTracker } from "@/hooks/UseOriginTracker";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { randomRoomId } from "@/lib/Random";
import { getSavedUsername, saveUsername } from "@/lib/Storage";

/** 密码弹窗里的加入失败：写在密码框下方，`invalid` 只在确属密码错误时标红输入框。 */
export interface JoinPasswordError {
  message: string;
  invalid: boolean;
}

const errorMessage = (error: unknown, fallback: string) => (error as { message?: string } | null)?.message ?? fallback;

export interface LobbyRoomTarget {
  roomId: string;
  name: string;
  hasPassword?: boolean;
}

export interface UseLobbySessionOptions<TRoom extends LobbyRoomTarget> {
  gamePath: string;
  rooms: TRoom[];
  /** 本次连接已收到首个房间列表。只连上 WS 不算：订阅回包之前列表必然为空，会闪「暂无房间」。 */
  ready: boolean;
  createRoom: (params: {
    roomId: string;
    name: string;
    password?: string;
    visibility: "public" | "private";
    allowSpectators: boolean;
    userName: string;
    [key: string]: unknown;
  }, signal?: AbortSignal) => Promise<unknown>;
  joinRoom: (roomId: string, userName: string, password?: string, signal?: AbortSignal) => Promise<unknown>;
  reconnectRoom: (roomId: string, signal?: AbortSignal) => Promise<boolean>;
  showError: (message: string) => void;
}

export function useLobbySession<TRoom extends LobbyRoomTarget>({
  gamePath,
  rooms,
  ready,
  createRoom,
  joinRoom,
  reconnectRoom,
  showError,
}: UseLobbySessionOptions<TRoom>) {
  const navigate = usePageNavigate();
  const mounted = useRef(false);
  const transaction = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  // 正在进入的那张卡片：大厅在卡片上转圈，不在列表上方插一行把整列推下去。
  const [pendingRoomId, setPendingRoomId] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (transaction.current) transaction.current.abort();
    };
  }, [gamePath]);
  const [userName, setUserName] = useState(getSavedUsername);
  const [createOpen, updateCreateOpen] = useState(false);
  const setCreateOpen = useCallback((open: boolean) => {
    if (!open && transaction.current) transaction.current.abort();
    updateCreateOpen(open);
  }, []);
  const [joinTarget, updateJoinTarget] = useState<TRoom | null>(null);
  const [joinError, setJoinError] = useState<JoinPasswordError | null>(null);
  const setJoinTarget = useCallback((target: TRoom | null) => {
    if (!target && transaction.current) transaction.current.abort();
    updateJoinTarget(target);
    setJoinError(null);
  }, []);
  const [joinPassword, updateJoinPassword] = useState("");
  // 改密码即撤下上一次的错误：标红只说明「刚才那次」不对。
  const setJoinPassword = useCallback((password: string) => {
    updateJoinPassword(password);
    setJoinError(null);
  }, []);
  // 首次就绪后锁定：断线重连期间保留旧列表，不再退回骨架屏。
  const [hasLoadedOnce, setHasLoadedOnce] = useState(ready);
  if (ready && !hasLoadedOnce) {
    setHasLoadedOnce(true);
  }
  const createOrigin = useOriginTracker();
  const joinOrigin = useOriginTracker();

  useEffect(() => {
    if (userName.trim()) saveUsername(userName.trim());
  }, [userName]);

  // 同一大厅一次只拥有一个入房事务；取消保留锁直到 ACK 落定，不与新意图并发。
  // 失败默认走 Toast；有就近位置可写的（密码弹窗、建房弹窗）经 `onError` 接走，只走一种渠道。
  const runEntry = useCallback(async (
    operation: (current: () => boolean, signal: AbortSignal) => Promise<void>,
    onError: (error: unknown) => void = (error) => showError(errorMessage(error, "加入房间失败，请重试")),
  ) => {
    if (transaction.current || !mounted.current) return;
    const entry = new AbortController();
    transaction.current = entry;
    setPending(true);
    const current = () => mounted.current && !entry.signal.aborted && transaction.current === entry;
    try {
      await operation(current, entry.signal);
    } catch (error) {
      if (current()) onError(error);
    } finally {
      if (transaction.current === entry) {
        transaction.current = null;
        if (mounted.current) {
          setPending(false);
          setPendingRoomId(null);
        }
      }
    }
  }, [showError]);

  const handleJoinRoom = useCallback(
    async (room: TRoom, event: React.MouseEvent<HTMLElement>) => {
      // 大厅页在点击前已拦下空用户名并标出输入框；这里只兜住直接调用的情况。
      if (!userName.trim()) { showError("请先设置用户名"); return; }
      await runEntry(async (current, signal) => {
        setPendingRoomId(room.roomId);
        joinOrigin.capture(event);
        const reconnected = await reconnectRoom(room.roomId, signal);
        if (!current()) return;
        if (reconnected) {
          navigate(`${gamePath}/room/${encodeURIComponent(room.roomId)}`);
          return;
        }
        if (room.hasPassword) {
          updateJoinTarget(room);
          updateJoinPassword("");
          setJoinError(null);
          return;
        }
        await joinRoom(room.roomId, userName.trim(), undefined, signal);
        if (current()) navigate(`${gamePath}/room/${encodeURIComponent(room.roomId)}`);
      });
    },
    [userName, reconnectRoom, joinRoom, navigate, gamePath, showError, runEntry, joinOrigin],
  );

  const handlePasswordJoin = useCallback(async () => {
    if (!joinTarget || !joinPassword.trim()) return;
    setJoinError(null);
    await runEntry(async (current, signal) => {
      await joinRoom(joinTarget.roomId, userName.trim(), joinPassword, signal);
      if (!current()) return;
      updateJoinTarget(null);
      navigate(`${gamePath}/room/${encodeURIComponent(joinTarget.roomId)}`);
    }, (error) => setJoinError({
      message: errorMessage(error, "加入房间失败，请重试"),
      // 只有密码本身不对才标红输入框；次数过多、房间已关闭等归不到这个字段，只给文案。
      invalid: (error as { code?: string } | null)?.code === "PASSWORD_INCORRECT",
    }));
  }, [joinTarget, joinPassword, userName, joinRoom, navigate, gamePath, runEntry]);

  const handleCreateRoom = useCallback(
    async (params: {
      name: string;
      password?: string;
      visibility: "public" | "private";
      allowSpectators: boolean;
      [key: string]: unknown;
    }) => {
      if (!userName.trim()) { showError("请先设置用户名"); return; }
      // 建房失败抛回给建房弹窗，由它写在表单里（只走这一种渠道，不再另弹 Toast）；弹窗已关闭、页面已离开的过期失败照旧静默。
      const outcome: { failed: boolean; error?: unknown } = { failed: false };
      await runEntry(async (current, signal) => {
        const generatedRoomId = randomRoomId();
        await createRoom({ ...params, roomId: generatedRoomId, userName: userName.trim() }, signal);
        if (!current()) return;
        updateCreateOpen(false);
        navigate(`${gamePath}/room/${generatedRoomId}`);
      }, (error) => { outcome.failed = true; outcome.error = error; });
      if (outcome.failed) throw outcome.error;
    },
    [userName, createRoom, navigate, gamePath, showError, runEntry],
  );

  const isInitialLoading = !hasLoadedOnce && rooms.length === 0;

  return {
    pending,
    pendingRoomId,
    userName,
    setUserName,
    createOpen,
    setCreateOpen,
    joinTarget,
    setJoinTarget,
    joinPassword,
    setJoinPassword,
    joinError,
    createOrigin,
    joinOrigin,
    handleJoinRoom,
    handlePasswordJoin,
    handleCreateRoom,
    isInitialLoading,
  };
}
