import { useCallback, useEffect, useRef, useState } from "react";
import { useOriginTracker } from "@/hooks/UseOriginTracker";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { randomRoomId } from "@/lib/Random";
import { getSavedUsername, saveUsername } from "@/lib/Storage";

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
  const setJoinTarget = useCallback((target: TRoom | null) => {
    if (!target && transaction.current) transaction.current.abort();
    updateJoinTarget(target);
  }, []);
  const [joinPassword, setJoinPassword] = useState("");
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
  const runEntry = useCallback(async (operation: (current: () => boolean, signal: AbortSignal) => Promise<void>) => {
    if (transaction.current || !mounted.current) return;
    const entry = new AbortController();
    transaction.current = entry;
    setPending(true);
    const current = () => mounted.current && !entry.signal.aborted && transaction.current === entry;
    try {
      await operation(current, entry.signal);
    } catch (error) {
      if (current()) showError((error as { message?: string } | null)?.message ?? "加入房间失败，请重试");
    } finally {
      if (transaction.current === entry) {
        transaction.current = null;
        if (mounted.current) setPending(false);
      }
    }
  }, [showError]);

  const handleJoinRoom = useCallback(
    async (room: TRoom, event: React.MouseEvent<HTMLElement>) => {
      if (!userName.trim()) { showError("请先设置用户名"); return; }
      await runEntry(async (current, signal) => {
        joinOrigin.capture(event);
        const reconnected = await reconnectRoom(room.roomId, signal);
        if (!current()) return;
        if (reconnected) {
          navigate(`${gamePath}/room/${encodeURIComponent(room.roomId)}`);
          return;
        }
        if (room.hasPassword) {
          updateJoinTarget(room);
          setJoinPassword("");
          return;
        }
        await joinRoom(room.roomId, userName.trim(), undefined, signal);
        if (current()) navigate(`${gamePath}/room/${encodeURIComponent(room.roomId)}`);
      });
    },
    [userName, reconnectRoom, joinRoom, navigate, gamePath, showError, runEntry, joinOrigin],
  );

  const handlePasswordJoin = useCallback(async () => {
    if (!joinTarget) return;
    await runEntry(async (current, signal) => {
      await joinRoom(joinTarget.roomId, userName.trim(), joinPassword, signal);
      if (!current()) return;
      updateJoinTarget(null);
      navigate(`${gamePath}/room/${encodeURIComponent(joinTarget.roomId)}`);
    });
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
      await runEntry(async (current, signal) => {
        const generatedRoomId = randomRoomId();
        await createRoom({ ...params, roomId: generatedRoomId, userName: userName.trim() }, signal);
        if (!current()) return;
        updateCreateOpen(false);
        navigate(`${gamePath}/room/${generatedRoomId}`);
      });
    },
    [userName, createRoom, navigate, gamePath, showError, runEntry],
  );

  const isInitialLoading = !hasLoadedOnce && rooms.length === 0;

  return {
    pending,
    userName,
    setUserName,
    createOpen,
    setCreateOpen,
    joinTarget,
    setJoinTarget,
    joinPassword,
    setJoinPassword,
    createOrigin,
    joinOrigin,
    handleJoinRoom,
    handlePasswordJoin,
    handleCreateRoom,
    isInitialLoading,
  };
}
