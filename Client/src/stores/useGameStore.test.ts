import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RoomSnapshot, RoundSummary, ServerMessage } from "@/types";

const wsMock = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn(),
  messageHandlers: [] as Array<(message: ServerMessage) => void>,
  statusHandlers: [] as Array<(connected: boolean) => void>,
}));

vi.mock("@/lib/ws", () => ({
  send: wsMock.send,
  connect: wsMock.connect,
  onMessage: (handler: (message: ServerMessage) => void) => {
    wsMock.messageHandlers.push(handler);
    return () => {
      wsMock.messageHandlers = wsMock.messageHandlers.filter((entry) => entry !== handler);
    };
  },
  onStatus: (handler: (connected: boolean) => void) => {
    wsMock.statusHandlers.push(handler);
    return () => {
      wsMock.statusHandlers = wsMock.statusHandlers.filter((entry) => entry !== handler);
    };
  },
}));

import { getSessionToken, saveSessionToken } from "@/lib/cookie";
import { initGameSocket, useGameStore } from "./useGameStore";

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
    wsMock.messageHandlers = [];
    wsMock.statusHandlers = [];
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

  it("clears a stale token after reconnect fails", async () => {
    saveSessionToken("2345", "stale-token");
    wsMock.send.mockRejectedValue({ code: "SESSION_NOT_FOUND" });

    await expect(useGameStore.getState().reconnectRoom("2345")).resolves.toBe(false);
    expect(getSessionToken("2345")).toBeNull();
    expect(useGameStore.getState().roomId).toBeNull();
    expect(useGameStore.getState().roomClosedAt).not.toBeNull();
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

    wsMock.statusHandlers[0](true);
    await Promise.resolve();

    expect(useGameStore.getState().connected).toBe(true);
    expect(wsMock.send).toHaveBeenCalledWith("lobby.subscribeRooms");
    expect(wsMock.send).toHaveBeenCalledWith("room.reconnect", {
      roomId: "3456",
      sessionToken: "live-token",
    });
    dispose();
    expect(wsMock.messageHandlers).toHaveLength(0);
    expect(wsMock.statusHandlers).toHaveLength(0);
  });

  it("drops local authority when another tab replaces the session", () => {
    saveSessionToken("4567", "replaced-token");
    useGameStore.getState().joinRoomState("4567", "replaced-token");
    initGameSocket();

    wsMock.messageHandlers[0]({
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

    wsMock.messageHandlers[0]({
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

    wsMock.messageHandlers[0]({
      type: "event",
      event: "session.replaced",
      payload: { roomId: "6789" },
    });

    expect(useGameStore.getState().roomClosedAt).not.toBeNull();
  });

  it("keeps the current round summary when a transient game-over snapshot omits it", () => {
    useGameStore.getState().setSnapshot(gameOverSnapshot("round-1", roundSummary));
    useGameStore.getState().setSnapshot(gameOverSnapshot("round-1"));

    expect(useGameStore.getState().snapshot?.summary).toEqual(roundSummary);

    useGameStore.getState().setSummary(null);
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

    wsMock.messageHandlers[0]({
      type: "event",
      event: "room.snapshot",
      payload: { mode: "full", revision: 1, state: initialSnapshot },
    });
    wsMock.messageHandlers[0]({
      type: "event",
      event: "room.snapshot",
      payload: {
        mode: "patch",
        revision: 2,
        baseRevision: 1,
        operations: [{
          op: "set",
          path: ["players", 0, "roundStatus"],
          value: "dead",
        }],
      },
    });
    wsMock.messageHandlers[0]({
      type: "event",
      event: "room.snapshot",
      payload: {
        mode: "patch",
        revision: 3,
        baseRevision: 2,
        operations: [
          { op: "set", path: ["status", "phase"], value: "gameOver" },
          { op: "set", path: ["summary"], value: roundSummary },
        ],
      },
    });
    wsMock.messageHandlers[0]({
      type: "event",
      event: "room.snapshot",
      payload: {
        mode: "patch",
        revision: 4,
        baseRevision: 3,
        operations: [{
          op: "set",
          path: ["chat"],
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
});
