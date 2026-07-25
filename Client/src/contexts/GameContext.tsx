import { useEffect, type ReactNode } from "react";
import { useGameStore, initGameSocket } from "@/stores/useGameStore";

export function GameProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const cleanup = initGameSocket();
    return cleanup;
  }, []);

  return <>{children}</>;
}

/**
 * 保持向后兼容的 useGame Hook，背后由 Zustand 高性能 Store 驱动
 */
export function useGame() {
  const store = useGameStore();

  return {
    state: {
      connected: store.connected,
      rooms: store.rooms,
      roomId: store.roomId,
      sessionToken: store.sessionToken,
      snapshot: store.snapshot,
      privateState: store.privateState,
      sessionConflictRoomId: store.sessionConflictRoomId,
      toasts: store.toasts,
    },
    dispatch: () => {
      // 兼容接口
    },
    subscribeLobby: store.subscribeLobby,
    createRoom: store.createRoom,
    joinRoom: store.joinRoom,
    reconnectRoom: store.reconnectRoom,
    leaveRoom: store.leaveRoom,
    sendCommand: store.sendCommand,
    addToast: store.addToast,
  };
}
