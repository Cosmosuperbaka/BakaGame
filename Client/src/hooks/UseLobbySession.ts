import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useOriginTracker } from "@/hooks/UseOriginTracker";
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
  connected: boolean;
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
  connected,
  createRoom,
  joinRoom,
  reconnectRoom,
  showError,
}: UseLobbySessionOptions<TRoom>) {
  const navigate = useNavigate();
  const [userName, setUserName] = useState(getSavedUsername);
  const [createOpen, setCreateOpen] = useState(false);
  const [joinTarget, setJoinTarget] = useState<TRoom | null>(null);
  const [joinPassword, setJoinPassword] = useState("");
  const [hasConnectedOnce, setHasConnectedOnce] = useState(connected);
  if (connected && !hasConnectedOnce) {
    setHasConnectedOnce(true);
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

  const isInitialLoading = !hasConnectedOnce && rooms.length === 0;

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
