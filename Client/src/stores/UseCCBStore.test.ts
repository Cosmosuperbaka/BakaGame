import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CCBPrivateState, CCBRoomSnapshot, ServerMessage } from "@/types";
import { DEFAULT_CCB_SETTINGS } from "@/types";

const wsMock = vi.hoisted(() => {
  let messageHandlers: Array<(message: ServerMessage) => void> = [];
  let statusHandlers: Array<(connected: boolean) => void> = [];
  return {
    send: vi.fn(async () => ({}) as Record<string, unknown>),
    connect: vi.fn(),
    getStatusHandlers: () => statusHandlers,
    clearHandlers: () => {
      messageHandlers = [];
      statusHandlers = [];
    },
    emitMessage: (message: ServerMessage) => {
      messageHandlers.forEach((handler) => handler(message));
    },
    emitStatus: (connected: boolean) => {
      statusHandlers.forEach((handler) => handler(connected));
    },
    onMessage: (handler: (message: ServerMessage) => void) => {
      messageHandlers.push(handler);
      return () => {
        messageHandlers = messageHandlers.filter((entry) => entry !== handler);
      };
    },
    onStatus: (handler: (connected: boolean) => void) => {
      statusHandlers.push(handler);
      return () => {
        statusHandlers = statusHandlers.filter((entry) => entry !== handler);
      };
    },
  };
});

vi.mock("@/lib/CCBWs", () => ({
  CCBWs: {
    send: wsMock.send,
    connect: wsMock.connect,
    onMessage: wsMock.onMessage,
    onStatus: wsMock.onStatus,
    waitForConnection: vi.fn(async () => undefined),
  },
}));

import { getCCBSessionToken, saveCCBSessionToken } from "@/lib/Storage";
import {
  initCCBWs,
  resetCCBStateSync,
  useCCBStore,
} from "./UseCCBStore";

const emptyState = {
  connected: false,
  rooms: [],
  roomId: null,
  sessionToken: null,
  snapshot: null,
  privateState: null,
  roomClosedAt: null,
  notice: null,
};

const playerView = (id: string, name: string, isHost = false): CCBRoomSnapshot["players"][number] => ({
  id,
  name,
  score: 0,
  membership: "active",
  online: true,
  isReady: isHost,
  isBot: false,
  isHost,
  message: "",
  marks: "",
  guessCount: 0,
  finished: false,
  team: null,
});

const roomSnapshot = (
  overrides: Partial<CCBRoomSnapshot> = {},
): CCBRoomSnapshot => ({
  roomId: "1234",
  name: "猜角色房",
  visibility: "public",
  allowSpectators: true,
  hasPassword: false,
  hostPlayerId: "ccb_player_1",
  testMode: false,
  settings: { ...DEFAULT_CCB_SETTINGS },
  phase: "waiting",
  roundNumber: 0,
  players: [playerView("ccb_player_1", "房主", true)],
  chat: [],
  ...overrides,
});

const privateState = (sessionToken = "ccb_session_1"): CCBPrivateState => ({
  playerId: "ccb_player_1",
  sessionToken,
  canSetAnswer: false,
  canGuess: false,
  canSurrender: false,
  canStartRound: false,
  remainingGuesses: 10,
  ownGuesses: [],
  hints: [],
});

const emitEvent = (event: string, payload: unknown) =>
  wsMock.emitMessage({ type: "event", event, payload } as ServerMessage);

const fullSync = (state: unknown, revision = 1) => ({ mode: "full", revision, state });

const chatMessage = (id: string, text: string, createdAt: number) => ({
  id,
  playerId: "ccb_player_1",
  playerName: "房主",
  text,
  createdAt,
  system: false,
});

describe("CCB store 事件与房间生命周期", () => {
  let dispose: () => void;

  beforeEach(() => {
    wsMock.clearHandlers();
    wsMock.send.mockClear();
    wsMock.send.mockResolvedValue({});
    wsMock.connect.mockClear();
    resetCCBStateSync();
    useCCBStore.setState({ ...emptyState, setNotice: useCCBStore.getState().setNotice, clearNotice: useCCBStore.getState().clearNotice });
    dispose = initCCBWs();
  });

  it("订阅后建立连接并接收大厅房间列表", () => {
    expect(wsMock.connect).toHaveBeenCalledTimes(1);

    emitEvent("ccb.lobby.rooms", [
      {
        roomId: "1234",
        name: "猜角色房",
        visibility: "public",
        allowSpectators: true,
        hasPassword: false,
        playerCount: 2,
        spectatorCount: 1,
        onlineCount: 3,
        phase: "waiting",
      },
    ]);

    expect(useCCBStore.getState().rooms).toHaveLength(1);
    expect(useCCBStore.getState().rooms[0]).toMatchObject({ roomId: "1234", playerCount: 2 });
  });

  it("建房与入房都会持久化会话令牌并落盘快照", async () => {
    wsMock.send.mockResolvedValueOnce({
      roomId: "1234",
      playerId: "ccb_player_1",
      sessionToken: "ccb_session_created",
      snapshot: roomSnapshot(),
      privateState: privateState("ccb_session_created"),
    });

    await useCCBStore.getState().createRoom({
      roomId: "1234",
      name: "猜角色房",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
    });

    expect(useCCBStore.getState()).toMatchObject({
      roomId: "1234",
      sessionToken: "ccb_session_created",
      roomClosedAt: null,
    });
    expect(useCCBStore.getState().snapshot?.name).toBe("猜角色房");
    expect(getCCBSessionToken("1234")).toBe("ccb_session_created");

    wsMock.send.mockResolvedValueOnce({
      roomId: "5678",
      sessionToken: "ccb_session_joined",
      snapshot: roomSnapshot({ roomId: "5678", players: [playerView("ccb_player_2", "玩家")] }),
      privateState: { ...privateState("ccb_session_joined"), playerId: "ccb_player_2" },
    });

    await useCCBStore.getState().joinRoom("5678", "玩家");

    expect(useCCBStore.getState().roomId).toBe("5678");
    expect(getCCBSessionToken("5678")).toBe("ccb_session_joined");
    // 换房间必须换基线：旧房间的修订号不能带到新房间
    expect(useCCBStore.getState().snapshot?.roomId).toBe("5678");
  });

  it("快照全量同步按 id 合并聊天，补丁按修订号增量应用", () => {
    useCCBStore.setState({ roomId: "1234", sessionToken: "ccb_session_1" });
    emitEvent(
      "ccb.room.snapshot",
      fullSync(roomSnapshot({ chat: [chatMessage("c1", "第一条", 1_000)] })),
    );
    expect(useCCBStore.getState().snapshot?.chat).toHaveLength(1);

    emitEvent(
      "ccb.room.snapshot",
      fullSync(
        roomSnapshot({ name: "改名了", chat: [chatMessage("c2", "第二条", 2_000)] }),
        2,
      ),
    );

    const snapshot = useCCBStore.getState().snapshot;
    expect(snapshot?.name).toBe("改名了");
    // 服务端会裁剪历史，客户端在同一房间内按 id 补回本地已有的气泡
    expect(snapshot?.chat.map((message) => message.id)).toEqual(["c1", "c2"]);
  });

  it("修订号断层时请求全量同步而不是猜测补丁", () => {
    useCCBStore.setState({ roomId: "1234", sessionToken: "ccb_session_1" });
    emitEvent("ccb.room.snapshot", fullSync(roomSnapshot()));
    wsMock.send.mockClear();

    emitEvent("ccb.room.snapshot", {
      mode: "patch",
      baseRevision: 99,
      revision: 100,
      operations: [{ op: "replace", path: "/name", value: "不该生效" }],
    });

    expect(useCCBStore.getState().snapshot?.name).toBe("猜角色房");
    expect(wsMock.send).toHaveBeenCalledWith("ccb.room.requestSync", {}, expect.anything());
  });

  it("私有状态同步会话令牌", () => {
    emitEvent("ccb.room.snapshot", fullSync(roomSnapshot()));
    emitEvent("ccb.game.privateState", fullSync(privateState("ccb_session_private")));

    expect(useCCBStore.getState().sessionToken).toBe("ccb_session_private");
    expect(useCCBStore.getState().privateState?.remainingGuesses).toBe(10);
    expect(getCCBSessionToken("1234")).toBe("ccb_session_private");
  });

  it("房间关闭、被踢、席位被接管与停机都会清空会话并提示", () => {
    const cases: Array<{ event: string; message: string }> = [
      { event: "ccb.room.closed", message: "房间已关闭" },
      { event: "ccb.room.kicked", message: "你已被移出房间" },
      { event: "session.replaced", message: "当前席位已在另一个标签页接管" },
    ];

    for (const { event, message } of cases) {
      resetCCBStateSync();
      useCCBStore.setState({ roomId: "1234", sessionToken: "ccb_session_1" });
      useCCBStore.getState().setNotice("旧提示", "info");
      emitEvent(event, { roomId: "1234" });

      const state = useCCBStore.getState();
      expect(state.roomId).toBeNull();
      expect(state.snapshot).toBeNull();
      expect(state.notice?.text).toBe(message);
      expect(state.roomClosedAt).not.toBeNull();
      expect(getCCBSessionToken("1234")).toBeNull();
    }

    resetCCBStateSync();
    useCCBStore.setState({ roomId: "1234", sessionToken: "ccb_session_1" });
    emitEvent("server.shutdown", {});
    expect(useCCBStore.getState().notice?.text.length).toBeGreaterThan(0);
  });

  it("重连在无令牌时直接失败，永久错误清会话，网络错误保留房间", async () => {
    expect(await useCCBStore.getState().reconnectRoom("1234")).toBe(false);

    useCCBStore.setState({ roomId: "1234", sessionToken: "ccb_session_1" });
    await useCCBStore.getState().createRoom({
      roomId: "1234",
      name: "猜角色房",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
    });
    wsMock.send.mockRejectedValueOnce(Object.assign(new Error("已失效"), { code: "SESSION_INVALID" }));

    expect(await useCCBStore.getState().reconnectRoom("1234")).toBe(false);
    expect(useCCBStore.getState().roomId).toBeNull();
    expect(useCCBStore.getState().notice?.text).toBe("会话已失效，请重新加入");
    expect(getCCBSessionToken("1234")).toBeNull();

    resetCCBStateSync();
    // 网络类错误必须保留令牌与席位，因此先把会话写回存储再重连
    saveCCBSessionToken("1234", "ccb_session_keep");
    useCCBStore.setState({
      roomId: "1234",
      sessionToken: "ccb_session_keep",
      snapshot: roomSnapshot(),
      roomClosedAt: null,
    });
    wsMock.send.mockRejectedValueOnce(Object.assign(new Error("网络抖动"), { code: "TIMEOUT" }));

    expect(await useCCBStore.getState().reconnectRoom("1234")).toBe(true);
    expect(useCCBStore.getState().roomId).toBe("1234");
    expect(useCCBStore.getState().sessionToken).toBe("ccb_session_keep");
    expect(getCCBSessionToken("1234")).toBe("ccb_session_keep");
  });

  it("离开房间无论成功与否都清空本地会话", async () => {
    useCCBStore.setState({ roomId: "1234", sessionToken: "ccb_session_1", snapshot: roomSnapshot() });
    await useCCBStore.getState().leaveRoom();
    expect(useCCBStore.getState()).toMatchObject({
      roomId: null,
      sessionToken: null,
      snapshot: null,
      privateState: null,
      roomClosedAt: null,
    });

    resetCCBStateSync();
    useCCBStore.setState({ roomId: "1234", sessionToken: "ccb_session_1" });
    wsMock.send.mockRejectedValueOnce(new Error("断线"));
    await useCCBStore.getState().leaveRoom();
    expect(useCCBStore.getState().roomId).toBeNull();
  });

  it("所有房间指令都带上当前房间与会话令牌", async () => {
    useCCBStore.setState({ roomId: "1234", sessionToken: "ccb_session_1" });
    wsMock.send.mockClear();

    await useCCBStore.getState().sendCommand("ccb.chat.send", { text: "你好" });
    expect(wsMock.send).toHaveBeenLastCalledWith("ccb.chat.send", { text: "你好" }, {
      roomId: "1234",
      sessionToken: "ccb_session_1",
      timeout: undefined,
    });

    await useCCBStore.getState().updateSettings({ name: "新名字", allowSpectators: false });
    expect(wsMock.send).toHaveBeenLastCalledWith(
      "ccb.room.updateSettings",
      { name: "新名字", allowSpectators: false },
      expect.objectContaining({ roomId: "1234" }),
    );
  });

  it("重连成功时重置差量基线并自动回到原席位", () => {
    useCCBStore.setState({ roomId: "1234", sessionToken: "ccb_session_1" });
    wsMock.send.mockClear();

    wsMock.emitStatus(true);

    expect(useCCBStore.getState().connected).toBe(true);
    expect(wsMock.send).toHaveBeenCalledWith("ccb.lobby.subscribeRooms");
    expect(wsMock.send).toHaveBeenCalledWith("ccb.room.reconnect", {
      roomId: "1234",
      sessionToken: "ccb_session_1",
    });

    // 基线已失效：重连后收到的补丁必须触发全量重取
    wsMock.send.mockClear();
    useCCBStore.setState({ snapshot: roomSnapshot(), roomId: "1234" });
    emitEvent("ccb.room.snapshot", {
      mode: "patch",
      baseRevision: 1,
      revision: 2,
      operations: [{ op: "replace", path: "/name", value: "补丁" }],
    });
    expect(wsMock.send).toHaveBeenCalledWith("ccb.room.requestSync", {}, expect.anything());
  });

  it("重连状态推送到非连接状态时不重订阅", () => {
    wsMock.send.mockClear();
    wsMock.emitStatus(false);
    expect(useCCBStore.getState().connected).toBe(false);
    expect(wsMock.send).not.toHaveBeenCalled();
  });

  it("卸载时注销消息与状态监听", () => {
    dispose();
    emitEvent("ccb.lobby.rooms", []);
    expect(useCCBStore.getState().rooms).toEqual([]);
  });
});
