import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { useLobbySession } from "@/hooks/UseLobbySession";
import { CreateRoomDialog } from "@/components/common/CreateRoomDialog";
import { JoinPasswordDialog } from "@/components/common/lobby/JoinPasswordDialog";
import { LobbyPage } from "@/components/common/lobby/LobbyPage";
import type { LobbyRoomView } from "@/components/common/lobby/RoomListCard";
import type { SonGuessrRoomSummary } from "@/types";

/** 猜歌的大厅只区分「等待中」与「游戏中」两态。 */
const toRoomView = (room: SonGuessrRoomSummary): LobbyRoomView => ({
  roomId: room.roomId,
  name: room.name,
  hasPassword: room.hasPassword,
  inGame: room.phase !== "waiting" && room.phase !== "roundResult",
  allowSpectators: room.allowSpectators,
  playerCount: room.playerCount,
  spectatorCount: room.spectatorCount,
});

export default function SonGuessrPage() {
  const rooms = useSonGuessrStore((state) => state.rooms);
  const lobbyReady = useSonGuessrStore((state) => state.lobbyReady);
  const createRoom = useSonGuessrStore((state) => state.createRoom);
  const joinRoom = useSonGuessrStore((state) => state.joinRoom);
  const reconnectRoom = useSonGuessrStore((state) => state.reconnectRoom);
  const setNotice = useSonGuessrStore((state) => state.setNotice);

  const {
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
    pending,
  } = useLobbySession<SonGuessrRoomSummary>({
    gamePath: "/songuessr",
    rooms,
    ready: lobbyReady,
    createRoom,
    joinRoom,
    reconnectRoom,
    showError: (message) => setNotice(message, "error"),
  });

  return (
    <LobbyPage
      path="/songuessr"
      title="Songuessr"
      rooms={rooms.map(toRoomView)}
      disabled={pending}
      loading={isInitialLoading}
      children={pending ? <p role="status" className="mb-3 text-sm text-muted-foreground">正在进入房间…</p> : undefined}
      userName={userName}
      onUserNameChange={setUserName}
      onCreate={(event) => { createOrigin.capture(event); setCreateOpen(true); }}
      onSelectRoom={(room, event) => {
        const target = rooms.find((candidate) => candidate.roomId === room.roomId);
        if (target) void handleJoinRoom(target, event);
      }}
      dialogs={<>
        <CreateRoomDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          origin={createOrigin.origin}
          defaultName={userName.trim() ? `${userName.trim()}的房间` : "新房间"}
          nameMaxLength={40}
          onValidationError={(message) => setNotice(message, "error")}
          onCreate={handleCreateRoom}
        />
        <JoinPasswordDialog
          pending={pending}
          roomName={joinTarget?.name ?? null}
          origin={joinOrigin.origin}
          password={joinPassword}
          onPasswordChange={setJoinPassword}
          onCancel={() => setJoinTarget(null)}
          onConfirm={() => void handlePasswordJoin()}
        />
      </>}
    />
  );
}
