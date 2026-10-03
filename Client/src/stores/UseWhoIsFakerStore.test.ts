import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RoomSnapshot, RoundSummary, ServerMessage } from "@/types";
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
import { initWhoIsFakerWs as initGameSocket, useWhoIsFakerStore as useGameStore } from "./UseWhoIsFakerStore";

const initialState = useGameStore.getState();

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

const gameOverSnapshot = (roundId: string, summary?: RoundSummary): RoomSnapshot => ({
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
    useGameStore.setState(initialState, true);
  });

  afterEach(() => {
    useGameStore.getState().leaveRoomState();
    vi.useRealTimers();
  });

  it("persists a newly created room session in the current tab", async () => {
    wsMock.send.mockResolvedValue({ sessionToken: "created-token" });

    await useGameStore.getState().createRoom({
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
    expect(useGameStore.getState()).toMatchObject({
      roomId: "1234",
      sessionToken: "created-token",
    });
  });

  it("退房回包慢于下一次进房时，只清掉发起退房的会话", async () => {
    let ack!: () => void;
    wsMock.send.mockReturnValue(new Promise<void>((resolve) => { ack = resolve; }));
    saveSessionToken("1234", "old-token");
    useGameStore.setState({ roomId: "1234", sessionToken: "old-token" });

    const leaving = useGameStore.getState().leaveRoom();
    // 退房在房间页卸载后才发出，回包到达前玩家已经进了下一个房间。
    saveSessionToken("5678", "new-token");
    useGameStore.setState({ roomId: "5678", sessionToken: "new-token" });
    ack();
    await leaving;

    expect(useGameStore.getState()).toMatchObject({ roomId: "5678", sessionToken: "new-token" });
    expect(getSessionToken("5678")).toBe("new-token");
    // 已离开房间的旧凭据照常删掉，免得下次重连拿着失效凭据先报一次错。
    expect(getSessionToken("1234")).toBeNull();
  });

  it("clears a stale token after reconnect fails", async () => {
    saveSessionToken("2345", "stale-token");
    wsMock.send.mockRejectedValue({ code: "SESSION_NOT_FOUND" });

    await expect(useGameStore.getState().reconnectRoom("2345")).resolves.toBe(false);
    expect(getSessionToken("2345")).toBeNull();
    expect(useGameStore.getState().roomId).toBeNull();
    expect(useGameStore.getState().roomClosedAt).toBeNull();
    expect(useGameStore.getState().toasts).toContainEqual(
      expect.objectContaining({ text: "会话已失效，请重新加入", type: "error" }),
    );
  });


  it("keeps the room session while a reconnect request fails transiently", async () => {
    saveSessionToken("2346", "live-token");
    wsMock.send.mockRejectedValue({ code: "DISCONNECTED" });

    await expect(useGameStore.getState().reconnectRoom("2346")).resolves.toBe(true);
    expect(getSessionToken("2346")).toBe("live-token");
    expect(useGameStore.getState()).toMatchObject({
      roomId: "2346",
      sessionToken: "live-token",
      roomClosedAt: null,
    });
  });

  it("subscribes and restores the active session after socket reconnection", async () => {
    wsMock.send.mockResolvedValue({});
    useGameStore.getState().joinRoomState("3456", "live-token");
    const dispose = initGameSocket();

    wsMock.emitStatus(true);
    await Promise.resolve();

    expect(useGameStore.getState().connected).toBe(true);
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
    useGameStore.getState().joinRoomState("4567", "replaced-token");
    initGameSocket();

    wsMock.emitMessage({
      type: "event",
      event: "session.replaced",
      payload: { roomId: "4567" },
    });

    expect(getSessionToken("4567")).toBeNull();
    expect(useGameStore.getState()).toMatchObject({ roomId: null, sessionToken: null });
    expect(useGameStore.getState().toasts.at(-1)).toMatchObject({
      text: "您的连接已被新标签页替代",
      type: "error",
    });
  });

  it("clears the session token and flags closure when the room is closed", () => {
    saveSessionToken("5678", "closed-token");
    useGameStore.getState().joinRoomState("5678", "closed-token");
    initGameSocket();

    wsMock.emitMessage({
      type: "event",
      event: "room.closed",
      payload: { roomId: "5678", reason: "empty" },
    });

    // 令牌必须一起清掉，否则下次进房会去重连一个已被删除的房间。
    expect(getSessionToken("5678")).toBeNull();
    expect(useGameStore.getState()).toMatchObject({ roomId: null, snapshot: null });
    // 房间页据此退回大厅，而不是靠「没有快照」这种同时匹配初次挂载的推断。
    expect(useGameStore.getState().roomClosedAt).not.toBeNull();
  });

  it("flags closure so a replaced session also leaves the room page", () => {
    saveSessionToken("6789", "taken-token");
    useGameStore.getState().joinRoomState("6789", "taken-token");
    initGameSocket();

    wsMock.emitMessage({
      type: "event",
      event: "session.replaced",
      payload: { roomId: "6789" },
    });

    expect(useGameStore.getState().roomClosedAt).not.toBeNull();
  });

  it("leaves room, clears token, and displays shutdown message on server.shutdown", () => {
    saveSessionToken("7890", "shutdown-token");
    useGameStore.getState().joinRoomState("7890", "shutdown-token");
    initGameSocket();

    wsMock.emitMessage({
      type: "event",
      event: "server.shutdown",
      payload: {},
    });

    expect(getSessionToken("7890")).toBeNull();
    expect(useGameStore.getState().roomId).toBeNull();
    expect(useGameStore.getState().snapshot).toBeNull();
    expect(useGameStore.getState().roomClosedAt).not.toBeNull();
    expect(useGameStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        text: SERVER_SHUTDOWN_MESSAGE,
        type: "error",
      }),
    );
  });


  it("keeps the current round summary when a transient game-over snapshot omits it", () => {
    useGameStore.getState().setSnapshot(gameOverSnapshot("round-1", roundSummary));
    useGameStore.getState().setSnapshot(gameOverSnapshot("round-1"));

    expect(useGameStore.getState().snapshot?.summary).toEqual(roundSummary);

    useGameStore.getState().setSnapshot(gameOverSnapshot("round-2"));
    expect(useGameStore.getState().snapshot?.summary).toBeUndefined();
  });

  it("keeps a phase elimination visible before presenting game over", async () => {
    const beforeElimination: RoomSnapshot = {
      ...gameOverSnapshot("round-result"),
      status: {
        phase: "voting",
        roundId: "round-result",
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
    const eliminationSnapshot: RoomSnapshot = {
      ...beforeElimination,
      players: beforeElimination.players.map((player) => ({
        ...player,
        roundStatus: "dead" as const,
      })),
    };
    const finalSnapshot: RoomSnapshot = {
      ...gameOverSnapshot("round-result", roundSummary),
      players: eliminationSnapshot.players,
    };

    useGameStore.getState().setSnapshot(beforeElimination);
    useGameStore.getState().setSnapshot(eliminationSnapshot);
    useGameStore.getState().setSnapshot(finalSnapshot);

    expect(useGameStore.getState().snapshot?.status.phase).toBe("voting");
    expect(useGameStore.getState().snapshot?.players[0]?.roundStatus).toBe("dead");
    expect(useGameStore.getState().phaseResultPresentationPending).toBe(true);

    await expect(useGameStore.getState().sendCommand("game.advancePhase")).rejects.toThrow(
      "阶段结果展示中，请稍候",
    );
    expect(wsMock.send).not.toHaveBeenCalledWith(
      "game.advancePhase",
      expect.anything(),
      expect.anything(),
    );

    vi.advanceTimersByTime(1499);
    expect(useGameStore.getState().snapshot?.status.phase).toBe("voting");

    vi.advanceTimersByTime(1);
    expect(useGameStore.getState().snapshot?.status.phase).toBe("gameOver");
    expect(useGameStore.getState().snapshot?.summary).toEqual(roundSummary);
    expect(useGameStore.getState().phaseResultPresentationPending).toBe(false);
  });

  it("continues applying snapshot patches while game over is held for presentation", () => {
    wsMock.send.mockResolvedValue({});
    const dispose = initGameSocket();
    const initialSnapshot: RoomSnapshot = {
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

    expect(useGameStore.getState().snapshot?.status.phase).toBe("night");
    expect(wsMock.send).not.toHaveBeenCalledWith("room.requestSync");

    vi.advanceTimersByTime(1500);
    expect(useGameStore.getState().snapshot?.status.phase).toBe("gameOver");
    expect(useGameStore.getState().snapshot?.chat[0]?.text).toBe("Game over");
    dispose();
  });

  it("records persistent notices in chat when player transitions between channels", () => {
    useGameStore.getState().setPrivateState({
      playerId: "p1",
      sessionToken: "token-1",
      isQuestioner: false,
      canSubmitBlankGuess: false,
      blankGuessUsed: false,
      nightActionSubmitted: false,
    });

    const ingameAlive: RoomSnapshot = {
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

    useGameStore.getState().setSnapshot(ingameAlive);
    expect(useGameStore.getState().snapshot?.chat).toHaveLength(0);

    // 玩家被淘汰 -> 触发进入观战频道提示
    const ingameDead: RoomSnapshot = {
      ...ingameAlive,
      players: [
        {
          ...ingameAlive.players[0],
          roundStatus: "dead",
        },
      ],
    };

    useGameStore.getState().setSnapshot(ingameDead);
    const chatAfterDead = useGameStore.getState().snapshot?.chat ?? [];
    expect(chatAfterDead).toHaveLength(1);
    expect(chatAfterDead[0]?.text).toBe("已进入观战频道，发言仅对淘汰玩家与观战者可见");

    // 游戏结束 -> 触发返回公共频道提示，原提示依然保留
    const gameOverState: RoomSnapshot = {
      ...ingameDead,
      status: { phase: "gameOver", roundId: "round-1", started: true, day: 1 },
    };

    useGameStore.getState().setSnapshot(gameOverState);
    vi.advanceTimersByTime(1500);
    const chatAfterGameOver = useGameStore.getState().snapshot?.chat ?? [];
    expect(chatAfterGameOver).toHaveLength(2);
    expect(chatAfterGameOver[0]?.text).toBe("已进入观战频道，发言仅对淘汰玩家与观战者可见");
    expect(chatAfterGameOver[1]?.text).toBe("已返回公共聊天频道，所有玩家均可见发言");
  });

  it("keeps spectators in main channel during assigningQuestioner and wordSubmission, and transitions to ghost upon description", () => {
    useGameStore.getState().setPrivateState({
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
    const assigningState: RoomSnapshot = {
      ...gameOverSnapshot("round-spec"),
      status: { phase: "assigningQuestioner", roundId: "round-spec", started: true, day: 1 },
      players: [specPlayer],
      chat: [],
    };
    useGameStore.getState().setSnapshot(assigningState);
    expect(useGameStore.getState().snapshot?.chat).toHaveLength(0);

    // 2. 出题阶段 -> 保持在 main 频道，无进入观战频道提示
    const wordSubState: RoomSnapshot = {
      ...assigningState,
      status: { phase: "wordSubmission", roundId: "round-spec", started: true, day: 1 },
    };
    useGameStore.getState().setSnapshot(wordSubState);
    expect(useGameStore.getState().snapshot?.chat).toHaveLength(0);

    // 3. 描述阶段（正式开局）-> 触发进入观战频道提示
    const descState: RoomSnapshot = {
      ...assigningState,
      status: { phase: "description", roundId: "round-spec", started: true, day: 1 },
    };
    useGameStore.getState().setSnapshot(descState);
    const chat = useGameStore.getState().snapshot?.chat ?? [];
    expect(chat).toHaveLength(1);
    expect(chat[0]?.text).toBe("已进入观战频道，发言仅对淘汰玩家与观战者可见");
  });
});


it("玩法清理关闭连接、释放订阅并保留刷新凭据，可重新初始化", () => {
  saveSessionToken("1234", "recoverable");
  useGameStore.setState({connected:true,lobbyReady:true});
  const cleanup=initGameSocket();cleanup();
  expect(wsMock.disconnect).toHaveBeenCalledOnce();
  expect(wsMock.getMessageHandlers()).toHaveLength(0);
  expect(wsMock.getStatusHandlers()).toHaveLength(0);
  expect(useGameStore.getState()).toMatchObject({connected:false,lobbyReady:false});
  expect(getSessionToken("1234")).toBe("recoverable");
  const next=initGameSocket();expect(wsMock.getMessageHandlers()).toHaveLength(1);next();
});
