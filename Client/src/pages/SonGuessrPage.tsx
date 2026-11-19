import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { useLobbySession } from "@/hooks/UseLobbySession";
import { GameLobbyScreen } from "@/components/common/lobby/GameLobbyScreen";
import type { LobbyRoomView } from "@/components/common/lobby/RoomListCard";
import {
  markPendingRestore,
  readRoomCreateDefaults,
  saveRoomCreateDefaults,
} from "@/lib/RoomSettingsMemory";
import { SONG_QUESTION_TYPE_LABELS } from "@bakagame/shared/values";
import type { SonGuessrRoomSummary } from "@bakagame/shared";

/** 猜歌的大厅区分「等待中」与「游戏中」两态；听歌识番的房间带题型标签。 */
const toRoomView = (room: SonGuessrRoomSummary): LobbyRoomView => ({
  roomId: room.roomId,
  name: room.name,
  hasPassword: room.hasPassword,
  inGame: room.phase !== "waiting" && room.phase !== "roundResult",
  allowSpectators: room.allowSpectators,
  playerCount: room.playerCount,
  spectatorCount: room.spectatorCount,
  // 只给与默认题型不同的房间挂标签（与房间顶栏的 roomTag 同口径），默认的听歌识曲不挂。
  tag: room.questionType === "anime" ? SONG_QUESTION_TYPE_LABELS.anime : undefined,
  mcpAvailable: room.allowAgents,
});

export default function SonGuessrPage() {
  const rooms = useSonGuessrStore((state) => state.rooms);
  const lobbyReady = useSonGuessrStore((state) => state.lobbyReady);
  const createRoom = useSonGuessrStore((state) => state.createRoom);
  const joinRoom = useSonGuessrStore((state) => state.joinRoom);
  const reconnectRoom = useSonGuessrStore((state) => state.reconnectRoom);
  const showToast = useSonGuessrStore((state) => state.showToast);

  const session = useLobbySession<SonGuessrRoomSummary>({
    gamePath: "/songuessr",
    rooms,
    ready: lobbyReady,
    createRoom,
    joinRoom,
    reconnectRoom,
    showError: (message) => showToast(message, "error"),
    // 创建成功后记住这次的选项并登记：进房后等待页据此把上次的房间设置套进新房间。
    onRoomCreated: (roomId, params) => {
      saveRoomCreateDefaults("song", {
        visibility: params.visibility,
        allowSpectators: params.allowSpectators,
      });
      markPendingRestore("song", roomId);
    },
  });

  return (
    <GameLobbyScreen
      session={session}
      rooms={rooms}
      toRoomView={toRoomView}
      header={{ path: "/songuessr", title: "Songuessr" }}
      createDialog={{
        nameMaxLength: 40,
        defaults: readRoomCreateDefaults("song"),
      }}
    />
  );
}
