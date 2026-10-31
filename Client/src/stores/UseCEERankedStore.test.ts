import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CEERankedProfile,
  CEERankedSeatView,
  CEERankedSettlement,
  CEERankedState,
  ServerMessage,
  StatePatchOperation,
} from "@bakagame/shared";
import { BAKA_CLIENT_DOWNLOAD_URL } from "@/lib/AntiCheatCopy";
import { rejectedProtocol } from "@/lib/ProtocolFailure";

// 只假到最底层的 WS 客户端与壳通道：`@/lib/CEEWs` 用真实实现，这样排位准入命令的
// 「先换票再发」也一并被这份测试覆盖（简报要求）。
const socket = vi.hoisted(() => {
  const send = vi.fn();
  const messageHandlers: Array<(message: ServerMessage) => void> = [];
  const statusHandlers: Array<(connected: boolean) => void> = [];
  // 订阅过的消息处理函数另存一份：释放后仍要能直接调用它，验证「晚到的推送被忽略」。
  const seenHandlers: Array<(message: ServerMessage) => void> = [];
  const drop = <T>(list: T[], item: T): T[] => list.filter((candidate) => candidate !== item);
  const client = {
    send,
    refreshIdentity: vi.fn(),
    waitForConnection: vi.fn(async () => undefined),
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage(handler: (message: ServerMessage) => void) {
      messageHandlers.push(handler);
      seenHandlers.push(handler);
      return () => {
        const next = drop(messageHandlers, handler);
        messageHandlers.length = 0;
        messageHandlers.push(...next);
      };
    },
    onStatus(handler: (connected: boolean) => void) {
      statusHandlers.push(handler);
      return () => {
        const next = drop(statusHandlers, handler);
        statusHandlers.length = 0;
        statusHandlers.push(...next);
      };
    },
  };
  return {
    client,
    send,
    refreshIdentity: client.refreshIdentity,
    waitForConnection: client.waitForConnection,
    isBakaClient: vi.fn(() => false),
    lastHandshakeHadTicket: vi.fn(() => true),
    waitForChannelTicket: vi.fn(async () => true),
    reportError: vi.fn(),
    showToast: vi.fn(),
    emit(message: ServerMessage) {
      for (const handler of [...messageHandlers]) handler(message);
    },
    emitStatus(connected: boolean) {
      for (const handler of [...statusHandlers]) handler(connected);
    },
    lastSeenHandler: () => seenHandlers[seenHandlers.length - 1],
    resetHandlers() {
      messageHandlers.length = 0;
      statusHandlers.length = 0;
      seenHandlers.length = 0;
    },
  };
});

vi.mock("@/lib/WebsocketClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/WebsocketClient")>();
  return { ...actual, createWebSocketClient: () => socket.client };
});

vi.mock("@/lib/BakaChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/BakaChannel")>();
  return {
    ...actual,
    bakaChannelQuery: () => "",
    isBakaClient: socket.isBakaClient,
    lastHandshakeHadTicket: socket.lastHandshakeHadTicket,
    waitForChannelTicket: socket.waitForChannelTicket,
  };
});

vi.mock("./UseCEEStore", () => ({
  useCEEStore: {
    getState: () => ({ reportError: socket.reportError, showToast: socket.showToast }),
  },
}));

import { clearCEERankedQueryCache, useCEERankedStore } from "./UseCEERankedStore";

const idleState: CEERankedState = { status: "idle" };
const queuedState: CEERankedState = {
  status: "queued",
  queuedAt: 1_700_000_000_000,
  botAvailableAt: 1_700_000_010_000,
  botFallbackAt: 1_700_000_030_000,
  window: 0,
};
const seat = (name: string, isBot: boolean): CEERankedSeatView => ({
  name,
  isBot,
  rating: 1_500,
  placementPlayed: null,
  points: 0,
  attempts: 0,
  allowance: 10,
  finished: false,
  online: true,
});
const seriesState = (settlement: CEERankedSettlement): CEERankedState => ({
  status: "series",
  series: {
    seriesId: "series-1",
    tier: { id: "d3", name: "资深" },
    phase: "settled",
    rated: true,
    self: seat("我", false),
    opponent: seat("新人偶", true),
    game: null,
    nextGameAt: null,
    games: [],
    result: {
      outcome: "won",
      reason: "completed",
      settlement,
      ratingBefore: 1_500,
      ratingAfter: 1_520,
      placementPlayed: null,
    },
  },
});
const profileFixture: CEERankedProfile = {
  rating: 1_520,
  placementPlayed: 5,
  placementTotal: 5,
  seriesPlayed: 12,
  wins: 7,
  losses: 4,
  draws: 1,
  botRatedToday: 2,
  botRatedLimit: 5,
  recent: [],
};

const fullFrame = (revision: number, state: CEERankedState): ServerMessage => ({
  type: "event",
  event: "cee.ranked.state",
  payload: { mode: "full", revision, state },
});
const patchFrame = (
  revision: number,
  baseRevision: number,
  operations: StatePatchOperation[]
): ServerMessage => ({
  type: "event",
  event: "cee.ranked.state",
  payload: { mode: "patch", revision, baseRevision, operations },
});

/** 门面会透传第三个 options 参数，断言命令名与载荷时不必复述它。 */
const callsOf = (command: string) =>
  socket.send.mock.calls.filter((call: unknown[]) => call[0] === command);
const firstPayloadOf = (command: string) => callsOf(command)[0]?.[1];

const deferred = <T>() => {
  const box: { resolve?: (value: T) => void } = {};
  const promise = new Promise<T>((resolve) => {
    box.resolve = resolve;
  });
  return { promise, resolve: (value: T) => box.resolve?.(value) };
};

/** 门面上有好几层 await：用一个宏任务把在途 Promise 一次性冲干净。 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 默认应答：状态命令回 `state`，其余命令回空对象。 */
const reply = (state: CEERankedState = idleState) =>
  socket.send.mockImplementation((command: unknown) =>
    Promise.resolve(command === "cee.ranked.status" ? state : {})
  );

let release: (() => void) | null = null;
const attachRanked = () => {
  release = useCEERankedStore.getState().attach();
  return release;
};

beforeEach(() => {
  vi.clearAllMocks();
  socket.resetHandlers();
  socket.isBakaClient.mockReturnValue(false);
  socket.lastHandshakeHadTicket.mockReturnValue(true);
  socket.waitForChannelTicket.mockResolvedValue(true);
  socket.waitForConnection.mockResolvedValue(undefined);
  clearCEERankedQueryCache();
  useCEERankedStore.setState({
    ready: false,
    state: null,
    profile: null,
    profileLoading: false,
    pending: {},
  });
  reply();
});

afterEach(() => {
  release?.();
  release = null;
});

describe("排位状态同步", () => {
  it("全量帧直接落地状态与修订号", async () => {
    attachRanked();
    await settle();

    socket.emit(fullFrame(1, queuedState));
    await settle();

    expect(useCEERankedStore.getState().state).toEqual(queuedState);
    expect(useCEERankedStore.getState().ready).toBe(true);
    // 全量帧自带修订号，链路连续，不该再补发一次状态请求。
    expect(callsOf("cee.ranked.status")).toHaveLength(1);
  });

  it("修订号连续时按补丁增量应用", async () => {
    attachRanked();
    await settle();
    socket.emit(fullFrame(1, queuedState));
    await settle();

    socket.emit(patchFrame(2, 1, [{ op: "replace", path: "/window", value: 3 }]));
    await settle();

    const state = useCEERankedStore.getState().state;
    expect(state?.status === "queued" && state.window).toBe(3);
    expect(state?.status === "queued" && state.queuedAt).toBe(1_700_000_000_000);
    expect(callsOf("cee.ranked.status")).toHaveLength(1);
  });

  it("修订号对不上时重发全量，且在途期间不重复发", async () => {
    const pendingStatus = deferred<CEERankedState>();
    let statusCount = 0;
    socket.send.mockImplementation((command: unknown) => {
      if (command !== "cee.ranked.status") return Promise.resolve({});
      statusCount += 1;
      return statusCount === 1 ? Promise.resolve(idleState) : pendingStatus.promise;
    });

    attachRanked();
    await settle();

    // ack 只带状态不带修订号：任何带 baseRevision 的补丁都算对不上。
    socket.emit(patchFrame(9, 8, [{ op: "replace", path: "/window", value: 1 }]));
    socket.emit(patchFrame(10, 9, [{ op: "replace", path: "/window", value: 2 }]));
    await settle();
    expect(callsOf("cee.ranked.status")).toHaveLength(2);

    pendingStatus.resolve(queuedState);
    await settle();
    expect(useCEERankedStore.getState().state).toEqual(queuedState);

    socket.emit(patchFrame(11, 10, [{ op: "replace", path: "/window", value: 4 }]));
    await settle();
    expect(callsOf("cee.ranked.status")).toHaveLength(3);
  });

  it("断线清空状态与修订号，重连后自动重新请求全量", async () => {
    attachRanked();
    await settle();
    socket.emit(fullFrame(1, queuedState));
    await settle();

    socket.emitStatus(false);
    expect(useCEERankedStore.getState().ready).toBe(false);
    expect(useCEERankedStore.getState().state).toBeNull();

    socket.emitStatus(true);
    await settle();
    expect(callsOf("cee.ranked.status")).toHaveLength(2);
    expect(useCEERankedStore.getState().ready).toBe(true);
  });

  it("释放之后到达的推送一律忽略", async () => {
    attachRanked();
    await settle();
    const handler = socket.lastSeenHandler();
    release?.();
    release = null;

    if (handler) handler(fullFrame(1, queuedState));
    await settle();

    expect(useCEERankedStore.getState().state).toBeNull();
    expect(useCEERankedStore.getState().ready).toBe(false);
  });

  it("重新进入排位页后，上一次在途的全量回包不再覆盖新状态", async () => {
    const stale = deferred<CEERankedState>();
    const fresh = deferred<CEERankedState>();
    let statusCount = 0;
    socket.send.mockImplementation((command: unknown) => {
      if (command !== "cee.ranked.status") return Promise.resolve({});
      statusCount += 1;
      return statusCount === 1 ? stale.promise : fresh.promise;
    });

    attachRanked();
    await settle();
    release?.();
    release = null;
    attachRanked();
    await settle();

    fresh.resolve(idleState);
    await settle();
    stale.resolve(queuedState);
    await settle();

    expect(useCEERankedStore.getState().state).toEqual(idleState);
  });

  it("本场结算从 pending 落到 rated 时自动刷新档案一次", async () => {
    socket.send.mockImplementation((command: unknown) =>
      Promise.resolve(
        command === "cee.ranked.status"
          ? idleState
          : command === "cee.ranked.profile"
            ? profileFixture
            : {}
      )
    );
    attachRanked();
    await settle();

    socket.emit(fullFrame(1, seriesState("pending")));
    await settle();
    socket.emit(fullFrame(2, seriesState("rated")));
    await settle();
    expect(callsOf("cee.ranked.profile")).toHaveLength(1);
    expect(useCEERankedStore.getState().profile).toEqual(profileFixture);

    // 已经是 rated 的后续推送不再重复刷档案。
    socket.emit(fullFrame(3, seriesState("rated")));
    await settle();
    expect(callsOf("cee.ranked.profile")).toHaveLength(1);
  });
});

describe("排位命令", () => {
  it("排队在请求发出到回包期间持有进行中锁", async () => {
    const ack = deferred<Record<string, unknown>>();
    socket.send.mockImplementation((command: unknown) =>
      command === "cee.ranked.queue" ? ack.promise : Promise.resolve({})
    );
    attachRanked();

    const running = useCEERankedStore.getState().queue();
    expect(useCEERankedStore.getState().pending.queue).toBe(true);
    expect(firstPayloadOf("cee.ranked.queue")).toEqual({});

    ack.resolve({});
    await running;
    expect(useCEERankedStore.getState().pending.queue).toBeUndefined();
  });

  it("猜测命令带角色 id，回包成功返回 true", async () => {
    attachRanked();
    await settle();

    const running = useCEERankedStore.getState().guess(7);
    expect(firstPayloadOf("cee.ranked.guess")).toEqual({ characterId: 7 });
    expect(useCEERankedStore.getState().pending.guess).toBe(true);

    await expect(running).resolves.toBe(true);
    expect(useCEERankedStore.getState().pending.guess).toBeUndefined();
  });

  it("通道类错误用排位措辞，不进通用上报", async () => {
    socket.send.mockImplementation((command: unknown) =>
      command === "cee.ranked.status"
        ? Promise.resolve(idleState)
        : rejectedProtocol({ code: "CLIENT_REQUIRED", message: "服务端原文" })
    );
    attachRanked();
    await settle();
    socket.reportError.mockClear();

    await useCEERankedStore.getState().queue();
    expect(socket.showToast).toHaveBeenCalledWith(
      `排位赛需要使用 BakaGame 客户端，请下载安装后再参与：${BAKA_CLIENT_DOWNLOAD_URL}`
    );
    expect(socket.reportError).not.toHaveBeenCalled();
  });

  it("其余失败走 CEE 的统一上报，服务端中文原文直接给玩家", async () => {
    socket.send.mockImplementation((command: unknown) =>
      command === "cee.ranked.status"
        ? Promise.resolve(idleState)
        : rejectedProtocol({ code: "RANKED_BOT_NOT_READY", message: "人机对手尚未就绪" })
    );
    attachRanked();
    await settle();

    const guessed = await useCEERankedStore.getState().guess(3);
    expect(guessed).toBe(false);
    expect(socket.reportError).toHaveBeenCalledWith({
      code: "RANKED_BOT_NOT_READY",
      message: "人机对手尚未就绪",
    });
    expect(socket.showToast).not.toHaveBeenCalled();
  });

  it("档案加载中置 profileLoading，回包后落档并复位", async () => {
    const ack = deferred<CEERankedProfile>();
    socket.send.mockImplementation((command: unknown) =>
      command === "cee.ranked.profile" ? ack.promise : Promise.resolve({})
    );
    attachRanked();

    const running = useCEERankedStore.getState().loadProfile();
    expect(useCEERankedStore.getState().profileLoading).toBe(true);
    expect(callsOf("cee.ranked.profile")).toHaveLength(1);

    ack.resolve(profileFixture);
    await running;
    expect(useCEERankedStore.getState().profile).toEqual(profileFixture);
    expect(useCEERankedStore.getState().profileLoading).toBe(false);
  });

  it("四个查询各发对应的排位命令，并在复用窗口内合并同键请求", async () => {
    attachRanked();
    await settle();
    socket.send.mockImplementation((command: unknown) => {
      if (command === "cee.ranked.characterSearch")
        return Promise.resolve({ results: [{ id: 1, name: "Nao", nameCn: "直" }] });
      if (command === "cee.ranked.subjectSearch")
        return Promise.resolve({ results: [{ id: 2, name: "Sora", nameCn: "空" }] });
      if (command === "cee.ranked.characterImage")
        return Promise.resolve({ imageUrl: "https://example.com/a.png" });
      return Promise.resolve({ results: [] });
    });

    const characters = await useCEERankedStore.getState().searchCharacters("  直  ");
    expect(characters).toEqual([{ id: 1, name: "Nao", nameCn: "直" }]);
    await useCEERankedStore.getState().searchCharacters("直");
    expect(callsOf("cee.ranked.characterSearch")).toHaveLength(1);
    expect(firstPayloadOf("cee.ranked.characterSearch")).toEqual({ keyword: "  直  " });

    await useCEERankedStore.getState().searchSubjects("空");
    expect(firstPayloadOf("cee.ranked.subjectSearch")).toEqual({ keyword: "空" });

    await useCEERankedStore.getState().loadSubjectCharacters(12);
    await useCEERankedStore.getState().loadSubjectCharacters(12);
    expect(callsOf("cee.ranked.subjectCharacters")).toHaveLength(1);
    expect(firstPayloadOf("cee.ranked.subjectCharacters")).toEqual({ subjectId: 12 });

    const image = await useCEERankedStore.getState().characterImage(9, "large");
    expect(image).toBe("https://example.com/a.png");
    expect(firstPayloadOf("cee.ranked.characterImage")).toEqual({
      characterId: 9,
      size: "large",
    });
    // 取图要回源上游，耗时由服务端决定：不能带上客户端超时。
    expect(callsOf("cee.ranked.characterImage")[0]?.[2]).toEqual({ timeout: 0 });
  });

  it("失败的查询不进复用窗口，下一次照常回源", async () => {
    attachRanked();
    await settle();
    let attempts = 0;
    socket.send.mockImplementation(() => {
      attempts += 1;
      return attempts === 1
        ? rejectedProtocol({ code: "UPSTREAM_UNAVAILABLE", message: "上游暂时不可用" })
        : Promise.resolve({ results: [{ id: 1, name: "A", nameCn: "甲" }] });
    });

    await expect(useCEERankedStore.getState().searchCharacters("甲")).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    const retried = await useCEERankedStore.getState().searchCharacters("甲");
    expect(retried).toHaveLength(1);
    expect(callsOf("cee.ranked.characterSearch")).toHaveLength(2);
  });
});

describe("壳内排位准入", () => {
  it("握手没带票时，排位状态命令先换票重连再发出", async () => {
    socket.isBakaClient.mockReturnValue(true);
    socket.lastHandshakeHadTicket.mockReturnValueOnce(false).mockReturnValue(true);
    attachRanked();
    await settle();

    expect(socket.waitForChannelTicket).toHaveBeenCalledTimes(1);
    expect(socket.refreshIdentity).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(callsOf("cee.ranked.status")).toHaveLength(1);
  });

  it("服务端拒绝准入后换票重发一次，玩家看不到失败", async () => {
    socket.isBakaClient.mockReturnValue(true);
    attachRanked();
    await settle();
    socket.send
      .mockRejectedValueOnce({ code: "CLIENT_REQUIRED", message: "服务端原文" })
      .mockResolvedValueOnce({});

    await useCEERankedStore.getState().queue();

    expect(callsOf("cee.ranked.queue")).toHaveLength(2);
    expect(socket.refreshIdentity).toHaveBeenCalledTimes(1);
    expect(socket.reportError).not.toHaveBeenCalled();
  });

  it("壳签不出票时不发注定被拒的人机命令，并提示通道未就绪", async () => {
    socket.isBakaClient.mockReturnValue(true);
    socket.lastHandshakeHadTicket.mockReturnValue(false);
    socket.waitForChannelTicket.mockResolvedValue(false);

    await useCEERankedStore.getState().playBot();

    expect(socket.refreshIdentity).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.reportError).toHaveBeenCalledWith({
      code: "CLIENT_CHANNEL_NOT_READY",
      message: "客户端通道尚未就绪",
    });
  });

  it("网页环境下排位命令不做任何换票动作", async () => {
    socket.isBakaClient.mockReturnValue(false);
    socket.lastHandshakeHadTicket.mockReturnValue(false);
    await useCEERankedStore.getState().queue();

    expect(socket.waitForChannelTicket).not.toHaveBeenCalled();
    expect(socket.refreshIdentity).not.toHaveBeenCalled();
    expect(callsOf("cee.ranked.queue")).toHaveLength(1);
  });
});
