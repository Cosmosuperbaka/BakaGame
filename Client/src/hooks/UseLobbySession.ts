import { useCallback, useEffect, useState } from "react";
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
  }) => Promise<unknown>;
  joinRoom: (roomId: string, userName: string, password?: string) => Promise<unknown>;
  reconnectRoom: (roomId: string) => Promise<boolean>;
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
  const [userName, setUserName] = useState(getSavedUsername);
  const [createOpen, setCreateOpen] = useState(false);
  const [joinTarget, setJoinTarget] = useState<TRoom | null>(null);
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

  const handleJoinRoom = useCallback(
    async (room: TRoom, event: React.MouseEvent<HTMLElement>) => {
      joinOrigin.capture(event);
      if (!userName.trim()) {
        showError("请先设置用户名");
        return;
      }
      const reconnected = await reconnectRoom(room.roomId);
      if (reconnected) {
        navigate(`${gamePath}/room/${room.roomId}`);
        return;
      }
      if (room.hasPassword) {
        setJoinTarget(room);
        setJoinPassword("");
      } else {
        try {
          await joinRoom(room.roomId, userName.trim());
          navigate(`${gamePath}/room/${room.roomId}`);
        } catch (e) {
          showError((e as { message: string }).message);
        }
      }
    },
    [userName, reconnectRoom, joinRoom, navigate, gamePath, showError], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handlePasswordJoin = useCallback(async () => {
    if (!joinTarget) return;
    try {
      await joinRoom(joinTarget.roomId, userName.trim(), joinPassword);
      setJoinTarget(null);
      navigate(`${gamePath}/room/${joinTarget.roomId}`);
    } catch (e) {
      showError((e as { message: string }).message);
    }
  }, [joinTarget, joinPassword, userName, joinRoom, navigate, gamePath, showError]);

  const handleCreateRoom = useCallback(
    async (params: {
      name: string;
      password?: string;
      visibility: "public" | "private";
      allowSpectators: boolean;
      [key: string]: unknown;
    }) => {
      if (!userName.trim()) {
        showError("请先设置用户名");
        return;
      }
      try {
        const generatedRoomId = randomRoomId();
        await createRoom({
          ...params,
          roomId: generatedRoomId,
          userName: userName.trim(),
        });
        setCreateOpen(false);
        navigate(`${gamePath}/room/${generatedRoomId}`);
      } catch (e) {
        showError((e as { message: string }).message);
      }
    },
    [userName, createRoom, navigate, gamePath, showError],
  );

  const isInitialLoading = !hasLoadedOnce && rooms.length === 0;

  return {
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
