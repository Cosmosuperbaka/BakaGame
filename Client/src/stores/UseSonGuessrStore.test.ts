import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SERVER_SHUTDOWN_MESSAGE,
  type ServerMessage,
  type SonGuessrPrivateState,
  type SonGuessrRoomSnapshot,
} from "@/types";


const wsMock = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  messageHandlers: [] as Array<(message: ServerMessage) => void>,
  statusHandlers: [] as Array<(connected: boolean) => void>,
}));

vi.mock("@/lib/SonGuessrWs", () => ({
  sonGuessrWs: {
    send: wsMock.send,
    connect: wsMock.connect,
    disconnect: wsMock.disconnect,
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
  solo: false,
  visibility: "public",
  allowSpectators: true,
  hasPassword: false,
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

  it("preserves pushed snapshot and private state when createRoom resolves without payload states", async () => {
    const dispose = initSonGuessrWs();
    const liveSnapshot = { ...snapshot, roomId: "1234" };
    const livePrivate = { ...privateState, sessionToken: "created-token" };

    wsMock.send.mockImplementation(async (type) => {
      if (type === "song.room.create") {
        wsMock.messageHandlers[0]({
          type: "event",
          event: "song.room.snapshot",
          payload: { mode: "full", revision: 1, state: liveSnapshot },
        });
        wsMock.messageHandlers[0]({
          type: "event",
          event: "song.game.privateState",
          payload: { mode: "full", revision: 1, state: livePrivate },
        });
        return { roomId: "1234", sessionToken: "created-token" };
      }
      return {};
    });

    await useSonGuessrStore.getState().createRoom({
      roomId: "1234",
      name: "音乐房间",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
    });

    expect(useSonGuessrStore.getState().snapshot).toMatchObject({ roomId: "1234" });
    expect(useSonGuessrStore.getState().privateState).toMatchObject({ sessionToken: "created-token" });
    dispose();
  });

  it("adopts snapshot and privateState returned directly in RPC response", async () => {
    const rpcSnapshot = { ...snapshot, roomId: "5678" };
    const rpcPrivate = { ...privateState, sessionToken: "rpc-token" };
    wsMock.send.mockResolvedValue({
      roomId: "5678",
      sessionToken: "rpc-token",
      snapshot: rpcSnapshot,
      privateState: rpcPrivate,
    });

    await useSonGuessrStore.getState().createRoom({
      roomId: "5678",
      name: "新房间",
      visibility: "public",
      allowSpectators: true,
      userName: "玩家",
    });

    expect(useSonGuessrStore.getState().snapshot).toMatchObject({ roomId: "5678" });
    expect(useSonGuessrStore.getState().privateState).toMatchObject({ sessionToken: "rpc-token" });
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

  it("退房回包慢于下一次进房时，只清掉发起退房的会话", async () => {
    let ack!: () => void;
    wsMock.send.mockReturnValue(new Promise<void>((resolve) => { ack = resolve; }));
    saveSonGuessrSessionToken("2345", "old-token");
    useSonGuessrStore.setState({ roomId: "2345", sessionToken: "old-token", snapshot, privateState });

    const leaving = useSonGuessrStore.getState().leaveRoom();
    // 退房在房间页卸载后才发出，回包到达前玩家已经进了下一个房间。
    saveSonGuessrSessionToken("3456", "new-token");
    useSonGuessrStore.setState({ roomId: "3456", sessionToken: "new-token" });
    ack();
    await leaving;

    expect(useSonGuessrStore.getState()).toMatchObject({ roomId: "3456", sessionToken: "new-token", snapshot });
    expect(getSonGuessrSessionToken("3456")).toBe("new-token");
    expect(getSonGuessrSessionToken("2345")).toBeNull();
  });

  it("clears only the Songuessr token after a stale reconnect", async () => {
    saveSonGuessrSessionToken("2345", "stale-song-token");
    saveSessionToken("2345", "live-faker-token");
    wsMock.send.mockRejectedValue({ code: "SESSION_NOT_FOUND" });

    await expect(useSonGuessrStore.getState().reconnectRoom("2345")).resolves.toBe(false);

    expect(getSonGuessrSessionToken("2345")).toBeNull();
    expect(getSessionToken("2345")).toBe("live-faker-token");
    expect(useSonGuessrStore.getState().roomClosedAt).toBeNull();
    expect(useSonGuessrStore.getState().notice).toEqual({ text: "会话已失效，请重新加入", type: "error" });
  });


  it("临时重连失败保留猜歌凭据但拒绝调用方，不伪装成功", async () => {
    saveSonGuessrSessionToken("2346", "live-song-token");
    wsMock.send.mockRejectedValue({ code: "TIMEOUT" });

    await expect(useSonGuessrStore.getState().reconnectRoom("2346")).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(getSonGuessrSessionToken("2346")).toBe("live-song-token");
    expect(useSonGuessrStore.getState()).toMatchObject({
      roomId: null,
      sessionToken: null,
      roomClosedAt: null,
    });
  });

  it("subscribes to the lobby and restores the active room after reconnecting", async () => {
    wsMock.send.mockResolvedValue({ roomId: "3456", sessionToken: "live-token" });
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
    ["server.shutdown", SERVER_SHUTDOWN_MESSAGE],
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

  it("returns Bangumi search results through the authenticated command wrapper", async () => {
    const results = [{ id: "subject-1", name: "Test Anime", nameCn: "测试番剧", tags: [], metaTags: [] }];
    wsMock.send.mockResolvedValue({ results });
    useSonGuessrStore.setState({ roomId: "5678", sessionToken: "search-token" });

    await expect(useSonGuessrStore.getState().searchBangumi("测试番剧")).resolves.toEqual(results);
    expect(wsMock.send).toHaveBeenCalledWith(
      "song.bangumi.search",
      { keyword: "测试番剧" },
      { roomId: "5678", sessionToken: "search-token" },
    );
  });

  const chatRange = (start: number, count: number): SonGuessrRoomSnapshot["chat"] =>
    Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      return { id: `message-${index}`, playerId: "player-1", playerName: "房主", text: `聊天${index}`, createdAt: index, system: false };
    });

  it("初始全量聊天仅保留最新200条，但不破坏原始补丁基线", () => {
    const dispose = initSonGuessrWs();
    const initialChat = chatRange(0, 280);
    try {
      wsMock.messageHandlers[0]({ type: "event", event: "song.room.snapshot", payload: { mode: "full", revision: 1, state: { ...snapshot, chat: initialChat } } });
      expect(useSonGuessrStore.getState().snapshot?.chat).toEqual(chatRange(80, 200));
      expect(initialChat).toHaveLength(280);
      // 服务端补丁索引属于未裁剪的协议基线；仅裁剪展示快照，不能移动基线索引。
      wsMock.messageHandlers[0]({ type: "event", event: "song.room.snapshot", payload: { mode: "patch", baseRevision: 1, revision: 2, operations: [{ op: "add", path: "/chat/280", value: chatRange(280, 1)[0] }] } });
      expect(useSonGuessrStore.getState().snapshot?.chat).toEqual(chatRange(81, 200));
      expect(wsMock.send.mock.calls.some(([command]) => command === "song.room.requestSync")).toBe(false);
    } finally { dispose(); }
  });

  it("RPC初始房间快照也去重排序并裁剪至最新200条", async () => {
    const payloadChat = [...chatRange(0, 280).reverse(), ...chatRange(270, 10)];
    wsMock.send.mockResolvedValue({ sessionToken: "chat-token", snapshot: { ...snapshot, chat: payloadChat } });
    await useSonGuessrStore.getState().createRoom({ roomId: "1234", name: "音乐房间", visibility: "public", allowSpectators: true, userName: "房主" });
    expect(useSonGuessrStore.getState().snapshot?.chat).toEqual(chatRange(80, 200));
    expect(payloadChat).toHaveLength(290);
  });

  it("聊天增量与多次全量重连交替后不超过200条且保留最新消息", async () => {
    const dispose = initSonGuessrWs();
    wsMock.send.mockResolvedValue({ sessionToken: "chat-token" });
    useSonGuessrStore.setState({ roomId: "1234", sessionToken: "chat-token" });
    try {
      const emit = wsMock.messageHandlers[0];
      emit({ type: "event", event: "song.room.snapshot", payload: { mode: "full", revision: 1, state: { ...snapshot, chat: chatRange(0, 200) } } });
      for (let cycle = 0; cycle < 8; cycle++) {
        const start = 200 + cycle * 75;
        for (const message of chatRange(start, 75)) {
          emit({ type: "event", event: "song.chat.message", payload: { message } });
          expect(useSonGuessrStore.getState().snapshot?.chat).toHaveLength(200);
        }
        wsMock.statusHandlers[0](false);
        wsMock.statusHandlers[0](true);
        await vi.advanceTimersByTimeAsync(0);
        const latest = start + 75;
        // 重连全量与本地增量重叠；重复/乱序全量不能积累历史或丢弃本地更新。
        emit({ type: "event", event: "song.room.snapshot", payload: { mode: "full", revision: cycle + 2, state: { ...snapshot, chat: chatRange(latest - 200, 200).reverse() } } });
        emit({ type: "event", event: "song.chat.message", payload: { message: chatRange(latest - 1, 1)[0] } });
        expect(useSonGuessrStore.getState().snapshot?.chat).toEqual(chatRange(latest - 200, 200));
      }
      expect(wsMock.send.mock.calls.filter(([command]) => command === "song.room.reconnect")).toHaveLength(8);
      expect(useSonGuessrStore.getState().snapshot?.chat).toEqual(chatRange(600, 200));
    } finally { dispose(); }
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

it("玩法清理关闭连接、释放订阅并保留刷新凭据，可重新初始化", () => {
  saveSonGuessrSessionToken("1234", "recoverable");
  useSonGuessrStore.setState({connected:true,lobbyReady:true});
  const cleanup=initSonGuessrWs();cleanup();
  expect(wsMock.disconnect).toHaveBeenCalledOnce();
  expect(wsMock.messageHandlers).toHaveLength(0);
  expect(wsMock.statusHandlers).toHaveLength(0);
  expect(useSonGuessrStore.getState()).toMatchObject({connected:false,lobbyReady:false});
  expect(getSonGuessrSessionToken("1234")).toBe("recoverable");
  const next=initSonGuessrWs();expect(wsMock.messageHandlers).toHaveLength(1);next();
});
