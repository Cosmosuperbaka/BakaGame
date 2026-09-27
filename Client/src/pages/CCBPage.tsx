import { useEffect, useRef, useState } from "react";
import { useCCBStore, ccbErrorMessage } from "@/stores/UseCCBStore";
import { useLobbySession } from "@/hooks/UseLobbySession";
import { CreateRoomDialog, type ServerOption } from "@/components/common/CreateRoomDialog";
import { JoinPasswordDialog } from "@/components/common/lobby/JoinPasswordDialog";
import { LobbyPage } from "@/components/common/lobby/LobbyPage";
import type { LobbyRoomView } from "@/components/common/lobby/RoomListCard";
import { CCB_SOURCE_LABELS } from "@/lib/CCBSession";
import type { CCBRoomSummary, CCBSource } from "@bakagame/shared";

/** 大厅只区分「等待中」与「游戏中」；原版房带来源徽章，旁观人数由上游提供时才显示。 */
const toRoomView = (room: CCBRoomSummary): LobbyRoomView => ({
  roomId: room.roomId,
  name: room.name,
  hasPassword: room.hasPassword,
  inGame: room.phase !== "waiting",
  allowSpectators: room.allowSpectators,
  playerCount: room.playerCount,
  spectatorCount: room.spectatorCount,
  tag: room.source === "original" ? CCB_SOURCE_LABELS.original : undefined,
});

export default function CCBPage() {
  const rooms = useCCBStore((state) => state.rooms);
  const connected = useCCBStore((state) => state.connected);
  const originalAvailable = useCCBStore((state) => state.originalAvailable);
  const [server, setServer] = useState<CCBSource>("native");
  // 从房间返回大厅时先把原房退掉再订阅大厅；严格模式下 effect 会跑两次，用一次性标志防重。
  const [leaving, setLeaving] = useState(() => Boolean(useCCBStore.getState().roomId));
  const releaseStarted = useRef(false);
  useEffect(() => {
    const store = useCCBStore.getState();
    if (!store.roomId || releaseStarted.current) return;
    releaseStarted.current = true;
    void store.leaveRoom().then(() => store.subscribeLobby())
      .catch((failure) => store.setNotice(ccbErrorMessage(failure)))
      .finally(() => setLeaving(false));
  }, []);

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
  } = useLobbySession<CCBRoomSummary>({
    gamePath: "/ccb",
    rooms,
    connected,
    createRoom: (params) => useCCBStore.getState().createRoom({
      source: server,
      roomId: params.roomId,
      name: params.name,
      userName: params.userName,
      visibility: server === "original" ? "public" : params.visibility,
      allowSpectators: server === "original" ? true : params.allowSpectators,
      ...(server === "native" && params.password ? { password: params.password } : {}),
    }),
    joinRoom: (roomId, name, password) => useCCBStore.getState().joinRoom(roomId, name, password),
    reconnectRoom: (roomId) => useCCBStore.getState().reconnectRoom(roomId),
    showError: (message) => useCCBStore.getState().setNotice(message, "error"),
  });

  const serverOptions: ServerOption[] = [
    { value: "native", label: CCB_SOURCE_LABELS.native },
    {
      value: "original",
      label: CCB_SOURCE_LABELS.original,
      ...(originalAvailable ? {} : { disabledReason: "原版服务器暂未接入，请使用增强房。" }),
    },
  ];

  return (
    <LobbyPage
      path="/ccb"
      title="二刺猿笑传之猜猜呗"
      rooms={rooms.map(toRoomView)}
      loading={isInitialLoading || leaving}
      disabled={leaving}
      userName={userName}
      onUserNameChange={setUserName}
      onCreate={(event) => { createOrigin.capture(event); setCreateOpen(true); }}
      onSelectRoom={(room, event) => {
        const target = rooms.find((candidate) => candidate.roomId === room.roomId);
        // 原版房没有密码机制，把当前分段切到它的来源，加入表单才不会带错字段。
        if (target) { setServer(target.source); void handleJoinRoom(target, event); }
      }}
      dialogs={<>
        <CreateRoomDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          origin={createOrigin.origin}
          defaultName={userName.trim() ? `${userName.trim()}的房间` : "新房间"}
          serverOptions={serverOptions}
          server={server}
          onServerChange={(value) => setServer(value as CCBSource)}
          privateRoomDisabledReason={server === "original" ? "原版房间不支持密码" : undefined}
          spectatorsDisabledReason={server === "original" ? "原版房间不允许禁止观战" : undefined}
          onValidationError={(message) => useCCBStore.getState().setNotice(message, "error")}
          onCreate={(params) => handleCreateRoom(params)}
        />
        <JoinPasswordDialog
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
