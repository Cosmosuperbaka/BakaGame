import type { MouseEvent, ReactNode } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateRoomDialogProps } from "@/components/common/CreateRoomDialog";
import type { JoinPasswordDialogProps } from "@/components/common/lobby/JoinPasswordDialog";
import type { LobbyPageProps } from "@/components/common/lobby/LobbyPage";
import type { LobbyRoomView } from "@/components/common/lobby/RoomListCard";
import type { LobbyRoomTarget } from "@/hooks/UseLobbySession";
import { GameLobbyScreen, type GameLobbyScreenProps } from "./GameLobbyScreen";

// 这个部件只做接线：把三个子件换成记下 props 的桩，逐项核对会话的状态与操作接到了哪里。
const received = vi.hoisted(() => ({
  lobby: null as unknown,
  create: null as unknown,
  join: null as unknown,
}));
vi.mock("@/components/common/lobby/LobbyPage", () => ({
  LobbyPage: (props: { dialogs?: ReactNode }) => {
    received.lobby = props;
    return <>{props.dialogs}</>;
  },
}));
vi.mock("@/components/common/CreateRoomDialog", () => ({
  CreateRoomDialog: (props: unknown) => {
    received.create = props;
    return null;
  },
}));
vi.mock("@/components/common/lobby/JoinPasswordDialog", () => ({
  JoinPasswordDialog: (props: unknown) => {
    received.join = props;
    return null;
  },
}));

const lobby = () => received.lobby as LobbyPageProps;
const createDialog = () => received.create as CreateRoomDialogProps;
const joinDialog = () => received.join as JoinPasswordDialogProps;

type Session = GameLobbyScreenProps<LobbyRoomTarget>["session"];

const rooms: LobbyRoomTarget[] = [
  { roomId: "1111", name: "甲房" },
  { roomId: "2222", name: "乙房", hasPassword: true },
];
const toRoomView = (room: LobbyRoomTarget): LobbyRoomView => ({
  roomId: room.roomId,
  name: room.name,
  hasPassword: room.hasPassword === true,
  inGame: false,
  allowSpectators: true,
  playerCount: 1,
  spectatorCount: 0,
});
const click = { clientX: 3, clientY: 4 } as MouseEvent<HTMLElement>;

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  pending: false,
  pendingRoomId: null,
  userName: "小明",
  setUserName: vi.fn(),
  createOpen: false,
  setCreateOpen: vi.fn(),
  joinTarget: null,
  setJoinTarget: vi.fn(),
  joinPassword: "",
  setJoinPassword: vi.fn(),
  joinError: null,
  createOrigin: { origin: null, capture: vi.fn() },
  joinOrigin: { origin: null, capture: vi.fn() },
  handleJoinRoom: vi.fn(async () => {}),
  handlePasswordJoin: vi.fn(async () => {}),
  handleCreateRoom: vi.fn(async () => {}),
  isInitialLoading: false,
  ...overrides,
});

const renderScreen = (
  session: Session,
  extra: Partial<GameLobbyScreenProps<LobbyRoomTarget>> = {}
) =>
  render(
    <GameLobbyScreen
      session={session}
      rooms={rooms}
      toRoomView={toRoomView}
      header={{ path: "/demo", title: "演示", titleLabel: "演示大厅", subtitle: "副标题" }}
      createDialog={{ nameMaxLength: 40, defaults: null }}
      {...extra}
    />
  );

describe("GameLobbyScreen 的接线", () => {
  beforeEach(() => {
    received.lobby = null;
    received.create = null;
    received.join = null;
  });

  it("顶栏标识、房间展示模型与用户名上限交给大厅外壳", () => {
    renderScreen(makeSession(), { lobbyNameMaxLength: 32 });
    expect(lobby()).toMatchObject({
      path: "/demo",
      title: "演示",
      titleLabel: "演示大厅",
      subtitle: "副标题",
      rooms: rooms.map(toRoomView),
      userName: "小明",
      nameMaxLength: 32,
      disabled: false,
      loading: false,
      pendingRoomId: null,
    });
  });

  it("会话在途时禁用大厅，正在进入的房间与首次握手的骨架各自透传", () => {
    renderScreen(makeSession({ pending: true, pendingRoomId: "2222", isInitialLoading: true }));
    expect(lobby()).toMatchObject({ disabled: true, loading: true, pendingRoomId: "2222" });
  });

  it("会话之外还在途的操作同样禁用大厅并显示骨架", () => {
    renderScreen(makeSession(), { extraLoading: true });
    expect(lobby()).toMatchObject({ disabled: true, loading: true });
  });

  it("改用户名写回会话", () => {
    const session = makeSession();
    renderScreen(session);
    lobby().onUserNameChange("小红");
    expect(session.setUserName).toHaveBeenCalledWith("小红");
  });

  it("点新建：记下来源点，做完该游戏的准备，再打开弹窗", () => {
    const session = makeSession();
    const onBeforeOpenCreate = vi.fn();
    renderScreen(session, { onBeforeOpenCreate });
    lobby().onCreate(click);
    expect(session.createOrigin.capture).toHaveBeenCalledWith(click);
    expect(onBeforeOpenCreate).toHaveBeenCalledOnce();
    expect(session.setCreateOpen).toHaveBeenCalledWith(true);
  });

  it("点房间：按房号找回原始房间，先做进房前准备，再连同点击位置交给会话", () => {
    const session = makeSession();
    const onSelect = vi.fn();
    renderScreen(session, { onSelect });
    lobby().onSelectRoom(toRoomView(rooms[1]!), click);
    expect(onSelect).toHaveBeenCalledWith(rooms[1]);
    expect(session.handleJoinRoom).toHaveBeenCalledWith(rooms[1], click);
    expect(onSelect.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(session.handleJoinRoom).mock.invocationCallOrder[0]!
    );
  });

  it("列表里已经没有的房间点了不进房", () => {
    const session = makeSession();
    const onSelect = vi.fn();
    renderScreen(session, { onSelect });
    lobby().onSelectRoom({ ...toRoomView(rooms[0]!), roomId: "9999" }, click);
    expect(onSelect).not.toHaveBeenCalled();
    expect(session.handleJoinRoom).not.toHaveBeenCalled();
  });

  it("建房弹窗：各游戏的字段原样带上，开合、来源点与提交接会话", () => {
    const origin = { x: 5, y: 6 };
    const session = makeSession({
      createOpen: true,
      createOrigin: { origin, capture: vi.fn() },
    });
    renderScreen(session);
    expect(createDialog()).toMatchObject({ nameMaxLength: 40, defaults: null, open: true, origin });
    expect(createDialog().onOpenChange).toBe(session.setCreateOpen);
    expect(createDialog().onCreate).toBe(session.handleCreateRoom);
  });

  it("默认房名跟着用户名，名字只有空白时用兜底", () => {
    renderScreen(makeSession({ userName: " 小明 " }));
    expect(createDialog().defaultName).toBe("小明的房间");
    renderScreen(makeSession({ userName: "   " }));
    expect(createDialog().defaultName).toBe("新房间");
  });

  it("密码弹窗：目标房名、密码、失败文案、在途与来源点取自会话", () => {
    const origin = { x: 7, y: 8 };
    const joinError = { message: "密码错误", invalid: true };
    renderScreen(
      makeSession({
        pending: true,
        joinTarget: rooms[1]!,
        joinPassword: "abc",
        joinError,
        joinOrigin: { origin, capture: vi.fn() },
      })
    );
    expect(joinDialog()).toMatchObject({
      pending: true,
      roomName: "乙房",
      password: "abc",
      error: joinError,
      origin,
    });
  });

  it("没有待加入的房间时密码弹窗收到空房名", () => {
    renderScreen(makeSession());
    expect(joinDialog().roomName).toBeNull();
  });

  it("密码弹窗的输入、取消与确认写回会话", () => {
    const session = makeSession({ joinTarget: rooms[1]! });
    renderScreen(session);
    joinDialog().onPasswordChange("p@ss");
    expect(session.setJoinPassword).toHaveBeenCalledWith("p@ss");
    joinDialog().onCancel();
    expect(session.setJoinTarget).toHaveBeenCalledWith(null);
    joinDialog().onConfirm();
    expect(session.handlePasswordJoin).toHaveBeenCalledOnce();
  });
});
