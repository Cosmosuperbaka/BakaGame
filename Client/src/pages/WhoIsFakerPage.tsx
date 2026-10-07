import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { useLobbySession } from "@/hooks/UseLobbySession";
import { CreateRoomDialog } from "@/components/common/CreateRoomDialog";
import { JoinPasswordDialog } from "@/components/common/lobby/JoinPasswordDialog";
import { LobbyPage } from "@/components/common/lobby/LobbyPage";
import type { LobbyRoomView } from "@/components/common/lobby/RoomListCard";
import type { WhoIsFakerRoomSummary } from "@/types";

/** 谁是卧底的大厅只区分「等待中」与「游戏中」两态。 */
const toRoomView = (room: WhoIsFakerRoomSummary): LobbyRoomView => ({
  roomId: room.roomId,
  name: room.name,
  hasPassword: room.hasPassword,
  inGame: room.phase !== "waiting" && room.phase !== "gameOver",
  allowSpectators: room.allowSpectators,
  playerCount: room.playerCount,
  spectatorCount: room.spectatorCount,
});

export default function WhoIsFakerPage() {
  const rooms = useWhoIsFakerStore((state) => state.rooms);
  const lobbyReady = useWhoIsFakerStore((state) => state.lobbyReady);
  const createRoom = useWhoIsFakerStore((state) => state.createRoom);
  const joinRoom = useWhoIsFakerStore((state) => state.joinRoom);
  const reconnectRoom = useWhoIsFakerStore((state) => state.reconnectRoom);
  const addToast = useWhoIsFakerStore((state) => state.addToast);

  const {
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
    pending,
    pendingRoomId,
  } = useLobbySession<WhoIsFakerRoomSummary>({
    gamePath: "/whoisfaker",
    rooms,
    ready: lobbyReady,
    createRoom,
    joinRoom,
    reconnectRoom,
    showError: (message) => addToast(message, "error"),
  });

  return (
    <LobbyPage
      path="/whoisfaker"
      // Faker.png 就是「Faker」这个词：顶栏写「Who is」接图标，读屏与按名查找仍得到完整的「Who is Faker」。
      title="Who is"
      logo={{ src: "/assets/Faker.png", alt: "Faker" }}
      titleLabel="Who is Faker"
      rooms={rooms.map(toRoomView)}
      disabled={pending}
      loading={isInitialLoading}
      pendingRoomId={pendingRoomId}
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
          onCreate={handleCreateRoom}
        />
        <JoinPasswordDialog
          pending={pending}
          roomName={joinTarget?.name ?? null}
          origin={joinOrigin.origin}
          password={joinPassword}
          onPasswordChange={setJoinPassword}
          error={joinError}
          onCancel={() => setJoinTarget(null)}
          onConfirm={() => void handlePasswordJoin()}
        />
      </>}
    />
  );
}
