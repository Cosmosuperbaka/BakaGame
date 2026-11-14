import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SERVER_SHUTDOWN_MESSAGE } from "@bakagame/shared/values";
import { recordClockSample, resetClockSample } from "./UseServerClock";
import type { WhoIsFakerRoomSnapshot, RoundSummary, ServerMessage } from "@bakagame/shared";

const wsMock = vi.hoisted(() => {
  let messageHandlers: Array<(message: ServerMessage) => void> = [];
  let statusHandlers: Array<(connected: boolean) => void> = [];
  return {
    send: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    getMessageHandlers: () => messageHandlers,
    getStatusHandlers: () => statusHandlers,
    clearHandlers: () => {
      messageHandlers = [];
      statusHandlers = [];
    },
    emitStatus: (connected: boolean) => {
      statusHandlers.forEach((handler) => handler(connected));
    },
    emitMessage: (message: ServerMessage) => {
      messageHandlers.forEach((handler) => handler(message));
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

vi.mock("@/lib/WhoIsFakerWs", () => ({
  send: wsMock.send,
  connect: wsMock.connect,
  disconnect: wsMock.disconnect,
  onMessage: wsMock.onMessage,
  onStatus: wsMock.onStatus,
}));

import { getSessionToken, saveSessionToken } from "@/lib/Storage";
import { initWhoIsFakerWs, useWhoIsFakerStore, withChannelNotices } from "./UseWhoIsFakerStore";
import { wifPrivate, WIF_PEOPLE } from "@/stories/fixtures/WhoIsFaker";

// 初始化带幂等门闩：每个用例结束必须释放，否则后一个用例拿到的是空操作。
const disposers: Array<() => void> = [];
const initGameSocket = () => {
  const dispose = initWhoIsFakerWs();
  disposers.push(dispose);
  return dispose;
};
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
});

const initialState = useWhoIsFakerStore.getState();

const roundSummary: RoundSummary = {
  winner: "good",
  reason: "测试结算",
  awardedScores: [],
  revealedRoles: [],
  descriptions: [],
  blankGuesses: [],
  words: {
    pair: ["苹果", "香蕉"],
    civilianWord: "苹果",
    undercoverWord: "香蕉",
  },
};

const gameOverSnapshot = (roundId: string, summary?: RoundSummary): WhoIsFakerRoomSnapshot => ({
  roomId: "5678",
  name: "结算房间",
  visibility: "public",
  allowSpectators: true,
  hasPassword: false,
  hostPlayerId: "host",
  testMode: false,
  roleLimits: {
    maxUndercoverCount: 1,
    canEnableAngel: false,
    canEnableBlank: false,
  },
  settings: {
    roleConfig: {
      undercoverCount: 1,
      hasAngel: false,
      hasBlank: false,
    },
  },
  status: {
    phase: "gameOver",
    roundId,
    started: true,
    day: 1,
    speechMode: "normal",
    speechOrder: [],
    submittedSpeechPlayerIds: [],
  },
  players: [],
  descriptions: [],
  chat: [],
  summary,
});

describe("game store integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    wsMock.send.mockReset();
    wsMock.connect.mockReset();
    wsMock.clearHandlers();
    useWhoIsFakerStore.setState(initialState, true);
  });

  afterEach(() => {
    useWhoIsFakerStore.getState().leaveRoomState();
    vi.useRealTimers();
  });

  it("合并聊天历史保持有界并保留最新消息", () => {
    const base = gameOverSnapshot("chat-round");
    const history = Array.from({ length: 250 }, (_, index) => ({
      id: `chat-${index}`,
      playerId: "p",
      playerName: "玩家",
      text: `消息${index}`,
      system: false,
      createdAt: index,
    }));
    useWhoIsFakerStore.getState().setSnapshot({ ...base, chat: history });
    const chat = useWhoIsFakerStore.getState().snapshot?.chat ?? [];
    expect(chat).toHaveLength(200);
    expect(chat[0]?.id).toBe("chat-50");
    expect(chat.at(-1)?.id).toBe("chat-249");
  });

  it("persists a newly created room session in the current tab", async () => {
    wsMock.send.mockResolvedValue({
      roomId: "1234",
      playerId: "player-1",
      sessionToken: "created-token",
    });

    await useWhoIsFakerStore.getState().createRoom({
      roomId: "1234",
      name: "测试房间",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
    });

    expect(wsMock.send).toHaveBeenCalledWith(
      "room.create",
      expect.objectContaining({
        roomId: "1234",
        userName: "房主",
      })
    );
    expect(getSessionToken("1234")).toBe("created-token");
    expect(useWhoIsFakerStore.getState()).toMatchObject({
      roomId: "1234",
      sessionToken: "created-token",
    });
  });

  it("退房回包慢于下一次进房时，只清掉发起退房的会话", async () => {
    let ack!: () => void;
    wsMock.send.mockReturnValue(
      new Promise<void>((resolve) => {
        ack = resolve;
      })
    );
    saveSessionToken("1234", "old-token");
    useWhoIsFakerStore.setState({ roomId: "1234", sessionToken: "old-token" });

    const leaving = useWhoIsFakerStore.getState().leaveRoom();
    // 退房在房间页卸载后才发出，回包到达前玩家已经进了下一个房间。
    saveSessionToken("5678", "new-token");
    useWhoIsFakerStore.setState({ roomId: "5678", sessionToken: "new-token" });
    ack();
    await leaving;

    expect(useWhoIsFakerStore.getState()).toMatchObject({
      roomId: "5678",
      sessionToken: "new-token",
    });
    expect(getSessionToken("5678")).toBe("new-token");
    // 已离开房间的旧凭据照常删掉，免得下次重连拿着失效凭据先报一次错。
    expect(getSessionToken("1234")).toBeNull();
  });

  it("clears a stale token after reconnect fails", async () => {
    saveSessionToken("2345", "stale-token");
    wsMock.send.mockRejectedValue({ code: "SESSION_NOT_FOUND" });

    await expect(useWhoIsFakerStore.getState().reconnectRoom("2345")).resolves.toBe(false);
    expect(getSessionToken("2345")).toBeNull();
    expect(useWhoIsFakerStore.getState().roomId).toBeNull();
    expect(useWhoIsFakerStore.getState().roomClosedAt).toBeNull();
    expect(useWhoIsFakerStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        text: "原座位已失效，可能掉线过久或房间已重建",
        type: "error",
      })
    );
  });

  it("刷新时房间已不在：标记关闭让页面退回大厅，不留给页面按房号重建", async () => {
    saveSessionToken("2347", "orphan-token");
    wsMock.send.mockRejectedValue({ code: "ROOM_NOT_FOUND" });

    await expect(useWhoIsFakerStore.getState().reconnectRoom("2347")).resolves.toBe(false);
    expect(getSessionToken("2347")).toBeNull();
    expect(useWhoIsFakerStore.getState().roomClosedAt).not.toBeNull();
    expect(useWhoIsFakerStore.getState().toasts).toContainEqual(
      expect.objectContaining({ text: "房间已解散或不存在", type: "error" })
    );
  });

  it("临时重连失败保留重试凭据但拒绝调用方，不伪装入房成功", async () => {
    saveSessionToken("2346", "live-token");
    wsMock.send.mockRejectedValue({ code: "DISCONNECTED" });

    await expect(useWhoIsFakerStore.getState().reconnectRoom("2346")).rejects.toMatchObject({
      code: "DISCONNECTED",
    });
    expect(getSessionToken("2346")).toBe("live-token");
    expect(useWhoIsFakerStore.getState()).toMatchObject({
      roomId: null,
      sessionToken: null,
      roomClosedAt: null,
    });
  });

  it("重复初始化不叠加第二路消息与状态订阅", () => {
    initGameSocket();
    initGameSocket();
    expect(wsMock.getMessageHandlers()).toHaveLength(1);
    expect(wsMock.getStatusHandlers()).toHaveLength(1);
    expect(wsMock.connect).toHaveBeenCalledOnce();
  });

  it("重连后私有态基线作废：旧版本号的补丁改为请求全量，不落在旧基线上", () => {
    wsMock.send.mockResolvedValue({});
    initGameSocket();
    const privateState = wifPrivate(WIF_PEOPLE.host, "waiting");
    wsMock.emitMessage({
      type: "event",
      event: "game.privateState",
      payload: { mode: "full", revision: 1, state: privateState },
    });
    expect(useWhoIsFakerStore.getState().privateState).toEqual(privateState);

    wsMock.emitStatus(true);
    wsMock.send.mockClear();
    wsMock.emitMessage({
      type: "event",
      event: "game.privateState",
      payload: {
        mode: "patch",
        baseRevision: 1,
        revision: 2,
        operations: [{ op: "replace", path: "/playerId", value: "tampered" }],
      },
    });

    expect(wsMock.send).toHaveBeenCalledWith("room.requestSync", {}, expect.anything());
    expect(useWhoIsFakerStore.getState().privateState).toEqual(privateState);
  });

  it("subscribes and restores the active session after socket reconnection", async () => {
    wsMock.send.mockResolvedValue({ roomId: "3456", sessionToken: "live-token" });
    useWhoIsFakerStore.getState().joinRoomState("3456", "live-token");
    const dispose = initGameSocket();

    wsMock.emitStatus(true);
    await Promise.resolve();

    expect(useWhoIsFakerStore.getState().connected).toBe(true);
    expect(wsMock.send).toHaveBeenCalledWith("lobby.subscribeRooms", {});
    expect(wsMock.send).toHaveBeenCalledWith("room.reconnect", {
      roomId: "3456",
      sessionToken: "live-token",
    });
    dispose();
    expect(wsMock.getMessageHandlers()).toHaveLength(0);
    expect(wsMock.getStatusHandlers()).toHaveLength(0);
  });

  it("断线只收回大厅就绪标记，房间展示态与凭据留在原地", () => {
    initGameSocket();
    useWhoIsFakerStore.getState().joinRoomState("1234", "live-token");
    useWhoIsFakerStore
      .getState()
      .setSnapshot({ ...gameOverSnapshot("round-live"), roomId: "1234" });
    useWhoIsFakerStore.setState({ lobbyReady: true });

    wsMock.emitStatus(false);

    // 掉线不等于退房：房间页继续显示最后一屏等重连，大厅列表则要重新订阅后才算就绪。
    expect(useWhoIsFakerStore.getState()).toMatchObject({
      connected: false,
      lobbyReady: false,
      roomId: "1234",
      sessionToken: "live-token",
      roomClosedAt: null,
    });
    expect(useWhoIsFakerStore.getState().snapshot?.roomId).toBe("1234");
  });

  it("drops local authority when another tab replaces the session", () => {
    saveSessionToken("4567", "replaced-token");
    useWhoIsFakerStore.getState().joinRoomState("4567", "replaced-token");
    initGameSocket();

    wsMock.emitMessage({
      type: "event",
      event: "session.replaced",
      payload: { roomId: "4567" },
    });

    expect(getSessionToken("4567")).toBeNull();
    expect(useWhoIsFakerStore.getState()).toMatchObject({ roomId: null, sessionToken: null });
    expect(useWhoIsFakerStore.getState().toasts.at(-1)).toMatchObject({
      text: "您的连接已被新标签页替代",
      type: "error",
    });
  });

  it("clears the session token and flags closure when the room is closed", () => {
    saveSessionToken("5678", "closed-token");
    useWhoIsFakerStore.getState().joinRoomState("5678", "closed-token");
    initGameSocket();

    wsMock.emitMessage({
      type: "event",
      event: "room.closed",
      payload: { roomId: "5678", reason: "empty" },
    });

    // 令牌必须一起清掉，否则下次进房会去重连一个已被删除的房间。
    expect(getSessionToken("5678")).toBeNull();
    expect(useWhoIsFakerStore.getState()).toMatchObject({ roomId: null, snapshot: null });
    // 房间页据此退回大厅，而不是靠「没有快照」这种同时匹配初次挂载的推断。
    expect(useWhoIsFakerStore.getState().roomClosedAt).not.toBeNull();
    expect(useWhoIsFakerStore.getState().toasts.at(-1)).toMatchObject({
      text: "房间已关闭",
      type: "error",
    });
  });

  it("flags closure so a replaced session also leaves the room page", () => {
    saveSessionToken("6789", "taken-token");
    useWhoIsFakerStore.getState().joinRoomState("6789", "taken-token");
    initGameSocket();

    wsMock.emitMessage({
      type: "event",
      event: "session.replaced",
      payload: { roomId: "6789" },
    });

    expect(useWhoIsFakerStore.getState().roomClosedAt).not.toBeNull();
  });

  it("停机时原地待命：保留票据与房间态，只提示等待重连", () => {
    saveSessionToken("7890", "shutdown-token");
    useWhoIsFakerStore.getState().joinRoomState("7890", "shutdown-token");
    useWhoIsFakerStore
      .getState()
      .setSnapshot({ ...gameOverSnapshot("round-shutdown"), roomId: "7890" });
    initGameSocket();

    wsMock.emitMessage({
      type: "event",
      event: "server.shutdown",
      payload: {},
    });

    // 服务端会把房间落盘，重连后凭原票据自动回原位；提前清票据才是真的回不去了。
    expect(getSessionToken("7890")).toBe("shutdown-token");
    expect(useWhoIsFakerStore.getState().roomId).toBe("7890");
    expect(useWhoIsFakerStore.getState().sessionToken).toBe("shutdown-token");
    expect(useWhoIsFakerStore.getState().roomClosedAt).toBeNull();
    expect(useWhoIsFakerStore.getState().snapshot?.roomId).toBe("7890");
    expect(useWhoIsFakerStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        text: SERVER_SHUTDOWN_MESSAGE,
        type: "error",
      })
    );
  });

  it("停机提示停留十秒，不按默认时长提前消失", () => {
    initGameSocket();
    wsMock.emitMessage({ type: "event", event: "server.shutdown", payload: {} });

    vi.advanceTimersByTime(9999);
    expect(useWhoIsFakerStore.getState().toasts.map((toast) => toast.text)).toEqual([
      SERVER_SHUTDOWN_MESSAGE,
    ]);
    vi.advanceTimersByTime(1);
    expect(useWhoIsFakerStore.getState().toasts).toEqual([]);
  });

  it("停机作废在途入房，晚到 ACK 只释放席位不安装身份", async () => {
    let resolveAck!: (value: unknown) => void;
    wsMock.send.mockImplementation((type: string) =>
      type === "room.join"
        ? new Promise((resolve) => {
            resolveAck = resolve;
          })
        : Promise.resolve({})
    );
    initGameSocket();
    const joined = useWhoIsFakerStore
      .getState()
      .joinRoom("1234", "玩家")
      .catch((error) => error);

    wsMock.emitMessage({ type: "event", event: "server.shutdown", payload: {} });
    resolveAck({ roomId: "1234", sessionToken: "late-token" });

    // 停机后这条连接上的入房已经作废：晚到的 ACK 只用来退掉服务端席位，不写本地身份与票据。
    expect(await joined).toMatchObject({ name: "AbortError" });
    expect(wsMock.send.mock.calls.map(([type]) => type)).toEqual(["room.join", "room.leave"]);
    expect(wsMock.send.mock.calls[1][2]).toEqual({ roomId: "1234", sessionToken: "late-token" });
    expect(getSessionToken("1234")).toBeNull();
    expect(useWhoIsFakerStore.getState()).toMatchObject({ roomId: null, sessionToken: null });
  });

  it("断线作废在途入房：晚到 ACK 不安装身份，也不向新连接发旧离房", async () => {
    let resolveAck!: (value: unknown) => void;
    wsMock.send.mockImplementation((type: string) =>
      type === "room.join"
        ? new Promise((resolve) => {
            resolveAck = resolve;
          })
        : Promise.resolve({})
    );
    initGameSocket();
    const joined = useWhoIsFakerStore
      .getState()
      .joinRoom("1234", "玩家")
      .catch((error) => error);

    wsMock.emitStatus(false);
    resolveAck({ roomId: "1234", sessionToken: "late-token" });

    // 席位随旧连接消失：既不写本地身份，也不往新连接发旧凭据的退房。
    expect(await joined).toMatchObject({ name: "AbortError" });
    expect(wsMock.send.mock.calls.map(([type]) => type)).toEqual(["room.join"]);
    expect(getSessionToken("1234")).toBeNull();
    expect(useWhoIsFakerStore.getState()).toMatchObject({ roomId: null, sessionToken: null });
  });

  it("结算摘要只认服务端快照：快照不带摘要时不回填上一份", () => {
    // 摘要与 gameOver 在服务端同一步写入并随快照下发；旧的独立摘要事件已删除，
    // 客户端再回填只会把服务端已经清掉的结算重新显示出来。
    useWhoIsFakerStore.getState().setSnapshot(gameOverSnapshot("round-1", roundSummary));
    expect(useWhoIsFakerStore.getState().snapshot?.summary).toEqual(roundSummary);

    useWhoIsFakerStore.getState().setSnapshot(gameOverSnapshot("round-1"));
    expect(useWhoIsFakerStore.getState().snapshot?.summary).toBeUndefined();
  });

  it("applies game-over patches immediately after an elimination", () => {
    wsMock.send.mockResolvedValue({});
    const dispose = initGameSocket();
    const initialSnapshot: WhoIsFakerRoomSnapshot = {
      ...gameOverSnapshot("round-sync"),
      status: {
        phase: "night",
        roundId: "round-sync",
        started: true,
        day: 1,
        speechMode: "normal",
        speechOrder: [],
        submittedSpeechPlayerIds: [],
      },
      players: [
        {
          id: "player-1",
          name: "Player 1",
          score: 0,
          membership: "active",
          online: true,
          isReady: true,
          isBot: false,
          isHost: true,
          roundStatus: "alive",
        },
      ],
      summary: undefined,
    };

    wsMock.emitMessage({
      type: "event",
      event: "room.snapshot",
      payload: { mode: "full", revision: 1, state: initialSnapshot },
    });
    wsMock.emitMessage({
      type: "event",
      event: "room.snapshot",
      payload: {
        mode: "patch",
        revision: 2,
        baseRevision: 1,
        operations: [
          {
            op: "replace",
            path: "/players/0/roundStatus",
            value: "dead",
          },
        ],
      },
    });
    wsMock.emitMessage({
      type: "event",
      event: "room.snapshot",
      payload: {
        mode: "patch",
        revision: 3,
        baseRevision: 2,
        operations: [
          { op: "replace", path: "/status/phase", value: "gameOver" },
          { op: "add", path: "/summary", value: roundSummary },
        ],
      },
    });
    wsMock.emitMessage({
      type: "event",
      event: "room.snapshot",
      payload: {
        mode: "patch",
        revision: 4,
        baseRevision: 3,
        operations: [
          {
            op: "replace",
            path: "/chat",
            value: [
              {
                id: "message-1",
                playerId: "system",
                playerName: "System",
                text: "Game over",
                createdAt: 1,
                system: true,
              },
            ],
          },
        ],
      },
    });

    // 出局后的停顿交给服务端的阶段反馈，客户端不再暂扣结算快照
    expect(wsMock.send).not.toHaveBeenCalledWith("room.requestSync");
    expect(useWhoIsFakerStore.getState().snapshot?.status.phase).toBe("gameOver");
    expect(useWhoIsFakerStore.getState().snapshot?.chat[0]?.text).toBe("Game over");
    dispose();
  });

  it("records persistent notices in chat when player transitions between channels", () => {
    useWhoIsFakerStore.getState().setPrivateState({
      playerId: "p1",
      sessionToken: "token-1",
      canAct: false,
      canActAtNight: false,
      isQuestioner: false,
      canSubmitBlankGuess: false,
      blankGuessUsed: false,
      nightActionSubmitted: false,
    });

    const ingameAlive: WhoIsFakerRoomSnapshot = {
      ...gameOverSnapshot("round-1"),
      status: {
        phase: "description",
        roundId: "round-1",
        started: true,
        day: 1,
        speechMode: "normal",
        speechOrder: [],
        submittedSpeechPlayerIds: [],
      },
      players: [
        {
          id: "p1",
          name: "玩家1",
          score: 0,
          membership: "active",
          online: true,
          isReady: true,
          isBot: false,
          isHost: true,
          roundStatus: "alive",
        },
      ],
      chat: [],
    };

    useWhoIsFakerStore.getState().setSnapshot(ingameAlive);
    expect(useWhoIsFakerStore.getState().channelNotices).toHaveLength(0);

    // 玩家被淘汰 -> 触发进入观战频道提示
    const ingameDead: WhoIsFakerRoomSnapshot = {
      ...ingameAlive,
      players: [
        {
          ...ingameAlive.players[0],
          roundStatus: "dead",
        },
      ],
    };

    useWhoIsFakerStore.getState().setSnapshot(ingameDead);
    const chatAfterDead = useWhoIsFakerStore.getState().channelNotices;
    expect(chatAfterDead).toHaveLength(1);
    expect(chatAfterDead[0]?.text).toBe("已进入观战频道，发言仅对淘汰玩家与观战者可见");

    // 游戏结束 -> 触发返回公共频道提示，原提示依然保留
    const gameOverState: WhoIsFakerRoomSnapshot = {
      ...ingameDead,
      status: {
        phase: "gameOver",
        roundId: "round-1",
        started: true,
        day: 1,
        speechMode: "normal",
        speechOrder: [],
        submittedSpeechPlayerIds: [],
      },
    };

    useWhoIsFakerStore.getState().setSnapshot(gameOverState);
    vi.advanceTimersByTime(1500);
    const chatAfterGameOver = useWhoIsFakerStore.getState().channelNotices;
    expect(chatAfterGameOver).toHaveLength(2);
    expect(chatAfterGameOver[0]?.text).toBe("已进入观战频道，发言仅对淘汰玩家与观战者可见");
    expect(chatAfterGameOver[1]?.text).toBe("已返回公共聊天频道，所有玩家均可见发言");
    // 本地提示不进服务端投影，只在展示时并入。
    const { snapshot, channelNotices } = useWhoIsFakerStore.getState();
    expect(snapshot?.chat).toEqual([]);
    expect(withChannelNotices(snapshot!.chat, channelNotices)).toHaveLength(2);
  });

  it("本地频道提示的时间戳取校正后的时刻，与服务端聊天按时间排序时不错位", () => {
    vi.setSystemTime(500_000);
    // 本机时钟比服务端快 60 秒：服务端此刻是 440_000。
    recordClockSample(440_000, 500_000, 500_000);
    useWhoIsFakerStore.getState().setPrivateState({
      playerId: "p1",
      sessionToken: "token-1",
      canAct: false,
      canActAtNight: false,
      isQuestioner: false,
      canSubmitBlankGuess: false,
      blankGuessUsed: false,
      nightActionSubmitted: false,
    });
    const player = {
      id: "p1",
      name: "玩家1",
      score: 0,
      membership: "active" as const,
      online: true,
      isReady: true,
      isBot: false,
      isHost: true,
      roundStatus: "alive" as const,
    };
    const alive: WhoIsFakerRoomSnapshot = {
      ...gameOverSnapshot("round-1"),
      status: {
        phase: "description",
        roundId: "round-1",
        started: true,
        day: 1,
        speechMode: "normal",
        speechOrder: [],
        submittedSpeechPlayerIds: [],
      },
      players: [player],
      chat: [],
    };
    useWhoIsFakerStore.getState().setSnapshot(alive);
    useWhoIsFakerStore.getState().setSnapshot({
      ...alive,
      players: [{ ...player, roundStatus: "dead" }],
    });

    const notices = useWhoIsFakerStore.getState().channelNotices;
    expect(notices).toHaveLength(1);
    expect(notices[0]?.createdAt).toBe(440_000);
    resetClockSample();
  });

  it("keeps spectators in main channel during assigningQuestioner and wordSubmission, and transitions to ghost upon description", () => {
    useWhoIsFakerStore.getState().setPrivateState({
      playerId: "spec-1",
      sessionToken: "token-spec",
      canAct: false,
      canActAtNight: false,
      isQuestioner: false,
      canSubmitBlankGuess: false,
      blankGuessUsed: false,
      nightActionSubmitted: false,
    });

    const specPlayer = {
      id: "spec-1",
      name: "旁观者",
      score: 0,
      membership: "spectator" as const,
      online: true,
      isReady: true,
      isBot: false,
      isHost: false,
      roundStatus: "spectator" as const,
    };

    // 1. 指定出题人阶段 -> 保持在 main 频道，无进入观战频道提示
    const assigningState: WhoIsFakerRoomSnapshot = {
      ...gameOverSnapshot("round-spec"),
      status: {
        phase: "assigningQuestioner",
        roundId: "round-spec",
        started: true,
        day: 1,
        speechMode: "normal",
        speechOrder: [],
        submittedSpeechPlayerIds: [],
      },
      players: [specPlayer],
      chat: [],
    };
    useWhoIsFakerStore.getState().setSnapshot(assigningState);
    expect(useWhoIsFakerStore.getState().channelNotices).toHaveLength(0);

    // 2. 出题阶段 -> 保持在 main 频道，无进入观战频道提示
    const wordSubState: WhoIsFakerRoomSnapshot = {
      ...assigningState,
      status: {
        phase: "wordSubmission",
        roundId: "round-spec",
        started: true,
        day: 1,
        speechMode: "normal",
        speechOrder: [],
        submittedSpeechPlayerIds: [],
      },
    };
    useWhoIsFakerStore.getState().setSnapshot(wordSubState);
    expect(useWhoIsFakerStore.getState().channelNotices).toHaveLength(0);

    // 3. 描述阶段（正式开局）-> 开着旁观可见答案时触发进入观战频道提示
    const descState: WhoIsFakerRoomSnapshot = {
      ...assigningState,
      settings: { ...assigningState.settings, spectatorsSeeAnswers: true },
      status: {
        phase: "description",
        roundId: "round-spec",
        started: true,
        day: 1,
        speechMode: "normal",
        speechOrder: [],
        submittedSpeechPlayerIds: [],
      },
    };
    useWhoIsFakerStore.getState().setSnapshot(descState);
    const chat = useWhoIsFakerStore.getState().channelNotices;
    expect(chat).toHaveLength(1);
    expect(chat[0]?.text).toBe("已进入观战频道，发言仅对淘汰玩家与观战者可见");
  });

  it("旁观可见答案关闭时旁观者留在主频道：局中不出现进入观战频道的提示", () => {
    useWhoIsFakerStore.getState().setPrivateState({
      playerId: "spec-2",
      sessionToken: "token-spec-2",
      canAct: false,
      canActAtNight: false,
      isQuestioner: false,
      canSubmitBlankGuess: false,
      blankGuessUsed: false,
      nightActionSubmitted: false,
    });
    const specPlayer = {
      id: "spec-2",
      name: "旁观者",
      score: 0,
      membership: "spectator" as const,
      online: true,
      isReady: true,
      isBot: false,
      isHost: false,
      roundStatus: "spectator" as const,
    };
    useWhoIsFakerStore.getState().setSnapshot({
      ...gameOverSnapshot("round-spec-off"),
      status: {
        phase: "description",
        roundId: "round-spec-off",
        started: true,
        day: 1,
        speechMode: "normal",
        speechOrder: [],
        submittedSpeechPlayerIds: [],
      },
      players: [specPlayer],
      chat: [],
    });
    expect(useWhoIsFakerStore.getState().channelNotices).toHaveLength(0);
  });
});

describe("状态同步", () => {
  const requestSyncCalls = () =>
    wsMock.send.mock.calls.filter(([type]) => type === "room.requestSync");

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    wsMock.send.mockReset();
    wsMock.connect.mockReset();
    wsMock.clearHandlers();
    useWhoIsFakerStore.setState(initialState, true);
  });

  afterEach(() => {
    useWhoIsFakerStore.getState().leaveRoomState();
    vi.useRealTimers();
  });

  it("修订号连续的快照与私有态补丁逐条应用，不请求全量", () => {
    wsMock.send.mockResolvedValue({});
    initGameSocket();
    wsMock.emitMessage({
      type: "event",
      event: "room.snapshot",
      payload: { mode: "full", revision: 1, state: gameOverSnapshot("sync-round") },
    });
    wsMock.emitMessage({
      type: "event",
      event: "room.snapshot",
      payload: {
        mode: "patch",
        baseRevision: 1,
        revision: 2,
        operations: [{ op: "replace", path: "/name", value: "第二天" }],
      },
    });
    expect(useWhoIsFakerStore.getState().snapshot?.name).toBe("第二天");
    wsMock.emitMessage({
      type: "event",
      event: "room.snapshot",
      payload: {
        mode: "patch",
        baseRevision: 2,
        revision: 3,
        operations: [{ op: "replace", path: "/status/day", value: 2 }],
      },
    });
    expect(useWhoIsFakerStore.getState().snapshot?.status.day).toBe(2);

    wsMock.emitMessage({
      type: "event",
      event: "game.privateState",
      payload: { mode: "full", revision: 1, state: wifPrivate(WIF_PEOPLE.host, "waiting") },
    });
    wsMock.emitMessage({
      type: "event",
      event: "game.privateState",
      payload: {
        mode: "patch",
        baseRevision: 1,
        revision: 2,
        operations: [{ op: "replace", path: "/nightActionSubmitted", value: true }],
      },
    });
    expect(useWhoIsFakerStore.getState().privateState?.nightActionSubmitted).toBe(true);
    expect(requestSyncCalls()).toHaveLength(0);
  });

  it("补丁跳号时请求全量，缺口补丁不落在旧基线上", async () => {
    wsMock.send.mockResolvedValue({});
    initGameSocket();
    wsMock.emitMessage({
      type: "event",
      event: "room.snapshot",
      payload: { mode: "full", revision: 1, state: gameOverSnapshot("sync-round") },
    });
    wsMock.emitMessage({
      type: "event",
      event: "room.snapshot",
      payload: {
        mode: "patch",
        baseRevision: 2,
        revision: 3,
        operations: [{ op: "replace", path: "/name", value: "错位" }],
      },
    });
    expect(requestSyncCalls()).toHaveLength(1);
    expect(wsMock.send).toHaveBeenCalledWith("room.requestSync", {}, expect.anything());
    expect(useWhoIsFakerStore.getState().snapshot?.name).toBe("结算房间");

    // 私有态通道同一口径：跳号即全量，展示态保持旧值。
    await vi.advanceTimersByTimeAsync(0);
    const privateState = wifPrivate(WIF_PEOPLE.host, "waiting");
    wsMock.emitMessage({
      type: "event",
      event: "game.privateState",
      payload: { mode: "full", revision: 1, state: privateState },
    });
    wsMock.emitMessage({
      type: "event",
      event: "game.privateState",
      payload: {
        mode: "patch",
        baseRevision: 2,
        revision: 3,
        operations: [{ op: "replace", path: "/playerId", value: "tampered" }],
      },
    });
    expect(requestSyncCalls()).toHaveLength(2);
    expect(useWhoIsFakerStore.getState().privateState?.playerId).toBe(privateState.playerId);
  });

  it("全量请求在途时，两条通道的后续缺口不重复发", async () => {
    let resolveSync!: (value: unknown) => void;
    wsMock.send.mockImplementation((type: string) =>
      type === "room.requestSync"
        ? new Promise((resolve) => {
            resolveSync = resolve;
          })
        : Promise.resolve({})
    );
    initGameSocket();
    wsMock.emitMessage({
      type: "event",
      event: "room.snapshot",
      payload: { mode: "full", revision: 1, state: gameOverSnapshot("sync-round") },
    });
    const gap = (revision: number) => ({
      type: "event" as const,
      event: "room.snapshot",
      payload: {
        mode: "patch" as const,
        baseRevision: 2,
        revision,
        operations: [{ op: "replace" as const, path: "/name", value: "错位" }],
      },
    });
    wsMock.emitMessage(gap(3));
    // 私有态还没有基线，补丁同样构成缺口；两条通道共用一个在途标记。
    wsMock.emitMessage({
      type: "event",
      event: "game.privateState",
      payload: {
        mode: "patch",
        baseRevision: 0,
        revision: 1,
        operations: [{ op: "replace", path: "/playerId", value: "tampered" }],
      },
    });
    wsMock.emitMessage(gap(4));
    expect(requestSyncCalls()).toHaveLength(1);
    expect(useWhoIsFakerStore.getState().snapshot?.name).toBe("结算房间");

    resolveSync({});
    await vi.advanceTimersByTimeAsync(0);
    wsMock.emitMessage(gap(5));
    expect(requestSyncCalls()).toHaveLength(2);
  });

  it("入房在途时推送只更新基线，ACK 后一次安装暂存状态", async () => {
    let resolveAck!: (value: unknown) => void;
    wsMock.send.mockImplementation((type: string) =>
      type === "room.join"
        ? new Promise((resolve) => {
            resolveAck = resolve;
          })
        : Promise.resolve({})
    );
    initGameSocket();
    const joined = useWhoIsFakerStore.getState().joinRoom("1234", "玩家");
    wsMock.emitMessage({
      type: "event",
      event: "room.snapshot",
      payload: {
        mode: "full",
        revision: 1,
        state: { ...gameOverSnapshot("sync-round"), roomId: "1234" },
      },
    });
    wsMock.emitMessage({
      type: "event",
      event: "room.snapshot",
      payload: {
        mode: "patch",
        baseRevision: 1,
        revision: 2,
        operations: [{ op: "replace", path: "/name", value: "暂存名" }],
      },
    });
    wsMock.emitMessage({
      type: "event",
      event: "game.privateState",
      payload: {
        mode: "full",
        revision: 1,
        state: wifPrivate(WIF_PEOPLE.host, "waiting", { sessionToken: "entry-token" }),
      },
    });
    // 连续补丁被基线正常消费：没有触发全量请求，但展示态与身份都还没安装。
    expect(requestSyncCalls()).toHaveLength(0);
    expect(useWhoIsFakerStore.getState()).toMatchObject({
      roomId: null,
      sessionToken: null,
      snapshot: null,
      privateState: null,
    });

    resolveAck({ roomId: "1234", sessionToken: "entry-token" });
    await joined;
    expect(useWhoIsFakerStore.getState()).toMatchObject({
      roomId: "1234",
      sessionToken: "entry-token",
    });
    expect(useWhoIsFakerStore.getState().snapshot?.name).toBe("暂存名");
    expect(useWhoIsFakerStore.getState().privateState?.sessionToken).toBe("entry-token");
  });
});

it("玩法清理关闭连接、释放订阅并保留刷新凭据，可重新初始化", () => {
  wsMock.disconnect.mockClear();
  saveSessionToken("1234", "recoverable");
  useWhoIsFakerStore.setState({ connected: true, lobbyReady: true });
  const cleanup = initGameSocket();
  cleanup();
  expect(wsMock.disconnect).toHaveBeenCalledOnce();
  expect(wsMock.getMessageHandlers()).toHaveLength(0);
  expect(wsMock.getStatusHandlers()).toHaveLength(0);
  expect(useWhoIsFakerStore.getState()).toMatchObject({ connected: false, lobbyReady: false });
  expect(getSessionToken("1234")).toBe("recoverable");
  const next = initGameSocket();
  expect(wsMock.getMessageHandlers()).toHaveLength(1);
  next();
});

describe("卧底提示行为", () => {
  const shownToasts = () => useWhoIsFakerStore.getState().toasts;

  beforeEach(() => {
    vi.useFakeTimers();
    useWhoIsFakerStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("不同提示并存，按发出先后排列", () => {
    const { showToast } = useWhoIsFakerStore.getState();
    showToast("第一条");
    showToast("第二条", "error");
    expect(shownToasts().map((t) => [t.text, t.type])).toEqual([
      ["第一条", "info"],
      ["第二条", "error"],
    ]);
  });

  it("连续两条相同提示仍是一条，编号不变，重播一次", () => {
    const { showToast } = useWhoIsFakerStore.getState();
    showToast("同一句");
    const first = shownToasts()[0];
    showToast("同一句");
    expect(shownToasts().map((t) => t.text)).toEqual(["同一句"]);
    expect(shownToasts()[0].id).toBe(first.id);
    expect(shownToasts()[0].repeat).toBe(1);
  });

  it("普通信息三秒、错误五秒到点消失", () => {
    const { showToast } = useWhoIsFakerStore.getState();
    showToast("普通信息");
    showToast("错误", "error");
    vi.advanceTimersByTime(2999);
    expect(shownToasts().map((t) => t.text)).toEqual(["普通信息", "错误"]);
    vi.advanceTimersByTime(1);
    expect(shownToasts().map((t) => t.text)).toEqual(["错误"]);
    vi.advanceTimersByTime(1999);
    expect(shownToasts().map((t) => t.text)).toEqual(["错误"]);
    vi.advanceTimersByTime(1);
    expect(shownToasts()).toEqual([]);
  });

  it("手动传时长按传入值到点消失", () => {
    useWhoIsFakerStore.getState().showToast("短提示", "error", 1000);
    vi.advanceTimersByTime(999);
    expect(shownToasts().map((t) => t.text)).toEqual(["短提示"]);
    vi.advanceTimersByTime(1);
    expect(shownToasts()).toEqual([]);
  });

  it("默认类型是普通信息", () => {
    useWhoIsFakerStore.getState().showToast("默认类型");
    expect(shownToasts().map((t) => t.type)).toEqual(["info"]);
  });

  it("最多同时三条，再来新的最早一条让位", () => {
    const { showToast } = useWhoIsFakerStore.getState();
    for (const text of ["一", "二", "三", "四"]) showToast(text);
    expect(shownToasts().map((t) => t.text)).toEqual(["二", "三", "四"]);
  });
});
