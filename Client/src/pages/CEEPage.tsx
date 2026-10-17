import { useEffect, useRef, useState } from "react";
import { Server } from "lucide-react";
import { useCEEStore, ceeErrorMessage } from "@/stores/UseCEEStore";
import { useLobbySession } from "@/hooks/UseLobbySession";
import { CreateRoomDialog } from "@/components/common/CreateRoomDialog";
import { JoinPasswordDialog } from "@/components/common/lobby/JoinPasswordDialog";
import { LobbyPage } from "@/components/common/lobby/LobbyPage";
import type { LobbyRoomView } from "@/components/common/lobby/RoomListCard";
import { CEE_SOURCE_LABELS } from "@/lib/CEESession";
import { markPendingRestore, readRoomCreateDefaults, saveRoomCreateDefaults } from "@/lib/RoomSettingsMemory";
import type { CEERoomSummary, CEESource } from "@bakagame/shared";

/** 大厅只区分「等待中」与「游戏中」；原版房带来源徽章，旁观人数由上游提供时才显示。 */
const toRoomView = (room: CEERoomSummary): LobbyRoomView => ({
  roomId: room.roomId,
  name: room.name,
  hasPassword: room.hasPassword,
  inGame: room.phase !== "waiting",
  allowSpectators: room.allowSpectators,
  playerCount: room.playerCount,
  spectatorCount: room.spectatorCount,
  tag: room.source === "original" ? CEE_SOURCE_LABELS.original : undefined,
});

export default function CEEPage() {
  const rooms = useCEEStore((state) => state.rooms);
  const lobbyReady = useCEEStore((state) => state.connected && state.lobbyReady);
  const originalAvailable = useCEEStore((state) => state.originalAvailable);
  const [server, setServer] = useState<CEESource>("native");
  // 退房操作只有一份；每次 effect 挂载仅订阅该操作，StrictMode 不重复发送。
  const [leaving, setLeaving] = useState(() => Boolean(useCEEStore.getState().roomId));
  const release = useRef<Promise<void> | null>(null);
  useEffect(() => {
    const store = useCEEStore.getState();
    if (!release.current && !store.roomId) return;
    release.current ??= store.leaveRoom();
    let active = true;
    void release.current.then(() => {
      if (active && useCEEStore.getState().connected) return store.subscribeLobby();
    }).catch((failure) => {
      if (active) store.setNotice(ceeErrorMessage(failure));
    }).finally(() => { if (active) setLeaving(false); });
    return () => { active = false; };
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
    joinError,
    createOrigin,
    joinOrigin,
    handleJoinRoom,
    handlePasswordJoin,
    handleCreateRoom,
    isInitialLoading,
    pending,
    pendingRoomId,
  } = useLobbySession<CEERoomSummary>({
    gamePath: "/cee",
    rooms,
    ready: lobbyReady,
    createRoom: (params, signal) => useCEEStore.getState().createRoom({
      source: server,
      roomId: params.roomId,
      name: params.name,
      userName: params.userName,
      // 原版房的 private 只表示不进大厅（弹窗以 unlisted 呈现），密码与禁止旁观仍只属于增强房。
      visibility: params.visibility,
      allowSpectators: server === "original" ? true : params.allowSpectators,
      ...(server === "native" && params.password ? { password: params.password } : {}),
    }, signal),
    joinRoom: (roomId, name, password, signal) => useCEEStore.getState().joinRoom(roomId, name, password, signal),
    reconnectRoom: (roomId, signal) => useCEEStore.getState().reconnectRoom(roomId, signal),
    showError: (message) => useCEEStore.getState().setNotice(message, "error"),
    // 创建成功后记住这次的选项并登记：进房后等待页据此把上次的玩法设置套进新房间。
    onRoomCreated: (roomId, params) => {
      saveRoomCreateDefaults("cee", {
        visibility: params.visibility,
        // 原版房不允许禁止旁观：按实际提交值记忆，下次沿用才不会与开关的真实含义错位。
        allowSpectators: server === "original" ? true : params.allowSpectators,
        source: server,
      });
      markPendingRestore("cee", roomId);
    },
  });

  // 上次的选项只在同一种服务器上沿用：原版房的「不公开」与增强房的「私密」不是一回事。
  const rememberedCreate = readRoomCreateDefaults("cee");
  const createDefaults = rememberedCreate && rememberedCreate.source === server ? rememberedCreate : null;

  return (
    <LobbyPage
      path="/cee"
      title="二刺猿笑传之猜猜呗"
      subtitle="Enhanced Edition"
      rooms={rooms.map(toRoomView)}
      loading={isInitialLoading || leaving}
      disabled={leaving || pending}
      pendingRoomId={pendingRoomId}
      userName={userName}
      onUserNameChange={setUserName}
      nameMaxLength={32}
      onCreate={(event) => { createOrigin.capture(event); setCreateOpen(true); }}
      onSelectRoom={(room, event) => {
        const target = rooms.find((candidate) => candidate.roomId === room.roomId);
        // 原版房没有密码机制，把当前来源切到它，加入表单才不会带错字段。
        if (target) { setServer(target.source); void handleJoinRoom(target, event); }
      }}
      dialogs={<>
        <CreateRoomDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          origin={createOrigin.origin}
          defaultName={userName.trim() ? `${userName.trim()}的房间` : "新房间"}
          // 协议上限 32；原版服务器只保留前 30 个字符。
          nameMaxLength={server === "original" ? 30 : 32}
          roomMode={{
            label: "兼容原版",
            icon: Server,
            description: "开启后建在原版服务器上，原版网页也能加入；没有密码，不能禁止旁观。",
            checked: server === "original",
            onCheckedChange: (checked) => setServer(checked ? "original" : "native"),
            ...(originalAvailable ? {} : { disabledReason: "原版服务器暂未接入，暂时只能新建普通房间。" }),
          }}
          privacy={server === "original" ? "unlisted" : "password"}
          spectatorsDisabledReason={server === "original" ? "原版房间不允许禁止旁观" : undefined}
          defaults={createDefaults}
          onCreate={(params) => handleCreateRoom(params)}
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
