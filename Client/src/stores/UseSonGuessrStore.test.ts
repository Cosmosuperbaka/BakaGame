import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ServerMessage,
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
} from "@/types";

const wsMock = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn(),
  messageHandlers: [] as Array<(message: ServerMessage) => void>,
  statusHandlers: [] as Array<(connected: boolean) => void>,
}));

vi.mock("@/lib/SonGuessrWs", () => ({
  sonGuessrWs: {
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
  },
  songGuessrWs: {
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
  },
}));

import {
  getSessionToken,
  getSonGuessrSessionToken,
  saveSessionToken,
  saveSonGuessrSessionToken,
} from "@/lib/Storage";
import { initSonGuessrWs, useSonGuessrStore } from "./UseSonGuessrStore";

const initialState = useSonGuessrStore.getState();

const snapshot: SonGuessrRoomSnapshot = {
  roomId: "1234",
  name: "音乐房间",
  visibility: "public",
  allowSpectators: true,
  hasPassword: false,
  maxPlayers: 16,
  testMode: false,
  musicAccountReady: false,
  hostPlayerId: "player-1",
  settings: {
    questionType: "song",
    questionMode: "manual",
    autoRotateSubmitter: false,
    autoFilters: { artists: [], minPopularity: 0 },
    lyricsLineCount: 4,
    showLyrics: true,
    bloodMode: false,
    maxGuessesPerRound: 5,
    guessDurationSeconds: 60,
    showGuessTimer: true,
  },
  phase: "waiting",
  roundNumber: 0,
  players: [],
  chat: [],
};

const privateState: SonGuessrPrivateState = {
  playerId: "player-1",
  sessionToken: "live-token",
  isSubmitter: false,
  canSubmitSong: false,
  canGuess: false,
  canGiveUp: false,
  remainingGuesses: 5,
  visibleAttempts: [],
};

describe("Songuessr store integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
    wsMock.send.mockReset();
    wsMock.connect.mockReset();
    wsMock.messageHandlers = [];
    wsMock.statusHandlers = [];
    useSonGuessrStore.setState(initialState, true);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("persists created room sessions in the Songuessr namespace", async () => {
    wsMock.send.mockResolvedValue({ sessionToken: "created-token" });

    await useSonGuessrStore.getState().createRoom({
      roomId: "1234",
      name: "音乐房间",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
    });

    expect(wsMock.send).toHaveBeenCalledWith(
      "song.room.create",
      expect.objectContaining({ roomId: "1234", userName: "房主" }),
    );
    expect(getSonGuessrSessionToken("1234")).toBe("created-token");
    expect(getSessionToken("1234")).toBeNull();
    expect(useSonGuessrStore.getState()).toMatchObject({
      roomId: "1234",
      sessionToken: "created-token",
    });
  });

  it("uses the canonical room id returned by the server", async () => {
    wsMock.send.mockResolvedValue({ roomId: "Oblivionis", sessionToken: "test-token" });

    await useSonGuessrStore.getState().joinRoom("oblivionis", "测试玩家");

    expect(getSonGuessrSessionToken("Oblivionis")).toBe("test-token");
    expect(useSonGuessrStore.getState()).toMatchObject({
      roomId: "Oblivionis",
      sessionToken: "test-token",
    });
  });

  it("clears the room session after an intentional leave", async () => {
    wsMock.send.mockResolvedValue({ left: true });
    saveSonGuessrSessionToken("2345", "leave-token");
    useSonGuessrStore.setState({
      roomId: "2345",
      sessionToken: "leave-token",
      snapshot,
      privateState,
      roomClosedAt: Date.now(),
    });

    await useSonGuessrStore.getState().leaveRoom();

    expect(wsMock.send).toHaveBeenCalledWith(
      "song.room.leave",
      {},
      { roomId: "2345", sessionToken: "leave-token" },
    );
    expect(getSonGuessrSessionToken("2345")).toBeNull();
    expect(useSonGuessrStore.getState()).toMatchObject({
      roomId: null,
      sessionToken: null,
      snapshot: null,
      privateState: null,
      roomClosedAt: null,
    });
  });

  it("clears only the Songuessr token after a stale reconnect", async () => {
    saveSonGuessrSessionToken("2345", "stale-song-token");
    saveSessionToken("2345", "live-faker-token");
    wsMock.send.mockRejectedValue({ code: "SESSION_NOT_FOUND" });

    await expect(useSonGuessrStore.getState().reconnectRoom("2345")).resolves.toBe(false);

    expect(getSonGuessrSessionToken("2345")).toBeNull();
    expect(getSessionToken("2345")).toBe("live-faker-token");
    expect(useSonGuessrStore.getState().roomClosedAt).not.toBeNull();
  });

  it("keeps the Songuessr session while reconnecting after a temporary disconnect", async () => {
    saveSonGuessrSessionToken("2346", "live-song-token");
    wsMock.send.mockRejectedValue({ code: "TIMEOUT" });

    await expect(useSonGuessrStore.getState().reconnectRoom("2346")).resolves.toBe(true);
    expect(getSonGuessrSessionToken("2346")).toBe("live-song-token");
    expect(useSonGuessrStore.getState()).toMatchObject({
      roomId: "2346",
      sessionToken: "live-song-token",
      roomClosedAt: null,
    });
  });

  it("subscribes to the lobby and restores the active room after reconnecting", async () => {
    wsMock.send.mockResolvedValue({});
    useSonGuessrStore.setState({ roomId: "3456", sessionToken: "live-token" });
    const dispose = initSonGuessrWs();

    wsMock.statusHandlers[0](true);
    await Promise.resolve();

    expect(useSonGuessrStore.getState().connected).toBe(true);
    expect(wsMock.send).toHaveBeenCalledWith("song.lobby.subscribeRooms");
    expect(wsMock.send).toHaveBeenCalledWith("song.room.reconnect", {
      roomId: "3456",
      sessionToken: "live-token",
    });
    dispose();
    expect(wsMock.messageHandlers).toHaveLength(0);
    expect(wsMock.statusHandlers).toHaveLength(0);
  });

  it("stores versioned public snapshots and private state from server events", () => {
    const dispose = initSonGuessrWs();

    wsMock.messageHandlers[0]({
      type: "event",
      event: "song.room.snapshot",
      payload: { mode: "full", revision: 1, state: snapshot },
    });
    wsMock.messageHandlers[0]({
      type: "event",
      event: "song.game.privateState",
      payload: { mode: "full", revision: 1, state: privateState },
    });

    expect(useSonGuessrStore.getState()).toMatchObject({ snapshot, privateState });
    expect(useSonGuessrStore.getState()).toMatchObject({
      roomId: "1234",
      sessionToken: "live-token",
    });
    expect(getSonGuessrSessionToken("1234")).toBe("live-token");
    dispose();
  });

  it("directly preserves server snapshots and lobby entries without fabrication", () => {
    const dispose = initSonGuessrWs();
    const serverSnapshot = {
      ...snapshot,
      phase: "playing",
      pendingSubmitterPlayerId: "player-1",
      currentRound: {
        roundNumber: 1,
        submitterPlayerId: "player-1",
        audioUrl: "https://audio.example/song.mp3",
        lyricClip: { startTime: 0, endTime: 1_000, lines: [] },
      },
      players: [
        {
          id: "player-1",
          name: "房主",
          score: 1,
          membership: "active",
          online: true,
          isReady: false,
          isBot: false,
          isHost: true,
          correctGuesses: 1,
          totalGuesses: 1,
          roundStatus: "playing",
          guessesUsed: 1,
        },
      ],
    } as unknown as SonGuessrRoomSnapshot;

    wsMock.messageHandlers[0]({
      type: "event",
      event: "song.lobby.rooms",
      payload: [{ ...snapshot, phase: "playing" }],
    });
    wsMock.messageHandlers[0]({
      type: "event",
      event: "song.room.snapshot",
      payload: { mode: "full", revision: 2, state: serverSnapshot },
    });

    expect(useSonGuessrStore.getState().rooms[0]?.phase).toBe("playing");
    expect(useSonGuessrStore.getState().snapshot).toMatchObject({
      phase: "playing",
      pendingSubmitterPlayerId: "player-1",
      currentRound: expect.objectContaining({ roundNumber: 1 }),
      players: [expect.objectContaining({ roundStatus: "playing", guessesUsed: 1 })],
    });
    dispose();
  });

  it.each([
    ["song.room.closed", "房间已关闭"],
    ["song.room.kicked", "你已被移出房间"],
    ["session.replaced", "当前席位已在另一个标签页接管"],
  ])("clears local authority when receiving %s", (event, notice) => {
    saveSonGuessrSessionToken("4567", "room-token");
    useSonGuessrStore.setState({
      roomId: "4567",
      sessionToken: "room-token",
      snapshot,
      privateState,
    });
    const dispose = initSonGuessrWs();

    wsMock.messageHandlers[0]({ type: "event", event, payload: { roomId: "4567" } });

    expect(getSonGuessrSessionToken("4567")).toBeNull();
    expect(useSonGuessrStore.getState()).toMatchObject({
      roomId: null,
      sessionToken: null,
      snapshot: null,
      privateState: null,
      notice: { text: notice, type: "error" },
    });
    expect(useSonGuessrStore.getState().roomClosedAt).not.toBeNull();
    dispose();
  });

  it("returns music search results through the authenticated command wrapper", async () => {
    const results = [{ id: "song-1", title: "晴天", artist: "周杰伦" }];
    wsMock.send.mockResolvedValue({ results });
    useSonGuessrStore.setState({ roomId: "5678", sessionToken: "search-token" });

    await expect(useSonGuessrStore.getState().searchMusic("晴天")).resolves.toEqual(results);
    expect(wsMock.send).toHaveBeenCalledWith(
      "song.music.search",
      { keyword: "晴天" },
      { roomId: "5678", sessionToken: "search-token" },
    );
  });

  it("resets state sync and cleans room state when leaveRoom is invoked", async () => {
    wsMock.send.mockResolvedValue({});
    useSonGuessrStore.setState({
      roomId: "1234",
      sessionToken: "token-1",
      snapshot,
      privateState,
    });

    await useSonGuessrStore.getState().leaveRoom();

    expect(useSonGuessrStore.getState().roomId).toBeNull();
    expect(useSonGuessrStore.getState().snapshot).toBeNull();
    expect(useSonGuessrStore.getState().sessionToken).toBeNull();
  });
});
