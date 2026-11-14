import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SERVER_SHUTDOWN_MESSAGE } from "@bakagame/shared/values";
import type { ServerMessage, SonGuessrPrivateState, SonGuessrRoomSnapshot } from "@bakagame/shared";

const wsMock = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  messageHandlers: [] as Array<(message: ServerMessage) => void>,
  statusHandlers: [] as Array<(connected: boolean) => void>,
}));

vi.mock("@/lib/SonGuessrWs", () => ({
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
}));

import {
  getSessionToken,
  getSonGuessrSessionToken,
  saveSessionToken,
  saveSonGuessrSessionToken,
} from "@/lib/Storage";
import { getStoredSongMusicSession, saveSongMusicSession } from "@/lib/SonGuessrMusicSession";
import { clearSonGuessrQueryCache, initSonGuessrWs, useSonGuessrStore } from "./UseSonGuessrStore";

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
  teamObserver: false,
  submitterCandidateIds: [],
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
    // 查询复用窗口是模块级状态，用例之间必须隔离，否则第二个用例会直接命中上一个的结果。
    clearSonGuessrQueryCache();
    useSonGuessrStore.setState(initialState, true);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("persists created room sessions in the Songuessr namespace", async () => {
    wsMock.send.mockResolvedValue({
      roomId: "1234",
      playerId: "player-1",
      sessionToken: "created-token",
    });

    await useSonGuessrStore.getState().createRoom({
      roomId: "1234",
      name: "音乐房间",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
    });

    expect(wsMock.send).toHaveBeenCalledWith(
      "song.room.create",
      expect.objectContaining({ roomId: "1234", userName: "房主" })
    );
    expect(getSonGuessrSessionToken("1234")).toBe("created-token");
    expect(getSessionToken("1234")).toBeNull();
    expect(useSonGuessrStore.getState()).toMatchObject({
      roomId: "1234",
      sessionToken: "created-token",
    });
  });

  it("server-pushed refreshed music session updates the local copy", () => {
    window.localStorage.clear();
    const dispose = initSonGuessrWs();
    saveSongMusicSession(
      {
        cookie: "qm_keyst=old",
        account: { platform: "qq", nickname: "QQ用户", vipStatus: "nonVip" },
      },
      true,
      "qq"
    );

    wsMock.messageHandlers[0]({
      type: "event",
      event: "song.auth.session",
      payload: {
        platform: "qq",
        cookie: "qm_keyst=new",
        account: { platform: "qq", nickname: "QQ用户", vipStatus: "nonVip" },
      },
    });

    expect(getStoredSongMusicSession("qq")?.cookie).toBe("qm_keyst=new");
    dispose();
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
    expect(useSonGuessrStore.getState().privateState).toMatchObject({
      sessionToken: "created-token",
    });
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
      { roomId: "2345", sessionToken: "leave-token" }
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
    wsMock.send.mockReturnValue(
      new Promise<void>((resolve) => {
        ack = resolve;
      })
    );
    saveSonGuessrSessionToken("2345", "old-token");
    useSonGuessrStore.setState({
      roomId: "2345",
      sessionToken: "old-token",
      snapshot,
      privateState,
    });

    const leaving = useSonGuessrStore.getState().leaveRoom();
    // 退房在房间页卸载后才发出，回包到达前玩家已经进了下一个房间。
    saveSonGuessrSessionToken("3456", "new-token");
    useSonGuessrStore.setState({ roomId: "3456", sessionToken: "new-token" });
    ack();
    await leaving;

    expect(useSonGuessrStore.getState()).toMatchObject({
      roomId: "3456",
      sessionToken: "new-token",
      snapshot,
    });
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
    expect(useSonGuessrStore.getState().toasts).toEqual([
      {
        id: expect.any(Number),
        text: "原座位已失效，可能掉线过久或房间已重建",
        type: "error",
      },
    ]);
  });

  it("刷新时房间已不在：标记关闭让页面退回大厅，不留给页面按房号重建", async () => {
    saveSonGuessrSessionToken("2346", "orphan-song-token");
    wsMock.send.mockRejectedValue({ code: "ROOM_NOT_FOUND" });

    await expect(useSonGuessrStore.getState().reconnectRoom("2346")).resolves.toBe(false);
    expect(getSonGuessrSessionToken("2346")).toBeNull();
    expect(useSonGuessrStore.getState().roomClosedAt).not.toBeNull();
  });

  it("临时重连失败保留猜歌凭据但拒绝调用方，不伪装成功", async () => {
    saveSonGuessrSessionToken("2346", "live-song-token");
    wsMock.send.mockRejectedValue({ code: "TIMEOUT" });

    await expect(useSonGuessrStore.getState().reconnectRoom("2346")).rejects.toMatchObject({
      code: "TIMEOUT",
    });
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
    expect(wsMock.send).toHaveBeenCalledWith("song.lobby.subscribeRooms", {});
    expect(wsMock.send).toHaveBeenCalledWith("song.room.reconnect", {
      roomId: "3456",
      sessionToken: "live-token",
    });
    dispose();
    expect(wsMock.messageHandlers).toHaveLength(0);
    expect(wsMock.statusHandlers).toHaveLength(0);
  });

  it("重复初始化不叠加第二路消息与状态订阅", () => {
    const dispose = initSonGuessrWs();
    const again = initSonGuessrWs();
    expect(wsMock.messageHandlers).toHaveLength(1);
    expect(wsMock.statusHandlers).toHaveLength(1);
    expect(wsMock.connect).toHaveBeenCalledOnce();
    again();
    dispose();
  });

  it("断线只收回大厅就绪标记，房间展示态与凭据留在原地", () => {
    saveSonGuessrSessionToken("1234", "live-token");
    useSonGuessrStore.setState({
      roomId: "1234",
      sessionToken: "live-token",
      snapshot,
      privateState,
      lobbyReady: true,
    });
    const dispose = initSonGuessrWs();

    wsMock.statusHandlers[0](false);

    // 掉线不等于退房：房间页继续显示最后一屏等重连，大厅列表则要重新订阅后才算就绪。
    expect(useSonGuessrStore.getState()).toMatchObject({
      connected: false,
      lobbyReady: false,
      roomId: "1234",
      sessionToken: "live-token",
      roomClosedAt: null,
    });
    expect(useSonGuessrStore.getState().snapshot).toMatchObject({ roomId: "1234" });
    expect(getSonGuessrSessionToken("1234")).toBe("live-token");
    dispose();
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
    ["song.session.replaced", "当前席位已在另一个标签页接管"],
  ])("clears local authority when receiving %s", (event, toast) => {
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
      toasts: [{ text: toast, type: "error" }],
    });
    expect(useSonGuessrStore.getState().roomClosedAt).not.toBeNull();
    dispose();
  });

  it("停机时原地待命：保留票据与房间态，只提示等待重连", () => {
    saveSonGuessrSessionToken("4567", "room-token");
    useSonGuessrStore.setState({
      roomId: "4567",
      sessionToken: "room-token",
      snapshot,
      privateState,
    });
    const dispose = initSonGuessrWs();
    try {
      wsMock.messageHandlers[0]({ type: "event", event: "server.shutdown", payload: {} });

      // 服务端会把房间落盘，重连后凭原票据回原位：票据与房间态都不该被清掉。
      expect(getSonGuessrSessionToken("4567")).toBe("room-token");
      expect(useSonGuessrStore.getState()).toMatchObject({
        roomId: "4567",
        sessionToken: "room-token",
        toasts: [{ text: SERVER_SHUTDOWN_MESSAGE, type: "error" }],
      });
      expect(useSonGuessrStore.getState().roomClosedAt).toBeNull();
    } finally {
      dispose();
    }
  });

  it("停机提示停留十秒，不按默认时长提前消失", () => {
    const dispose = initSonGuessrWs();
    wsMock.messageHandlers[0]({ type: "event", event: "server.shutdown", payload: {} });

    vi.advanceTimersByTime(9999);
    expect(useSonGuessrStore.getState().toasts.map((toast) => toast.text)).toEqual([
      SERVER_SHUTDOWN_MESSAGE,
    ]);
    vi.advanceTimersByTime(1);
    expect(useSonGuessrStore.getState().toasts).toEqual([]);
    dispose();
  });

  it("结束事件的提示是错误，按错误的五秒消失", () => {
    useSonGuessrStore.setState({ roomId: "4567", sessionToken: "room-token" });
    const dispose = initSonGuessrWs();
    wsMock.messageHandlers[0]({
      type: "event",
      event: "song.room.closed",
      payload: { roomId: "4567" },
    });

    vi.advanceTimersByTime(4999);
    expect(useSonGuessrStore.getState().toasts.map((toast) => toast.text)).toEqual(["房间已关闭"]);
    vi.advanceTimersByTime(1);
    expect(useSonGuessrStore.getState().toasts).toEqual([]);
    dispose();
  });

  it("停机作废在途入房，晚到 ACK 只释放席位不安装身份", async () => {
    let resolveAck!: (value: unknown) => void;
    wsMock.send.mockImplementation((type: string) =>
      type === "song.room.join"
        ? new Promise((resolve) => {
            resolveAck = resolve;
          })
        : Promise.resolve({})
    );
    const dispose = initSonGuessrWs();
    const joined = useSonGuessrStore
      .getState()
      .joinRoom("1234", "玩家")
      .catch((error) => error);

    wsMock.messageHandlers[0]({ type: "event", event: "server.shutdown", payload: {} });
    resolveAck({ roomId: "1234", sessionToken: "late-token" });

    // 停机后这条连接上的入房已经作废：晚到的 ACK 只用来退掉服务端席位，不写本地身份与票据。
    expect(await joined).toMatchObject({ name: "AbortError" });
    expect(wsMock.send.mock.calls.map(([type]) => type)).toEqual([
      "song.room.join",
      "song.room.leave",
    ]);
    expect(wsMock.send.mock.calls[1][2]).toEqual({ roomId: "1234", sessionToken: "late-token" });
    expect(getSonGuessrSessionToken("1234")).toBeNull();
    expect(useSonGuessrStore.getState()).toMatchObject({ roomId: null, sessionToken: null });
    dispose();
  });

  it("断线作废在途入房：晚到 ACK 不安装身份，也不向新连接发旧离房", async () => {
    let resolveAck!: (value: unknown) => void;
    wsMock.send.mockImplementation((type: string) =>
      type === "song.room.join"
        ? new Promise((resolve) => {
            resolveAck = resolve;
          })
        : Promise.resolve({})
    );
    const dispose = initSonGuessrWs();
    try {
      const joined = useSonGuessrStore
        .getState()
        .joinRoom("1234", "玩家")
        .catch((error) => error);

      wsMock.statusHandlers[0](false);
      resolveAck({ roomId: "1234", sessionToken: "late-token" });

      // 席位随旧连接消失：既不写本地身份，也不往新连接发旧凭据的退房。
      expect(await joined).toMatchObject({ name: "AbortError" });
      expect(wsMock.send.mock.calls.map(([type]) => type)).toEqual(["song.room.join"]);
      expect(getSonGuessrSessionToken("1234")).toBeNull();
      expect(useSonGuessrStore.getState()).toMatchObject({ roomId: null, sessionToken: null });
    } finally {
      dispose();
    }
  });

  it("returns music search results through the authenticated command wrapper", async () => {
    const results = [{ id: "song-1", title: "晴天", artist: "周杰伦" }];
    wsMock.send.mockResolvedValue({ results });
    useSonGuessrStore.setState({ roomId: "5678", sessionToken: "search-token" });

    await expect(useSonGuessrStore.getState().searchMusic("晴天")).resolves.toEqual(results);
    expect(wsMock.send).toHaveBeenCalledWith(
      "song.music.search",
      { keyword: "晴天" },
      { roomId: "5678", sessionToken: "search-token" }
    );
  });

  it("五个只读查询都经 sendCommand 注入房间身份，信封只有一处来源", async () => {
    useSonGuessrStore.setState({ roomId: "5678", sessionToken: "search-token" });
    wsMock.send.mockResolvedValue({
      results: [],
      playlist: { id: "123", name: "我喜欢", songCount: 0 },
    });
    const sendCommand = vi.spyOn(useSonGuessrStore.getState(), "sendCommand");

    await useSonGuessrStore.getState().searchMusic("晴天");
    await useSonGuessrStore.getState().searchBangumi("测试番剧");
    await useSonGuessrStore.getState().resolveAnimeSongs("subject-1");
    await useSonGuessrStore.getState().searchArtist("周杰伦");
    await useSonGuessrStore.getState().resolvePlaylist("https://music.example.com/playlist?id=123");

    expect(sendCommand.mock.calls.map(([type]) => type)).toEqual([
      "song.music.search",
      "song.bangumi.search",
      "song.bangumi.songs",
      "song.music.artist.search",
      "song.music.playlist.resolve",
    ]);
    expect(wsMock.send).toHaveBeenCalledTimes(5);
    for (const call of wsMock.send.mock.calls) {
      expect(call[2]).toMatchObject({ roomId: "5678", sessionToken: "search-token" });
    }
  });

  it("相同关键词在复用窗口内只发一次上游命令", async () => {
    const results = [{ id: "song-1", title: "晴天", artist: "周杰伦" }];
    wsMock.send.mockResolvedValue({ results });
    useSonGuessrStore.setState({ roomId: "5678", sessionToken: "search-token" });

    await expect(useSonGuessrStore.getState().searchMusic("晴天")).resolves.toEqual(results);
    // 猜歌时「换个写法再搜一遍」很常见：归一化后必须命中同一份结果，不再二次往返。
    await expect(useSonGuessrStore.getState().searchMusic("  晴天 ")).resolves.toEqual(results);

    expect(wsMock.send).toHaveBeenCalledTimes(1);
  });

  it("同键并发只发一次请求，不同关键词各自回源", async () => {
    wsMock.send.mockResolvedValue({ results: [] });
    useSonGuessrStore.setState({ roomId: "5678", sessionToken: "search-token" });

    await Promise.all([
      useSonGuessrStore.getState().searchMusic("甲"),
      useSonGuessrStore.getState().searchMusic("甲"),
    ]);
    expect(wsMock.send).toHaveBeenCalledTimes(1);

    await useSonGuessrStore.getState().searchMusic("乙");
    expect(wsMock.send).toHaveBeenCalledTimes(2);
  });

  it("搜索失败不进入复用缓存，下一次调用仍会回源", async () => {
    wsMock.send.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ results: [] });
    useSonGuessrStore.setState({ roomId: "5678", sessionToken: "search-token" });

    await expect(useSonGuessrStore.getState().searchMusic("丙")).rejects.toThrow("boom");
    await expect(useSonGuessrStore.getState().searchMusic("丙")).resolves.toEqual([]);
    expect(wsMock.send).toHaveBeenCalledTimes(2);
  });

  it("歌手搜索与歌单解析同样复用结果，不重复请求上游", async () => {
    useSonGuessrStore.setState({ roomId: "5678", sessionToken: "search-token" });

    wsMock.send.mockResolvedValue({ results: [{ id: "artist-1", name: "周杰伦" }] });
    await useSonGuessrStore.getState().searchArtist("周杰伦");
    await useSonGuessrStore.getState().searchArtist(" 周杰伦 ");
    expect(wsMock.send).toHaveBeenCalledTimes(1);

    wsMock.send.mockResolvedValue({ playlist: { id: "123", name: "我喜欢", songCount: 2 } });
    await useSonGuessrStore.getState().resolvePlaylist("https://music.163.com/playlist?id=123");
    await useSonGuessrStore.getState().resolvePlaylist("  https://music.163.com/playlist?id=123  ");
    expect(wsMock.send).toHaveBeenCalledTimes(2);
  });

  it("番剧搜索在复用窗口内只发一次请求", async () => {
    useSonGuessrStore.setState({ roomId: "5678", sessionToken: "search-token" });
    wsMock.send.mockResolvedValue({ results: [{ id: "subject-1", name: "Test Anime" }] });

    await useSonGuessrStore.getState().searchBangumi("测试番剧");
    await useSonGuessrStore.getState().searchBangumi("测试番剧");

    expect(wsMock.send).toHaveBeenCalledTimes(1);
    expect(wsMock.send).toHaveBeenCalledWith(
      "song.bangumi.search",
      { keyword: "测试番剧" },
      { roomId: "5678", sessionToken: "search-token" }
    );
  });

  it("returns Bangumi search results through the authenticated command wrapper", async () => {
    const results = [
      { id: "subject-1", name: "Test Anime", nameCn: "测试番剧", tags: [], metaTags: [] },
    ];
    wsMock.send.mockResolvedValue({ results });
    useSonGuessrStore.setState({ roomId: "5678", sessionToken: "search-token" });

    await expect(useSonGuessrStore.getState().searchBangumi("测试番剧")).resolves.toEqual(results);
    expect(wsMock.send).toHaveBeenCalledWith(
      "song.bangumi.search",
      { keyword: "测试番剧" },
      { roomId: "5678", sessionToken: "search-token" }
    );
  });

  const chatRange = (start: number, count: number): SonGuessrRoomSnapshot["chat"] =>
    Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      return {
        id: `message-${index}`,
        playerId: "player-1",
        playerName: "房主",
        text: `聊天${index}`,
        createdAt: index,
        system: false,
      };
    });

  it("初始全量聊天仅保留最新200条，但不破坏原始补丁基线", () => {
    const dispose = initSonGuessrWs();
    const initialChat = chatRange(0, 280);
    try {
      wsMock.messageHandlers[0]({
        type: "event",
        event: "song.room.snapshot",
        payload: { mode: "full", revision: 1, state: { ...snapshot, chat: initialChat } },
      });
      expect(useSonGuessrStore.getState().snapshot?.chat).toEqual(chatRange(80, 200));
      expect(initialChat).toHaveLength(280);
      // 服务端补丁索引属于未裁剪的协议基线；仅裁剪展示快照，不能移动基线索引。
      wsMock.messageHandlers[0]({
        type: "event",
        event: "song.room.snapshot",
        payload: {
          mode: "patch",
          baseRevision: 1,
          revision: 2,
          operations: [{ op: "add", path: "/chat/280", value: chatRange(280, 1)[0] }],
        },
      });
      expect(useSonGuessrStore.getState().snapshot?.chat).toEqual(chatRange(81, 200));
      expect(wsMock.send.mock.calls.some(([command]) => command === "song.room.requestSync")).toBe(
        false
      );
    } finally {
      dispose();
    }
  });

  it("RPC初始房间快照也去重排序并裁剪至最新200条", async () => {
    const payloadChat = [...chatRange(0, 280).reverse(), ...chatRange(270, 10)];
    wsMock.send.mockResolvedValue({
      roomId: "1234",
      playerId: "player-1",
      sessionToken: "chat-token",
      snapshot: { ...snapshot, chat: payloadChat },
    });
    await useSonGuessrStore.getState().createRoom({
      roomId: "1234",
      name: "音乐房间",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
    });
    expect(useSonGuessrStore.getState().snapshot?.chat).toEqual(chatRange(80, 200));
    expect(payloadChat).toHaveLength(290);
  });

  it("聊天增量与多次全量重连交替后不超过200条且保留最新消息", async () => {
    const dispose = initSonGuessrWs();
    wsMock.send.mockResolvedValue({ sessionToken: "chat-token" });
    useSonGuessrStore.setState({ roomId: "1234", sessionToken: "chat-token" });
    try {
      const emit = wsMock.messageHandlers[0];
      emit({
        type: "event",
        event: "song.room.snapshot",
        payload: { mode: "full", revision: 1, state: { ...snapshot, chat: chatRange(0, 200) } },
      });
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
        emit({
          type: "event",
          event: "song.room.snapshot",
          payload: {
            mode: "full",
            revision: cycle + 2,
            state: { ...snapshot, chat: chatRange(latest - 200, 200).reverse() },
          },
        });
        emit({
          type: "event",
          event: "song.chat.message",
          payload: { message: chatRange(latest - 1, 1)[0] },
        });
        expect(useSonGuessrStore.getState().snapshot?.chat).toEqual(chatRange(latest - 200, 200));
      }
      expect(
        wsMock.send.mock.calls.filter(([command]) => command === "song.room.reconnect")
      ).toHaveLength(8);
      expect(useSonGuessrStore.getState().snapshot?.chat).toEqual(chatRange(600, 200));
    } finally {
      dispose();
    }
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

  it("主动退房清掉还挂着的提示", async () => {
    wsMock.send.mockResolvedValue({});
    useSonGuessrStore.setState({
      roomId: "1234",
      sessionToken: "token-1",
      snapshot,
      privateState,
    });
    useSonGuessrStore.getState().showToast("还没消失的提示");

    await useSonGuessrStore.getState().leaveRoom();

    expect(useSonGuessrStore.getState().toasts).toEqual([]);
  });
});

describe("状态同步", () => {
  let dispose: (() => void) | undefined;
  const emitMessage = (message: ServerMessage) =>
    wsMock.messageHandlers.forEach((handler) => handler(message));
  const emitStatus = (connected: boolean) =>
    wsMock.statusHandlers.forEach((handler) => handler(connected));
  const requestSyncCalls = () =>
    wsMock.send.mock.calls.filter(([type]) => type === "song.room.requestSync");

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
    dispose?.();
    dispose = undefined;
    useSonGuessrStore.getState().resetRoomState();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("修订号连续的快照与私有态补丁逐条应用，不请求全量", () => {
    wsMock.send.mockResolvedValue({});
    dispose = initSonGuessrWs();
    emitMessage({
      type: "event",
      event: "song.room.snapshot",
      payload: { mode: "full", revision: 1, state: snapshot },
    });
    emitMessage({
      type: "event",
      event: "song.room.snapshot",
      payload: {
        mode: "patch",
        baseRevision: 1,
        revision: 2,
        operations: [{ op: "replace", path: "/name", value: "第二夜" }],
      },
    });
    expect(useSonGuessrStore.getState().snapshot?.name).toBe("第二夜");
    emitMessage({
      type: "event",
      event: "song.room.snapshot",
      payload: {
        mode: "patch",
        baseRevision: 2,
        revision: 3,
        operations: [{ op: "replace", path: "/roundNumber", value: 1 }],
      },
    });
    expect(useSonGuessrStore.getState().snapshot?.roundNumber).toBe(1);

    emitMessage({
      type: "event",
      event: "song.game.privateState",
      payload: { mode: "full", revision: 1, state: privateState },
    });
    emitMessage({
      type: "event",
      event: "song.game.privateState",
      payload: {
        mode: "patch",
        baseRevision: 1,
        revision: 2,
        operations: [{ op: "replace", path: "/remainingGuesses", value: 4 }],
      },
    });
    expect(useSonGuessrStore.getState().privateState?.remainingGuesses).toBe(4);
    expect(requestSyncCalls()).toHaveLength(0);
  });

  it("补丁跳号时请求全量，缺口补丁不落在旧基线上", async () => {
    wsMock.send.mockResolvedValue({});
    dispose = initSonGuessrWs();
    emitMessage({
      type: "event",
      event: "song.room.snapshot",
      payload: { mode: "full", revision: 1, state: snapshot },
    });
    emitMessage({
      type: "event",
      event: "song.room.snapshot",
      payload: {
        mode: "patch",
        baseRevision: 2,
        revision: 3,
        operations: [{ op: "replace", path: "/name", value: "错位" }],
      },
    });
    expect(requestSyncCalls()).toHaveLength(1);
    expect(wsMock.send).toHaveBeenCalledWith("song.room.requestSync", {}, expect.anything());
    expect(useSonGuessrStore.getState().snapshot?.name).toBe("音乐房间");

    // 私有态通道同一口径：跳号即全量，展示态保持旧值。
    await vi.advanceTimersByTimeAsync(0);
    emitMessage({
      type: "event",
      event: "song.game.privateState",
      payload: { mode: "full", revision: 1, state: privateState },
    });
    emitMessage({
      type: "event",
      event: "song.game.privateState",
      payload: {
        mode: "patch",
        baseRevision: 2,
        revision: 3,
        operations: [{ op: "replace", path: "/playerId", value: "tampered" }],
      },
    });
    expect(requestSyncCalls()).toHaveLength(2);
    expect(useSonGuessrStore.getState().privateState?.playerId).toBe("player-1");
  });

  it("全量请求在途时，两条通道的后续缺口不重复发", async () => {
    let resolveSync!: (value: unknown) => void;
    wsMock.send.mockImplementation((type: string) =>
      type === "song.room.requestSync"
        ? new Promise((resolve) => {
            resolveSync = resolve;
          })
        : Promise.resolve({})
    );
    dispose = initSonGuessrWs();
    emitMessage({
      type: "event",
      event: "song.room.snapshot",
      payload: { mode: "full", revision: 1, state: snapshot },
    });
    const gap = (revision: number) => ({
      type: "event" as const,
      event: "song.room.snapshot",
      payload: {
        mode: "patch" as const,
        baseRevision: 2,
        revision,
        operations: [{ op: "replace" as const, path: "/name", value: "错位" }],
      },
    });
    emitMessage(gap(3));
    // 私有态还没有基线，补丁同样构成缺口；两条通道共用一个在途标记。
    emitMessage({
      type: "event",
      event: "song.game.privateState",
      payload: {
        mode: "patch",
        baseRevision: 0,
        revision: 1,
        operations: [{ op: "replace", path: "/playerId", value: "tampered" }],
      },
    });
    emitMessage(gap(4));
    expect(requestSyncCalls()).toHaveLength(1);
    expect(useSonGuessrStore.getState().snapshot?.name).toBe("音乐房间");

    resolveSync({});
    await vi.advanceTimersByTimeAsync(0);
    emitMessage(gap(5));
    expect(requestSyncCalls()).toHaveLength(2);
  });

  it("入房在途时推送只更新基线，无状态 ACK 后一次安装且修订号延续", async () => {
    let resolveAck!: (value: unknown) => void;
    wsMock.send.mockImplementation((type: string) =>
      type === "song.room.join"
        ? new Promise((resolve) => {
            resolveAck = resolve;
          })
        : Promise.resolve({})
    );
    dispose = initSonGuessrWs();
    const joined = useSonGuessrStore.getState().joinRoom("1234", "玩家");
    emitMessage({
      type: "event",
      event: "song.room.snapshot",
      payload: { mode: "full", revision: 1, state: snapshot },
    });
    emitMessage({
      type: "event",
      event: "song.room.snapshot",
      payload: {
        mode: "patch",
        baseRevision: 1,
        revision: 2,
        operations: [{ op: "replace", path: "/name", value: "暂存名" }],
      },
    });
    emitMessage({
      type: "event",
      event: "song.game.privateState",
      payload: {
        mode: "full",
        revision: 1,
        state: { ...privateState, sessionToken: "entry-token" },
      },
    });
    // 连续补丁被基线正常消费：没有触发全量请求，但展示态与身份都还没安装。
    expect(requestSyncCalls()).toHaveLength(0);
    expect(useSonGuessrStore.getState()).toMatchObject({
      roomId: null,
      sessionToken: null,
      snapshot: null,
      privateState: null,
    });

    resolveAck({ roomId: "1234", sessionToken: "entry-token" });
    await joined;
    expect(useSonGuessrStore.getState()).toMatchObject({
      roomId: "1234",
      sessionToken: "entry-token",
    });
    expect(useSonGuessrStore.getState().snapshot?.name).toBe("暂存名");
    expect(useSonGuessrStore.getState().privateState?.sessionToken).toBe("entry-token");
    // 不带首屏载荷的 ACK 不作废已暂存的修订号：后续连续补丁直接应用。
    emitMessage({
      type: "event",
      event: "song.room.snapshot",
      payload: {
        mode: "patch",
        baseRevision: 2,
        revision: 3,
        operations: [{ op: "replace", path: "/roundNumber", value: 1 }],
      },
    });
    expect(useSonGuessrStore.getState().snapshot?.roundNumber).toBe(1);
    expect(requestSyncCalls()).toHaveLength(0);
  });

  it("重连只作废修订号：旧基线补丁改走全量，新全量后继续连续应用", async () => {
    wsMock.send.mockImplementation((type: string) =>
      type === "song.room.reconnect"
        ? Promise.resolve({ roomId: "1234", sessionToken: "live-token" })
        : Promise.resolve({})
    );
    dispose = initSonGuessrWs();
    emitMessage({
      type: "event",
      event: "song.room.snapshot",
      payload: { mode: "full", revision: 1, state: snapshot },
    });
    emitMessage({
      type: "event",
      event: "song.game.privateState",
      payload: { mode: "full", revision: 1, state: privateState },
    });
    emitStatus(false);
    emitStatus(true);
    await vi.advanceTimersByTimeAsync(0);

    // 旧连接上的版本号对新连接没有意义：baseRevision 1 的补丁不再被接受。
    emitMessage({
      type: "event",
      event: "song.room.snapshot",
      payload: {
        mode: "patch",
        baseRevision: 1,
        revision: 2,
        operations: [{ op: "replace", path: "/name", value: "错位" }],
      },
    });
    expect(requestSyncCalls()).toHaveLength(1);
    expect(useSonGuessrStore.getState().snapshot?.name).toBe("音乐房间");

    emitMessage({
      type: "event",
      event: "song.room.snapshot",
      payload: { mode: "full", revision: 2, state: { ...snapshot, name: "恢复" } },
    });
    emitMessage({
      type: "event",
      event: "song.room.snapshot",
      payload: {
        mode: "patch",
        baseRevision: 2,
        revision: 3,
        operations: [{ op: "replace", path: "/roundNumber", value: 1 }],
      },
    });
    expect(useSonGuessrStore.getState().snapshot?.name).toBe("恢复");
    expect(useSonGuessrStore.getState().snapshot?.roundNumber).toBe(1);
    expect(requestSyncCalls()).toHaveLength(1);
  });

  it("没有房间可恢复时断线重连，修订号同样作废", () => {
    wsMock.send.mockResolvedValue({});
    dispose = initSonGuessrWs();
    // 只有快照、没有带凭据的私有态：本机还没有房间身份，重连后不会走恢复入房那条重置。
    emitMessage({
      type: "event",
      event: "song.room.snapshot",
      payload: { mode: "full", revision: 1, state: snapshot },
    });
    emitStatus(false);
    emitStatus(true);

    emitMessage({
      type: "event",
      event: "song.room.snapshot",
      payload: {
        mode: "patch",
        baseRevision: 1,
        revision: 2,
        operations: [{ op: "replace", path: "/name", value: "错位" }],
      },
    });
    expect(requestSyncCalls()).toHaveLength(1);
    expect(useSonGuessrStore.getState().snapshot?.name).toBe("音乐房间");
  });

  it("重连不作废在途的全量请求：缺口补丁不重复发", () => {
    // 全量请求挂住不回包，模拟重连时上一次请求仍在途。
    wsMock.send.mockImplementation((type: string) =>
      type === "song.room.requestSync" ? new Promise(() => {}) : Promise.resolve({})
    );
    dispose = initSonGuessrWs();
    const gapPatch = {
      type: "event" as const,
      event: "song.room.snapshot",
      payload: {
        mode: "patch" as const,
        baseRevision: 9,
        revision: 10,
        operations: [{ op: "replace" as const, path: "/name", value: "缺口" }],
      },
    };
    emitMessage(gapPatch);
    expect(requestSyncCalls()).toHaveLength(1);

    emitStatus(false);
    emitStatus(true);
    emitMessage(gapPatch);

    // 猜歌连上只作废修订号，在途去重标记留着：同一份欠账不因重连再发一次。
    expect(requestSyncCalls()).toHaveLength(1);
  });

  it("清理让连接代次前进：清理时还在途的入房，晚到的 ACK 不再写入身份", async () => {
    let resolveAck!: (value: unknown) => void;
    wsMock.send.mockImplementation((type: string) =>
      type === "song.room.join"
        ? new Promise((resolve) => {
            resolveAck = resolve;
          })
        : Promise.resolve({})
    );
    const cleanup = initSonGuessrWs();
    const joined = useSonGuessrStore
      .getState()
      .joinRoom("1234", "玩家")
      .then(
        () => null,
        (error: unknown) => error
      );
    cleanup();
    resolveAck({ roomId: "1234", sessionToken: "late-token" });

    expect(await joined).toMatchObject({ name: "AbortError" });
    expect(useSonGuessrStore.getState()).toMatchObject({ roomId: null, sessionToken: null });
  });

  describe("入房往返期间收到过别的房间的推送", () => {
    let resolveAck!: (value: unknown) => void;
    let joined: Promise<unknown>;
    const stalePatch = (event: string, path: string, value: unknown) => ({
      type: "event" as const,
      event,
      payload: {
        mode: "patch" as const,
        baseRevision: 1,
        revision: 2,
        operations: [{ op: "replace" as const, path, value }],
      },
    });

    beforeEach(() => {
      wsMock.send.mockImplementation((type: string) =>
        type === "song.room.join"
          ? new Promise((resolve) => {
              resolveAck = resolve;
            })
          : Promise.resolve({})
      );
      dispose = initSonGuessrWs();
      joined = useSonGuessrStore.getState().joinRoom("5678", "玩家");
      emitMessage({
        type: "event",
        event: "song.room.snapshot",
        payload: { mode: "full", revision: 1, state: snapshot },
      });
      emitMessage({
        type: "event",
        event: "song.game.privateState",
        payload: {
          mode: "full",
          revision: 1,
          state: { ...privateState, playerId: "old-player", sessionToken: "old-token" },
        },
      });
    });

    // 旧房的修订号对新房没有意义：基线不换掉的话，编号碰巧接得上的补丁会把旧房态改一改再摆上来。
    it("带首屏状态的 ACK 把两条基线都换成新房的，旧修订号的补丁改走全量", async () => {
      resolveAck({
        roomId: "5678",
        sessionToken: "entry-token",
        snapshot: { ...snapshot, roomId: "5678", name: "新房间" },
        privateState: { ...privateState, sessionToken: "entry-token" },
      });
      await joined;
      expect(useSonGuessrStore.getState().snapshot?.name).toBe("新房间");

      emitMessage(stalePatch("song.room.snapshot", "/name", "错位"));
      emitMessage(stalePatch("song.game.privateState", "/remainingGuesses", 1));
      expect(requestSyncCalls()).toHaveLength(1);
      expect(useSonGuessrStore.getState().snapshot).toMatchObject({
        roomId: "5678",
        name: "新房间",
      });
      expect(useSonGuessrStore.getState().privateState).toMatchObject({
        playerId: "player-1",
        remainingGuesses: 5,
      });
    });

    it("无状态 ACK 把旧房留下的基线整套作废，旧修订号的补丁改走全量", async () => {
      resolveAck({ roomId: "5678", sessionToken: "entry-token" });
      await joined;
      expect(useSonGuessrStore.getState()).toMatchObject({ roomId: "5678", snapshot: null });

      emitMessage(stalePatch("song.room.snapshot", "/name", "错位"));
      expect(requestSyncCalls()).toHaveLength(1);
      expect(useSonGuessrStore.getState()).toMatchObject({ roomId: "5678", snapshot: null });
    });
  });
});

it("玩法清理关闭连接、释放订阅并保留刷新凭据，可重新初始化", () => {
  saveSonGuessrSessionToken("1234", "recoverable");
  useSonGuessrStore.setState({ connected: true, lobbyReady: true });
  const cleanup = initSonGuessrWs();
  cleanup();
  expect(wsMock.disconnect).toHaveBeenCalledOnce();
  expect(wsMock.messageHandlers).toHaveLength(0);
  expect(wsMock.statusHandlers).toHaveLength(0);
  expect(useSonGuessrStore.getState()).toMatchObject({ connected: false, lobbyReady: false });
  expect(getSonGuessrSessionToken("1234")).toBe("recoverable");
  const next = initSonGuessrWs();
  expect(wsMock.messageHandlers).toHaveLength(1);
  next();
});

describe("猜歌提示行为", () => {
  // 断言布局实际渲染的那份列表：同一句话连发是否重播入场，取决于其中的编号。
  const shownToasts = () => useSonGuessrStore.getState().toasts;

  beforeEach(() => {
    vi.useFakeTimers();
    useSonGuessrStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("不同提示并存，按发出先后排列", () => {
    const { showToast } = useSonGuessrStore.getState();
    showToast("第一条");
    showToast("第二条", "error");
    expect(shownToasts().map((t) => [t.text, t.type])).toEqual([
      ["第一条", "info"],
      ["第二条", "error"],
    ]);
  });

  it("连续两条相同提示仍是一条，编号不变，重播一次", () => {
    const { showToast } = useSonGuessrStore.getState();
    showToast("同一句");
    const first = shownToasts()[0];
    showToast("同一句");
    expect(shownToasts().map((t) => t.text)).toEqual(["同一句"]);
    expect(shownToasts()[0].id).toBe(first.id);
    expect(shownToasts()[0].repeat).toBe(1);
  });

  it("普通信息三秒、错误五秒到点消失", () => {
    const { showToast } = useSonGuessrStore.getState();
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
    useSonGuessrStore.getState().showToast("短提示", "error", 1000);
    vi.advanceTimersByTime(999);
    expect(shownToasts().map((t) => t.text)).toEqual(["短提示"]);
    vi.advanceTimersByTime(1);
    expect(shownToasts()).toEqual([]);
  });

  it("默认类型是普通信息", () => {
    useSonGuessrStore.getState().showToast("默认类型");
    expect(shownToasts().map((t) => t.type)).toEqual(["info"]);
  });

  it("最多同时三条，再来新的最早一条让位", () => {
    const { showToast } = useSonGuessrStore.getState();
    for (const text of ["一", "二", "三", "四"]) showToast(text);
    expect(shownToasts().map((t) => t.text)).toEqual(["二", "三", "四"]);
  });
});
