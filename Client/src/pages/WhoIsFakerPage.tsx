import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { useLobbySession } from "@/hooks/UseLobbySession";
import { GameLobbyScreen } from "@/components/common/lobby/GameLobbyScreen";
import type { LobbyRoomView } from "@/components/common/lobby/RoomListCard";
import {
  markPendingRestore,
  readRoomCreateDefaults,
  saveRoomCreateDefaults,
} from "@/lib/RoomSettingsMemory";
import type { WhoIsFakerRoomSummary } from "@bakagame/shared";

/** 谁是卧底的大厅只区分「等待中」与「游戏中」两态。 */
const toRoomView = (room: WhoIsFakerRoomSummary): LobbyRoomView => ({
  roomId: room.roomId,
  name: room.name,
  hasPassword: room.hasPassword,
  inGame: room.phase !== "waiting" && room.phase !== "gameOver",
  allowSpectators: room.allowSpectators,
  playerCount: room.playerCount,
  spectatorCount: room.spectatorCount,
  mcpAvailable: room.allowAgents,
});

export default function WhoIsFakerPage() {
  const rooms = useWhoIsFakerStore((state) => state.rooms);
  const lobbyReady = useWhoIsFakerStore((state) => state.lobbyReady);
  const createRoom = useWhoIsFakerStore((state) => state.createRoom);
  const joinRoom = useWhoIsFakerStore((state) => state.joinRoom);
  const reconnectRoom = useWhoIsFakerStore((state) => state.reconnectRoom);
  const showToast = useWhoIsFakerStore((state) => state.showToast);

  const session = useLobbySession<WhoIsFakerRoomSummary>({
    gamePath: "/whoisfaker",
    rooms,
    ready: lobbyReady,
    createRoom,
    joinRoom,
    reconnectRoom,
    showError: (message) => showToast(message, "error"),
    // 创建成功后记住这次的选项并登记：进房后等待页据此把上次的房间设置套进新房间。
    onRoomCreated: (roomId, params) => {
      saveRoomCreateDefaults("faker", {
        visibility: params.visibility,
        allowSpectators: params.allowSpectators,
      });
      markPendingRestore("faker", roomId);
    },
  });

  return (
    <GameLobbyScreen
      session={session}
      rooms={rooms}
      toRoomView={toRoomView}
      header={{
        path: "/whoisfaker",
        // Faker.png 就是「Faker」这个词：顶栏写「Who is」接图标，读屏与按名查找仍得到完整的「Who is Faker」。
        title: "Who is",
        logo: { src: "/assets/Faker.png", alt: "Faker" },
        titleLabel: "Who is Faker",
      }}
      createDialog={{
        nameMaxLength: 40,
        defaults: readRoomCreateDefaults("faker"),
      }}
    />
  );
}
