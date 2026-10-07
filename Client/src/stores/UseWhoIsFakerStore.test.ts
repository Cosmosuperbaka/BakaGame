import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WhoIsFakerRoomSnapshot, RoundSummary, ServerMessage } from "@/types";
import { SERVER_SHUTDOWN_MESSAGE } from "@/types";



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
  whoIsFakerWsClient: { disconnect: wsMock.disconnect },
  connect: wsMock.connect,
  onMessage: wsMock.onMessage,
  onStatus: wsMock.onStatus,
}));

import { getSessionToken, saveSessionToken } from "@/lib/Storage";
import { initWhoIsFakerWs as initGameSocket, useWhoIsFakerStore } from "./UseWhoIsFakerStore";

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
    const history = Array.from({ length: 250 }, (_, index) => ({ id: `chat-${index}`, playerId: "p", playerName: "玩家", text: `消息${index}`, system: false, createdAt: index }));
    useWhoIsFakerStore.getState().setSnapshot({ ...base, chat: history });
    const chat = useWhoIsFakerStore.getState().snapshot?.chat ?? [];
    expect(chat).toHaveLength(200);
    expect(chat[0]?.id).toBe("chat-50");
    expect(chat.at(-1)?.id).toBe("chat-249");
  });

  it("persists a newly created room session in the current tab", async () => {
    wsMock.send.mockResolvedValue({ sessionToken: "created-token" });

    await useWhoIsFakerStore.getState().createRoom({
      roomId: "1234",
      name: "测试房间",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
    });

    expect(wsMock.send).toHaveBeenCalledWith("room.create", expect.objectContaining({
      roomId: "1234",
      userName: "房主",
    }));
    expect(getSessionToken("1234")).toBe("created-token");
    expect(useWhoIsFakerStore.getState()).toMatchObject({
      roomId: "1234",
      sessionToken: "created-token",
    });
  });

  it("退房回包慢于下一次进房时，只清掉发起退房的会话", async () => {
    let ack!: () => void;
    wsMock.send.mockReturnValue(new Promise<void>((resolve) => { ack = resolve; }));
    saveSessionToken("1234", "old-token");
    useWhoIsFakerStore.setState({ roomId: "1234", sessionToken: "old-token" });

    const leaving = useWhoIsFakerStore.getState().leaveRoom();
    // 退房在房间页卸载后才发出，回包到达前玩家已经进了下一个房间。
    saveSessionToken("5678", "new-token");
    useWhoIsFakerStore.setState({ roomId: "5678", sessionToken: "new-token" });
    ack();
    await leaving;

    expect(useWhoIsFakerStore.getState()).toMatchObject({ roomId: "5678", sessionToken: "new-token" });
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
      expect.objectContaining({ text: "会话已失效，请重新加入", type: "error" }),
    );
  });


  it("临时重连失败保留重试凭据但拒绝调用方，不伪装入房成功", async () => {
    saveSessionToken("2346", "live-token");
    wsMock.send.mockRejectedValue({ code: "DISCONNECTED" });

    await expect(useWhoIsFakerStore.getState().reconnectRoom("2346")).rejects.toMatchObject({ code: "DISCONNECTED" });
    expect(getSessionToken("2346")).toBe("live-token");
    expect(useWhoIsFakerStore.getState()).toMatchObject({
      roomId: null,
      sessionToken: null,
      roomClosedAt: null,
    });
  });

  it("subscribes and restores the active session after socket reconnection", async () => {
    wsMock.send.mockResolvedValue({ roomId: "3456", sessionToken: "live-token" });
    useWhoIsFakerStore.getState().joinRoomState("3456", "live-token");
    const dispose = initGameSocket();

    wsMock.emitStatus(true);
    await Promise.resolve();

    expect(useWhoIsFakerStore.getState().connected).toBe(true);
    expect(wsMock.send).toHaveBeenCalledWith("lobby.subscribeRooms");
    expect(wsMock.send).toHaveBeenCalledWith("room.reconnect", {
      roomId: "3456",
      sessionToken: "live-token",
    });
    dispose();
    expect(wsMock.getMessageHandlers()).toHaveLength(0);
    expect(wsMock.getStatusHandlers()).toHaveLength(0);
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

  it("leaves room, clears token, and displays shutdown message on server.shutdown", () => {
    saveSessionToken("7890", "shutdown-token");
    useWhoIsFakerStore.getState().joinRoomState("7890", "shutdown-token");
    initGameSocket();

    wsMock.emitMessage({
      type: "event",
      event: "server.shutdown",
      payload: {},
    });

    expect(getSessionToken("7890")).toBeNull();
    expect(useWhoIsFakerStore.getState().roomId).toBeNull();
    expect(useWhoIsFakerStore.getState().snapshot).toBeNull();
    expect(useWhoIsFakerStore.getState().roomClosedAt).not.toBeNull();
    expect(useWhoIsFakerStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        text: SERVER_SHUTDOWN_MESSAGE,
        type: "error",
      }),
    );
  });


  it("keeps the current round summary when a transient game-over snapshot omits it", () => {
    useWhoIsFakerStore.getState().setSnapshot(gameOverSnapshot("round-1", roundSummary));
    useWhoIsFakerStore.getState().setSnapshot(gameOverSnapshot("round-1"));

    expect(useWhoIsFakerStore.getState().snapshot?.summary).toEqual(roundSummary);

    useWhoIsFakerStore.getState().setSnapshot(gameOverSnapshot("round-2"));
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
        operations: [{
          op: "replace",
          path: "/players/0/roundStatus",
          value: "dead",
        }],
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
        operations: [{
          op: "replace",
          path: "/chat",
          value: [{
            id: "message-1",
            playerId: "system",
            playerName: "System",
            text: "Game over",
            createdAt: 1,
            system: true,
          }],
        }],
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
      isQuestioner: false,
      canSubmitBlankGuess: false,
      blankGuessUsed: false,
      nightActionSubmitted: false,
    });

    const ingameAlive: WhoIsFakerRoomSnapshot = {
      ...gameOverSnapshot("round-1"),
      status: { phase: "description", roundId: "round-1", started: true, day: 1 },
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
    expect(useWhoIsFakerStore.getState().snapshot?.chat).toHaveLength(0);

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
    const chatAfterDead = useWhoIsFakerStore.getState().snapshot?.chat ?? [];
    expect(chatAfterDead).toHaveLength(1);
    expect(chatAfterDead[0]?.text).toBe("已进入观战频道，发言仅对淘汰玩家与观战者可见");

    // 游戏结束 -> 触发返回公共频道提示，原提示依然保留
    const gameOverState: WhoIsFakerRoomSnapshot = {
      ...ingameDead,
      status: { phase: "gameOver", roundId: "round-1", started: true, day: 1 },
    };

    useWhoIsFakerStore.getState().setSnapshot(gameOverState);
    vi.advanceTimersByTime(1500);
    const chatAfterGameOver = useWhoIsFakerStore.getState().snapshot?.chat ?? [];
    expect(chatAfterGameOver).toHaveLength(2);
    expect(chatAfterGameOver[0]?.text).toBe("已进入观战频道，发言仅对淘汰玩家与观战者可见");
    expect(chatAfterGameOver[1]?.text).toBe("已返回公共聊天频道，所有玩家均可见发言");
  });

  it("keeps spectators in main channel during assigningQuestioner and wordSubmission, and transitions to ghost upon description", () => {
    useWhoIsFakerStore.getState().setPrivateState({
      playerId: "spec-1",
      sessionToken: "token-spec",
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
      status: { phase: "assigningQuestioner", roundId: "round-spec", started: true, day: 1 },
      players: [specPlayer],
      chat: [],
    };
    useWhoIsFakerStore.getState().setSnapshot(assigningState);
    expect(useWhoIsFakerStore.getState().snapshot?.chat).toHaveLength(0);

    // 2. 出题阶段 -> 保持在 main 频道，无进入观战频道提示
    const wordSubState: WhoIsFakerRoomSnapshot = {
      ...assigningState,
      status: { phase: "wordSubmission", roundId: "round-spec", started: true, day: 1 },
    };
    useWhoIsFakerStore.getState().setSnapshot(wordSubState);
    expect(useWhoIsFakerStore.getState().snapshot?.chat).toHaveLength(0);

    // 3. 描述阶段（正式开局）-> 触发进入观战频道提示
    const descState: WhoIsFakerRoomSnapshot = {
      ...assigningState,
      status: { phase: "description", roundId: "round-spec", started: true, day: 1 },
    };
    useWhoIsFakerStore.getState().setSnapshot(descState);
    const chat = useWhoIsFakerStore.getState().snapshot?.chat ?? [];
    expect(chat).toHaveLength(1);
    expect(chat[0]?.text).toBe("已进入观战频道，发言仅对淘汰玩家与观战者可见");
  });
});


it("玩法清理关闭连接、释放订阅并保留刷新凭据，可重新初始化", () => {
  saveSessionToken("1234", "recoverable");
  useWhoIsFakerStore.setState({connected:true,lobbyReady:true});
  const cleanup=initGameSocket();cleanup();
  expect(wsMock.disconnect).toHaveBeenCalledOnce();
  expect(wsMock.getMessageHandlers()).toHaveLength(0);
  expect(wsMock.getStatusHandlers()).toHaveLength(0);
  expect(useWhoIsFakerStore.getState()).toMatchObject({connected:false,lobbyReady:false});
  expect(getSessionToken("1234")).toBe("recoverable");
  const next=initGameSocket();expect(wsMock.getMessageHandlers()).toHaveLength(1);next();
});
