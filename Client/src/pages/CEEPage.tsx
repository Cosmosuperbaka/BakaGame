import { useEffect, useRef, useState } from "react";
import { Server, ShieldCheck } from "lucide-react";
import { useCEEStore, ceeErrorMessage } from "@/stores/UseCEEStore";
import { useAccountStore } from "@/stores/UseAccountStore";
import { useLobbySession } from "@/hooks/UseLobbySession";
import { CreateRoomDialog } from "@/components/common/CreateRoomDialog";
import { JoinPasswordDialog } from "@/components/common/lobby/JoinPasswordDialog";
import { LobbyPage } from "@/components/common/lobby/LobbyPage";
import type { LobbyRoomView } from "@/components/common/lobby/RoomListCard";
import { isBakaClient, setSecureScreen } from "@/lib/BakaChannel";
import { CEE_SOURCE_LABELS } from "@/lib/CEESession";
import {
  markPendingRestore,
  readRoomCreateDefaults,
  saveRoomCreateDefaults,
} from "@/lib/RoomSettingsMemory";
import type { CEERoomSummary, CEESource } from "@bakagame/shared";

/** 大厅只区分「等待中」与「游戏中」；原版房带来源徽章，反作弊房进房前就标出需要客户端，旁观人数由上游提供时才显示。 */
const toRoomView = (room: CEERoomSummary): LobbyRoomView => ({
  roomId: room.roomId,
  name: room.name,
  hasPassword: room.hasPassword,
  inGame: room.phase !== "waiting",
  allowSpectators: room.allowSpectators,
  playerCount: room.playerCount,
  spectatorCount: room.spectatorCount,
  tag: room.source === "original" ? CEE_SOURCE_LABELS.original : undefined,
  requiresClient: room.bakaAntiCheat,
  mcpAvailable: room.allowAgents,
});

export default function CEEPage() {
  const rooms = useCEEStore((state) => state.rooms);
  const lobbyReady = useCEEStore((state) => state.connected && state.lobbyReady);
  const originalAvailable = useCEEStore((state) => state.originalAvailable);
  const [server, setServer] = useState<CEESource>("native");
  const [antiCheat, setAntiCheat] = useState(false);
  const accountStatus = useAccountStore((state) => state.status);
  /**
   * 当前房间是不是反作弊房。它同时决定窗口级防截屏：只有这类房间需要挡录屏，
   * 其他场景常开会让玩家连正常截图分享都做不到。
   */
  const antiCheatRoom = useCEEStore((state) => state.snapshot?.bakaAntiCheat === true);
  useEffect(() => {
    setSecureScreen(antiCheatRoom);
    return () => setSecureScreen(false);
  }, [antiCheatRoom]);
  /**
   * 反作弊房只接受客户端接入且全员登录，建房那条连接自己就得先达标：
   * 网页接入或没登录时这一行根本不出现，而不是点了之后被服务端拒。
   */
  const canCreateAntiCheatRoom = isBakaClient() && accountStatus === "signedIn";
  // 退房操作只有一份；每次 effect 挂载仅订阅该操作，StrictMode 不重复发送。
  const [leaving, setLeaving] = useState(() => Boolean(useCEEStore.getState().roomId));
  const release = useRef<Promise<void> | null>(null);
  useEffect(() => {
    const store = useCEEStore.getState();
    if (!release.current && !store.roomId) return;
    release.current ??= store.leaveRoom();
    let active = true;
    void release.current
      .then(() => {
        if (active && useCEEStore.getState().connected) return store.subscribeLobby();
      })
      .catch((failure) => {
        if (active) store.setNotice(ceeErrorMessage(failure));
      })
      .finally(() => {
        if (active) setLeaving(false);
      });
    return () => {
      active = false;
    };
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
    createRoom: (params, signal) =>
      useCEEStore.getState().createRoom(
        {
          source: server,
          roomId: params.roomId,
          name: params.name,
          userName: params.userName,
          // 原版房的 private 只表示不进大厅（弹窗以 unlisted 呈现），密码与禁止旁观仍只属于增强房。
          visibility: params.visibility,
          allowSpectators: server === "original" ? true : params.allowSpectators,
          ...(server === "native" && params.password ? { password: params.password } : {}),
          // 反作弊只随建房那一次出去；原版房没有这一说，进房后也改不动。
          ...(server === "native" && antiCheat ? { bakaAntiCheat: true } : {}),
        },
        signal
      ),
    joinRoom: (roomId, name, password, signal) =>
      useCEEStore.getState().joinRoom(roomId, name, password, signal),
    reconnectRoom: (roomId, signal) => useCEEStore.getState().reconnectRoom(roomId, signal),
    showError: (message) => useCEEStore.getState().setNotice(message, "error"),
    // 反作弊房在进房前就被拒（需要客户端 / 需要登录）：走统一入口，给具体文案并顺带拉起登录。
    onEntryError: (error) => useCEEStore.getState().reportError(error),
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
  const createDefaults =
    rememberedCreate && rememberedCreate.source === server ? rememberedCreate : null;

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
      onCreate={(event) => {
        createOrigin.capture(event);
        setCreateOpen(true);
      }}
      onSelectRoom={(room, event) => {
        const target = rooms.find((candidate) => candidate.roomId === room.roomId);
        // 原版房没有密码机制，把当前来源切到它，加入表单才不会带错字段。
        if (target) {
          setServer(target.source);
          void handleJoinRoom(target, event);
        }
      }}
      dialogs={
        <>
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
              onCheckedChange: (checked) => {
                setServer(checked ? "original" : "native");
                // 原版房没有反作弊这一说：切过去就把选择收回，免得切回来时还留着隐藏的待提交值。
                if (checked) setAntiCheat(false);
              },
              ...(originalAvailable
                ? {}
                : { disabledReason: "原版服务器暂未接入，暂时只能新建普通房间。" }),
            }}
            antiCheat={
              server === "native" && canCreateAntiCheatRoom
                ? {
                    label: "反作弊房",
                    icon: ShieldCheck,
                    description:
                      "只接受 BakaGame 客户端接入、全员需登录、旁观要房主批准。建房后不可更改。",
                    checked: antiCheat,
                    onCheckedChange: setAntiCheat,
                  }
                : undefined
            }
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
        </>
      }
    />
  );
}
