import type { ReactNode } from "react";
import { CreateRoomDialog, type CreateRoomDialogProps } from "@/components/common/CreateRoomDialog";
import { JoinPasswordDialog } from "@/components/common/lobby/JoinPasswordDialog";
import { LobbyPage } from "@/components/common/lobby/LobbyPage";
import type { LobbyRoomView } from "@/components/common/lobby/RoomListCard";
import type { LobbyRoomTarget, useLobbySession } from "@/hooks/UseLobbySession";

export interface GameLobbyScreenProps<TRoom extends LobbyRoomTarget> {
  session: ReturnType<typeof useLobbySession<TRoom>>;
  rooms: TRoom[];
  toRoomView: (room: TRoom) => LobbyRoomView;
  header: {
    path: string;
    title: ReactNode;
    titleLabel?: string;
    logo?: { src: string; alt: string };
    subtitle?: string;
  };
  /** 用户名输入上限，与该游戏服务端协议一致；省略时按大厅默认值。 */
  lobbyNameMaxLength?: number;
  /** 建房弹窗里属于该游戏的字段、默认值与私密含义；开合、来源点、默认房名与提交由这里接线。 */
  createDialog: Omit<
    CreateRoomDialogProps,
    "open" | "onOpenChange" | "origin" | "onCreate" | "defaultName"
  >;
  /** 打开建房弹窗前的额外准备（CEE 重读建房记忆）。 */
  onBeforeOpenCreate?: () => void;
  /** 进房前的额外准备（CEE 把当前来源切到该房间的来源）。 */
  onSelect?: (room: TRoom) => void;
  /** 会话之外还在途的操作（CEE 退房）：与 pending 一样显示骨架并禁用创建与加入。 */
  extraLoading?: boolean;
}

/**
 * 三款大厅共用的接线：把大厅会话钩子的状态与操作接到外壳与两个弹窗上。
 * 各游戏只保留自己的展示映射、顶栏标识与建房弹窗字段，玩法差异以参数或回调留在原处。
 */
export function GameLobbyScreen<TRoom extends LobbyRoomTarget>({
  session,
  rooms,
  toRoomView,
  header,
  lobbyNameMaxLength,
  createDialog,
  onBeforeOpenCreate,
  onSelect,
  extraLoading = false,
}: GameLobbyScreenProps<TRoom>) {
  return (
    <LobbyPage
      path={header.path}
      title={header.title}
      logo={header.logo}
      titleLabel={header.titleLabel}
      subtitle={header.subtitle}
      rooms={rooms.map(toRoomView)}
      disabled={extraLoading || session.pending}
      loading={session.isInitialLoading || extraLoading}
      pendingRoomId={session.pendingRoomId}
      userName={session.userName}
      onUserNameChange={session.setUserName}
      nameMaxLength={lobbyNameMaxLength}
      onCreate={(event) => {
        session.createOrigin.capture(event);
        onBeforeOpenCreate?.();
        session.setCreateOpen(true);
      }}
      onSelectRoom={(room, event) => {
        const target = rooms.find((candidate) => candidate.roomId === room.roomId);
        if (target) {
          onSelect?.(target);
          void session.handleJoinRoom(target, event);
        }
      }}
      dialogs={
        <>
          <CreateRoomDialog
            {...createDialog}
            open={session.createOpen}
            onOpenChange={session.setCreateOpen}
            origin={session.createOrigin.origin}
            defaultName={session.userName.trim() ? `${session.userName.trim()}的房间` : "新房间"}
            onCreate={session.handleCreateRoom}
          />
          <JoinPasswordDialog
            pending={session.pending}
            roomName={session.joinTarget?.name ?? null}
            origin={session.joinOrigin.origin}
            password={session.joinPassword}
            onPasswordChange={session.setJoinPassword}
            error={session.joinError}
            onCancel={() => session.setJoinTarget(null)}
            onConfirm={() => void session.handlePasswordJoin()}
          />
        </>
      }
    />
  );
}
