import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_CHAT_WINDOW, createDefaultCEESettings } from "@bakagame/shared/values";
import type { CEERoomSnapshot } from "@bakagame/shared";
import { ceeWsClient } from "@/lib/CEEWs";
import { BAKA_CLIENT_DOWNLOAD_URL } from "@/lib/AntiCheatCopy";
import {
  ceeErrorMessage,
  clearCEEQueryCache,
  handleCEEMessage,
  initCEEWs,
  resetCEEStateSync,
  useCEEStore,
} from "./UseCEEStore";
import { readCEESession, writeCEESession } from "@/lib/CEESession";
import { ceePrivateState } from "@/stories/fixtures/CEE";
import { deferred } from "@/test/Deferred";

const snapshot: CEERoomSnapshot = {
  roomId: "1234",
  source: "native",
  name: "测试",
  visibility: "public",
  hasPassword: false,
  allowSpectators: true,
  hostPlayerId: "p1",
  phase: "waiting",
  settings: createDefaultCEESettings(),
  players: [],
  roundNumber: 0,
  syncRound: 0,
  setterPlayerId: null,
  phaseDeadlineAt: null,
  chat: [],
  roundSummary: null,
  upstreamConnected: true,
  bakaAntiCheat: false,
  spectateRequests: [],
};

it("停机时原地待命：保留房间会话，只提示等待重连", () => {
  writeCEESession("1234", "cee-token");
  useCEEStore.setState({ roomId: "1234", sessionToken: "cee-token", snapshot });

  handleCEEMessage({
    type: "event",
    event: "server.shutdown",
    payload: { message: "服务器维护中" },
  } as never);

  // 服务端会落盘房间，重连后由 useCEERoomLifecycle 带原票据重进；清掉会话就真回不去了。
  expect(useCEEStore.getState().roomId).toBe("1234");
  expect(readCEESession("1234")).toBe("cee-token");
  expect(useCEEStore.getState().toasts[0]).toMatchObject({ text: "服务器维护中", type: "error" });
});

it("停机提示停留十秒，与另外两款一致", () => {
  vi.useFakeTimers();
  try {
    handleCEEMessage({ type: "event", event: "server.shutdown", payload: {} } as never);
    vi.advanceTimersByTime(9999);
    expect(useCEEStore.getState().toasts.map((toast) => toast.text)).toEqual([
      "服务正在重启，稍后将自动重连",
    ]);
    vi.advanceTimersByTime(1);
    expect(useCEEStore.getState().toasts).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("停机不作废在途入房：晚到 ACK 照常落座", async () => {
  let resolveAck!: (value: Record<string, unknown>) => void;
  const ack = new Promise<Record<string, unknown>>((resolve) => {
    resolveAck = resolve;
  });
  const send = vi.spyOn(ceeWsClient, "send").mockReturnValueOnce(ack).mockResolvedValue({});
  const joined = useCEEStore.getState().joinRoom("1234", "玩家");

  handleCEEMessage({
    type: "event",
    event: "server.shutdown",
    payload: { message: "服务器维护中" },
  });
  resolveAck({
    source: "native",
    roomId: "1234",
    sessionToken: "late-token",
    snapshot,
    privateState: null,
  });
  await joined;

  // CEE 停机后由页面带原票据重进，入房意图不作废：晚到的 ACK 照常安装身份，不额外发离房。
  expect(send.mock.calls.map(([command]) => command)).toEqual(["cee.room.join"]);
  expect(readCEESession("1234")).toBe("late-token");
  expect(useCEEStore.getState()).toMatchObject({ roomId: "1234", sessionToken: "late-token" });
});

afterEach(() => {
  resetCEEStateSync();
  useCEEStore.getState().resetRoom();
  // 提示是队列：上一条用例留下的提示会排在前面，也会让同一句话变成原地重播。
  useCEEStore.getState().clearToasts();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("CEE 状态同步", () => {
  it("原版会话过期后删除旧凭据并允许重新加入", async () => {
    writeCEESession("1234", "expired");
    const send = vi
      .spyOn(ceeWsClient, "send")
      .mockRejectedValue({ code: "SESSION_EXPIRED", message: "会话已过期" });
    await expect(useCEEStore.getState().reconnectRoom("1234")).resolves.toBe(false);
    expect(readCEESession("1234")).toBeNull();
    await expect(useCEEStore.getState().reconnectRoom("1234")).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["ROOM_NOT_FOUND", "SESSION_NOT_FOUND", "SESSION_INVALID", "PLAYER_KICKED"])(
    "恢复命中共享永久码 %s 时同样丢弃本地凭据",
    async (code) => {
      writeCEESession("1234", "dead");
      vi.spyOn(ceeWsClient, "send").mockRejectedValue({ code, message: "x" });
      await expect(useCEEStore.getState().reconnectRoom("1234")).resolves.toBe(false);
      expect(readCEESession("1234")).toBeNull();
    }
  );

  it("房间已不在：标记关闭让页面退回大厅；座位失效时房间还在，不标记", async () => {
    writeCEESession("1234", "dead");
    vi.spyOn(ceeWsClient, "send").mockRejectedValueOnce({
      code: "SESSION_NOT_FOUND",
      message: "x",
    });
    await useCEEStore.getState().reconnectRoom("1234");
    expect(useCEEStore.getState().roomClosedAt).toBeNull();

    writeCEESession("1234", "dead");
    vi.spyOn(ceeWsClient, "send").mockRejectedValueOnce({
      code: "ROOM_NOT_FOUND",
      message: "x",
    });
    await useCEEStore.getState().reconnectRoom("1234");
    expect(useCEEStore.getState().roomClosedAt).not.toBeNull();
    expect(useCEEStore.getState().toasts.at(-1)).toMatchObject({
      text: "房间已解散或不存在",
      type: "error",
    });
  });

  it("网络类错误不算永久失效，本地凭据留着下次再试", async () => {
    writeCEESession("1234", "alive");
    vi.spyOn(ceeWsClient, "send").mockRejectedValue({ code: "TIMEOUT", message: "超时" });
    await expect(useCEEStore.getState().reconnectRoom("1234")).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(readCEESession("1234")).not.toBeNull();
  });

  it("重建连接先订阅大厅再由运行时回座，卸载释放连接且保留刷新凭据", async () => {
    let status: (connected: boolean) => void = () => {};
    vi.spyOn(ceeWsClient, "onStatus").mockImplementation((handler) => {
      status = handler;
      return () => {};
    });
    vi.spyOn(ceeWsClient, "connect").mockImplementation(() => {});
    const disconnect = vi.spyOn(ceeWsClient, "disconnect").mockImplementation(() => status(false));
    // 回座停在半路直到卸载：入房事务是模块级的，收尾必须让它落定，否则后续用例的推送都被当成入房在途。
    const restore = deferred<Record<string, unknown>>();
    const send = vi
      .spyOn(ceeWsClient, "send")
      .mockImplementation((command: string) =>
        command === "cee.room.reconnect"
          ? restore.promise
          : Promise.resolve({ originalAvailable: false })
      );
    writeCEESession("1234", "token");
    useCEEStore.setState({
      source: "native",
      roomId: "1234",
      sessionToken: "token",
      snapshot,
      lobbyReady: true,
    });
    const cleanup = initCEEWs();
    try {
      status(false);
      expect(useCEEStore.getState()).toMatchObject({
        connected: false,
        lobbyReady: false,
        snapshot,
      });
      status(true);
      await vi.waitFor(() => expect(useCEEStore.getState().lobbyReady).toBe(true));
      expect(send.mock.calls.map(([command]) => command)).toEqual([
        "cee.lobby.subscribeRooms",
        "cee.room.reconnect",
      ]);
    } finally {
      cleanup();
      restore.reject({ code: "NOT_CONNECTED", message: "WebSocket 未连接" });
      await restore.promise.catch(() => {});
    }
    expect(disconnect).toHaveBeenCalledOnce();
    expect(readCEESession("1234")).toBe("token");
    expect(useCEEStore.getState()).toMatchObject({
      connected: false,
      lobbyReady: false,
      roomId: null,
    });
  });

  it("连上后订阅大厅失败：以错误提示报出", async () => {
    let status: (connected: boolean) => void = () => {};
    vi.spyOn(ceeWsClient, "onStatus").mockImplementation((handler) => {
      status = handler;
      return () => {};
    });
    vi.spyOn(ceeWsClient, "connect").mockImplementation(() => {});
    vi.spyOn(ceeWsClient, "disconnect").mockImplementation(() => {});
    vi.spyOn(ceeWsClient, "send").mockRejectedValue({ code: "BAD", message: "大厅暂不可用" });
    const cleanup = initCEEWs();
    try {
      status(true);
      await vi.waitFor(() =>
        expect(useCEEStore.getState().toasts.at(-1)).toMatchObject({
          text: "大厅暂不可用",
          type: "error",
        })
      );
    } finally {
      cleanup();
    }
  });

  it("卸载先断连接再退订阅：断线回调仍把连接态与展示态清干净", () => {
    const statuses = new Set<(connected: boolean) => void>();
    vi.spyOn(ceeWsClient, "onStatus").mockImplementation((handler) => {
      statuses.add(handler);
      return () => {
        statuses.delete(handler);
      };
    });
    vi.spyOn(ceeWsClient, "connect").mockImplementation(() => {});
    vi.spyOn(ceeWsClient, "disconnect").mockImplementation(() => {
      statuses.forEach((handler) => handler(false));
    });
    useCEEStore.setState({ connected: true, lobbyReady: true, snapshot });

    initCEEWs()();

    expect(useCEEStore.getState()).toMatchObject({
      connected: false,
      lobbyReady: false,
      snapshot: null,
    });
  });

  it("受服务端计时的角色与图片请求不受短客户端超时截断", async () => {
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    const store = useCEEStore.getState();
    await store.sendCommand("cee.game.next", {});
    await store.sendCommand("cee.game.setAnswer", { characterId: 1, hints: [] });
    await store.sendCommand("cee.game.imageHint", {});
    await store.sendCommand("cee.character.image", { characterId: 1 });
    expect(send.mock.calls.map(([, , options]) => options?.timeout)).toEqual([0, 0, 0, 0]);
  });

  it("CEE 只读查询在复用窗口内复用结果，同键不重复请求上游", async () => {
    // 复用窗口是模块级状态，先清干净再断言调用序列。
    clearCEEQueryCache();
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({ results: [] });
    const store = useCEEStore.getState();

    await store.searchCharacters("初音");
    await store.searchCharacters(" 初音 ");
    await store.searchSubjects("某作品");
    await store.searchSubjects("某作品");
    await store.loadSubjectCharacters(123);
    await store.loadSubjectCharacters(123);

    // 六次调用只产生三次上游请求：同一输入（含首尾空白差异）命中同一份结果。
    expect(send.mock.calls.map(([command]) => command)).toEqual([
      "cee.character.search",
      "cee.subject.search",
      "cee.subject.characters",
    ]);
  });

  it("CEE 只读查询各发对应命令、带当前房间身份，并取回 results", async () => {
    clearCEEQueryCache();
    const send = vi.spyOn(ceeWsClient, "send").mockImplementation((command: string) =>
      Promise.resolve({
        results: command === "cee.subject.search" ? [{ id: 7, name: "作品" }] : [{ id: 1 }],
      })
    );
    useCEEStore.setState({ roomId: "1234", sessionToken: "tok" });
    const store = useCEEStore.getState();

    expect(await store.searchCharacters("初音")).toEqual([{ id: 1 }]);
    expect(await store.searchSubjects("某作品")).toEqual([{ id: 7, name: "作品" }]);
    expect(await store.loadSubjectCharacters(123)).toEqual([{ id: 1 }]);

    // 三条查询共用一个壳，但命令名、载荷与取字段各自独立；身份一律由 sendCommand 补齐。
    expect(send.mock.calls).toEqual([
      ["cee.character.search", { keyword: "初音" }, { roomId: "1234", sessionToken: "tok" }],
      ["cee.subject.search", { keyword: "某作品" }, { roomId: "1234", sessionToken: "tok" }],
      ["cee.subject.characters", { subjectId: 123 }, { roomId: "1234", sessionToken: "tok" }],
    ]);
  });

  it("CEE 只读查询失败不进复用窗口，下一次照常回源", async () => {
    clearCEEQueryCache();
    const send = vi
      .spyOn(ceeWsClient, "send")
      .mockRejectedValueOnce({ code: "UPSTREAM_UNAVAILABLE", message: "上游暂时不可用" })
      .mockResolvedValue({ results: [{ id: 1 }] });
    const store = useCEEStore.getState();

    await expect(store.searchCharacters("初音")).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    expect(await store.searchCharacters("初音")).toEqual([{ id: 1 }]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("使用服务端原始基线应用聊天补丁", () => {
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: { mode: "full", revision: 1, state: snapshot },
    });
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: {
        mode: "patch",
        revision: 2,
        baseRevision: 1,
        operations: [
          {
            op: "add",
            path: "/chat/0",
            value: {
              id: "m1",
              playerId: "p1",
              playerName: "甲",
              text: "你好",
              createdAt: 1,
              system: false,
            },
          },
        ],
      },
    });
    expect(useCEEStore.getState().snapshot?.chat.map((entry) => entry.text)).toEqual(["你好"]);
    expect(snapshot.chat).toEqual([]);
  });

  it("发现补丁缺口时请求全量且不覆盖现有房态", async () => {
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: { mode: "full", revision: 1, state: snapshot },
    });
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: {
        mode: "patch",
        revision: 4,
        baseRevision: 3,
        operations: [{ op: "replace", path: "/name", value: "错误状态" }],
      },
    });
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith("cee.room.requestSync", {}, expect.any(Object));
    expect(useCEEStore.getState().snapshot?.name).toBe("测试");
  });

  /**
   * 服务端建立会话后会**先推快照事件、再回进入房间的 ACK**。若在此期间抢发全量同步，
   * 信封不带凭据，原版会话校验必然判 `SESSION_INVALID`——该错误又会被当成永久错误，
   * 把刚建立的原版会话清掉，表现为「加入原版房间失败」。
   */
  it("进入原版房间期间不抢发同步，凭据写回后补一次全量", async () => {
    const calls: Array<{ command: string; options?: { sessionToken?: string } }> = [];
    vi.spyOn(ceeWsClient, "send").mockImplementation(
      (command: string, _payload?: unknown, options?: { sessionToken?: string }) => {
        calls.push({ command, options });
        if (command === "cee.room.join") {
          // 复刻服务端顺序：快照先到（此时凭据尚未写回），ACK 后到。
          handleCEEMessage({
            type: "event",
            event: "cee.room.snapshot",
            payload: {
              mode: "patch",
              revision: 5,
              baseRevision: 4,
              operations: [{ op: "replace", path: "/name", value: "新名" }],
            },
          });
          handleCEEMessage({
            type: "event",
            event: "cee.game.privateState",
            payload: {
              mode: "patch",
              revision: 5,
              baseRevision: 4,
              operations: [{ op: "replace", path: "/playerId", value: "p9" }],
            },
          });
          return Promise.resolve({
            roomId: "1234",
            source: "original",
            sessionToken: "tok-original",
            snapshot: { ...snapshot, source: "original" },
            privateState: { playerId: "p1" },
          });
        }
        return Promise.resolve({});
      }
    );

    await useCEEStore.getState().joinRoom("1234", "甲");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const duringJoin = calls.filter(
      (call) => call.command === "cee.room.requestSync" && !call.options?.sessionToken
    );
    expect(duringJoin).toEqual([]);
    const deferred = calls.filter((call) => call.command === "cee.room.requestSync");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.options?.sessionToken).toBe("tok-original");
  });
});
describe("CEE 状态同步通道行为", () => {
  const requestSyncCalls = (send: { mock: { calls: unknown[][] } }) =>
    send.mock.calls.filter(([command]) => command === "cee.room.requestSync");

  it("修订号连续的快照与私有态补丁逐条应用，不请求全量", () => {
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: { mode: "full", revision: 1, state: snapshot },
    });
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: {
        mode: "patch",
        baseRevision: 1,
        revision: 2,
        operations: [{ op: "replace", path: "/name", value: "第二幕" }],
      },
    });
    expect(useCEEStore.getState().snapshot?.name).toBe("第二幕");
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: {
        mode: "patch",
        baseRevision: 2,
        revision: 3,
        operations: [{ op: "replace", path: "/roundNumber", value: 1 }],
      },
    });
    expect(useCEEStore.getState().snapshot?.roundNumber).toBe(1);

    handleCEEMessage({
      type: "event",
      event: "cee.game.privateState",
      payload: { mode: "full", revision: 1, state: { playerId: "p1" } },
    });
    handleCEEMessage({
      type: "event",
      event: "cee.game.privateState",
      payload: {
        mode: "patch",
        baseRevision: 1,
        revision: 2,
        operations: [{ op: "replace", path: "/playerId", value: "p2" }],
      },
    });
    expect(useCEEStore.getState().privateState?.playerId).toBe("p2");
    expect(requestSyncCalls(send)).toHaveLength(0);
  });

  it("私有态补丁跳号时请求全量，缺口补丁不落在旧基线上", () => {
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    useCEEStore.setState({ roomId: "1234", sessionToken: "tok" });
    handleCEEMessage({
      type: "event",
      event: "cee.game.privateState",
      payload: { mode: "full", revision: 1, state: { playerId: "p1" } },
    });
    handleCEEMessage({
      type: "event",
      event: "cee.game.privateState",
      payload: {
        mode: "patch",
        baseRevision: 2,
        revision: 3,
        operations: [{ op: "replace", path: "/playerId", value: "tampered" }],
      },
    });
    expect(requestSyncCalls(send)).toHaveLength(1);
    expect(send).toHaveBeenCalledWith("cee.room.requestSync", {}, expect.any(Object));
    expect(useCEEStore.getState().privateState?.playerId).toBe("p1");
  });

  it("非法同步载荷请求全量，不改动现有展示态", () => {
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    useCEEStore.setState({ roomId: "1234", sessionToken: "tok" });
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: { mode: "full", revision: 1, state: snapshot },
    });
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: { name: "无版本号的裸状态" },
    });
    expect(requestSyncCalls(send)).toHaveLength(1);
    expect(useCEEStore.getState().snapshot?.name).toBe("测试");
  });

  it("全量请求在途时，两条通道的后续缺口不重复发", async () => {
    const send = vi
      .spyOn(ceeWsClient, "send")
      .mockImplementation((command: string) =>
        command === "cee.room.requestSync" ? new Promise<never>(() => {}) : Promise.resolve({})
      );
    useCEEStore.setState({ roomId: "1234", sessionToken: "tok" });
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: { mode: "full", revision: 1, state: snapshot },
    });
    const gap = (revision: number) => ({
      type: "event" as const,
      event: "cee.room.snapshot",
      payload: {
        mode: "patch" as const,
        baseRevision: 2,
        revision,
        operations: [{ op: "replace" as const, path: "/name", value: "错位" }],
      },
    });
    handleCEEMessage(gap(3));
    // 私有态还没有基线，补丁同样构成缺口；两条通道共用一个在途标记。
    handleCEEMessage({
      type: "event",
      event: "cee.game.privateState",
      payload: {
        mode: "patch",
        baseRevision: 0,
        revision: 1,
        operations: [{ op: "replace", path: "/playerId", value: "tampered" }],
      },
    });
    handleCEEMessage(gap(4));
    await vi.waitFor(() => expect(requestSyncCalls(send)).toHaveLength(1));
    expect(useCEEStore.getState().snapshot?.name).toBe("测试");
  });

  it("入房在途时推送只进同步基线，展示态与身份都等 ACK 落定", async () => {
    let resolveAck!: (value: Record<string, unknown>) => void;
    const send = vi.spyOn(ceeWsClient, "send").mockImplementation((command: string) =>
      command === "cee.room.join"
        ? new Promise<Record<string, unknown>>((resolve) => {
            resolveAck = resolve;
          })
        : Promise.resolve({})
    );
    const joined = useCEEStore.getState().joinRoom("1234", "甲");
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: { mode: "full", revision: 1, state: snapshot },
    });
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: {
        mode: "patch",
        baseRevision: 1,
        revision: 2,
        operations: [{ op: "replace", path: "/name", value: "暂存名" }],
      },
    });
    handleCEEMessage({
      type: "event",
      event: "cee.game.privateState",
      payload: { mode: "full", revision: 1, state: { playerId: "p1" } },
    });
    // 入房期间的推送只进同步基线：展示态、身份与凭据都等 ACK 落定后一次安装。
    expect(useCEEStore.getState().snapshot).toBeNull();
    expect(useCEEStore.getState().privateState).toBeNull();
    expect(useCEEStore.getState()).toMatchObject({ roomId: null, sessionToken: null });
    expect(requestSyncCalls(send)).toHaveLength(0);

    resolveAck({
      roomId: "1234",
      source: "native",
      sessionToken: "tok",
      snapshot,
      privateState: { playerId: "p1" },
    });
    await joined;
    expect(useCEEStore.getState()).toMatchObject({ roomId: "1234", sessionToken: "tok" });
    // 同房 ACK 不覆盖入房期间已应用的更新。
    expect(useCEEStore.getState().snapshot?.name).toBe("暂存名");
  });

  it("入房往返期间收到快照，已确认房间的展示态不变；ACK 落定后一次装上", async () => {
    useCEEStore.setState({
      source: "native",
      roomId: "1234",
      sessionToken: "tok-a",
      snapshot,
      privateState: ceePrivateState({ playerId: "p1" }),
    });
    let resolveAck!: (value: Record<string, unknown>) => void;
    vi.spyOn(ceeWsClient, "send").mockImplementation((command: string) =>
      command === "cee.room.join"
        ? new Promise<Record<string, unknown>>((resolve) => {
            resolveAck = resolve;
          })
        : Promise.resolve({})
    );
    const joined = useCEEStore.getState().joinRoom("5678", "甲");
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: { mode: "full", revision: 1, state: { ...snapshot, roomId: "5678", name: "新房" } },
    });
    // 往返期间的推送只进同步基线，不覆盖已确认房间的展示态与命令身份。
    expect(useCEEStore.getState()).toMatchObject({ roomId: "1234", sessionToken: "tok-a" });
    expect(useCEEStore.getState().snapshot?.roomId).toBe("1234");
    expect(useCEEStore.getState().snapshot?.name).toBe("测试");

    resolveAck({
      roomId: "5678",
      source: "native",
      sessionToken: "tok-b",
      snapshot: { ...snapshot, roomId: "5678", name: "新房" },
      privateState: { playerId: "p1" },
    });
    await joined;
    expect(useCEEStore.getState()).toMatchObject({ roomId: "5678", sessionToken: "tok-b" });
    expect(useCEEStore.getState().snapshot?.name).toBe("新房");
  });

  it("入房期间凭据已就绪时缺口立即请求全量，不记欠账", async () => {
    writeCEESession("1234", "old-token");
    useCEEStore.setState({ roomId: "1234", sessionToken: "old-token" });
    let resolveAck!: (value: Record<string, unknown>) => void;
    const send = vi.spyOn(ceeWsClient, "send").mockImplementation((command: string) =>
      command === "cee.room.reconnect"
        ? new Promise<Record<string, unknown>>((resolve) => {
            resolveAck = resolve;
          })
        : Promise.resolve({})
    );
    const restoring = useCEEStore.getState().reconnectRoom("1234");
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: { mode: "full", revision: 1, state: snapshot },
    });
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: {
        mode: "patch",
        baseRevision: 2,
        revision: 3,
        operations: [{ op: "replace", path: "/name", value: "错位" }],
      },
    });
    // 欠账只记「凭据缺失」的入房期；凭据还在时即使在入房往返中也立即补全量。
    await vi.waitFor(() => expect(requestSyncCalls(send)).toHaveLength(1));
    expect(send).toHaveBeenCalledWith(
      "cee.room.requestSync",
      {},
      expect.objectContaining({ sessionToken: "old-token" })
    );

    resolveAck({
      roomId: "1234",
      source: "native",
      sessionToken: "new-token",
      snapshot,
      privateState: null,
    });
    await restoring;
    // 没有欠账：ACK 后不再补发。
    expect(requestSyncCalls(send)).toHaveLength(1);
  });

  it("没有推送赶在 ACK 之前时，ACK 的首屏状态直接装成展示态", async () => {
    vi.spyOn(ceeWsClient, "send").mockImplementation((command: string) =>
      Promise.resolve(
        command === "cee.room.join"
          ? {
              roomId: "1234",
              source: "native",
              sessionToken: "tok",
              snapshot,
              privateState: { playerId: "p1" },
            }
          : {}
      )
    );
    await useCEEStore.getState().joinRoom("1234", "甲");
    expect(useCEEStore.getState().snapshot).toEqual(snapshot);
    expect(useCEEStore.getState().privateState).toEqual({ playerId: "p1" });
  });

  it("ACK 落定时重置同步：入房期间悬着的全量请求不压住进房后的缺口", async () => {
    writeCEESession("1234", "old-token");
    useCEEStore.setState({ roomId: "1234", sessionToken: "old-token" });
    let resolveAck!: (value: Record<string, unknown>) => void;
    const send = vi.spyOn(ceeWsClient, "send").mockImplementation((command: string) => {
      if (command === "cee.room.requestSync") return new Promise<never>(() => {});
      if (command !== "cee.room.reconnect") return Promise.resolve({});
      return new Promise<Record<string, unknown>>((resolve) => {
        resolveAck = resolve;
      });
    });
    const gap = (revision: number) => ({
      type: "event" as const,
      event: "cee.room.snapshot",
      payload: {
        mode: "patch" as const,
        baseRevision: 2,
        revision,
        operations: [{ op: "replace" as const, path: "/name", value: "错位" }],
      },
    });
    const restoring = useCEEStore.getState().reconnectRoom("1234");
    // 等恢复请求真正发出再推缺口：入房开头那次重置已经过去，后面只剩 ACK 落定时那一次。
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("cee.room.reconnect", expect.anything(), expect.anything())
    );
    handleCEEMessage(gap(3));
    await vi.waitFor(() => expect(requestSyncCalls(send)).toHaveLength(1));

    resolveAck({
      roomId: "1234",
      source: "native",
      sessionToken: "new-token",
      snapshot,
      privateState: null,
    });
    await restoring;
    handleCEEMessage(gap(4));
    await vi.waitFor(() => expect(requestSyncCalls(send)).toHaveLength(2));
  });

  it("全量请求失败按统一口径报成提示", async () => {
    vi.spyOn(ceeWsClient, "send").mockRejectedValue({
      code: "ROOM_NOT_FOUND",
      message: "房间不存在",
    });
    useCEEStore.setState({ roomId: "1234", sessionToken: "tok" });
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: { name: "无版本号的裸状态" },
    });
    await vi.waitFor(() =>
      expect(useCEEStore.getState().toasts.map((toast) => toast.text)).toEqual(["房间不存在"])
    );
  });

  it("入房开头重置同步基线：上一段会话留下的修订号不会被入房期间的补丁续上", async () => {
    writeCEESession("1234", "tok");
    useCEEStore.setState({ roomId: "1234", sessionToken: "tok" });
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: { mode: "full", revision: 1, state: snapshot },
    });
    let resolveAck!: (value: Record<string, unknown>) => void;
    const send = vi.spyOn(ceeWsClient, "send").mockImplementation((command: string) =>
      command === "cee.room.reconnect"
        ? new Promise<Record<string, unknown>>((resolve) => {
            resolveAck = resolve;
          })
        : Promise.resolve({})
    );
    const restoring = useCEEStore.getState().reconnectRoom("1234");
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("cee.room.reconnect", expect.anything(), expect.anything())
    );
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: {
        mode: "patch",
        baseRevision: 1,
        revision: 2,
        operations: [{ op: "replace", path: "/name", value: "错位" }],
      },
    });
    // 基线已在入房开头清空：编号接得上的补丁也不能落到旧房态上，只能走全量。
    await vi.waitFor(() => expect(requestSyncCalls(send)).toHaveLength(1));

    resolveAck({
      roomId: "1234",
      source: "native",
      sessionToken: "tok2",
      snapshot,
      privateState: null,
    });
    await restoring;
    expect(useCEEStore.getState().snapshot?.name).toBe("测试");
  });

  it("弃用晚到的会话时连接已经更换：只离房，不重置新连接上的房间态", async () => {
    let status: (connected: boolean) => void = () => {};
    vi.spyOn(ceeWsClient, "onStatus").mockImplementation((handler) => {
      status = handler;
      return () => {};
    });
    vi.spyOn(ceeWsClient, "connect").mockImplementation(() => {});
    vi.spyOn(ceeWsClient, "disconnect").mockImplementation(() => {});
    let resolveAck!: (value: Record<string, unknown>) => void;
    let resolveLeave!: (value: Record<string, unknown>) => void;
    const send = vi.spyOn(ceeWsClient, "send").mockImplementation((command: string) => {
      if (command === "cee.room.join")
        return new Promise<Record<string, unknown>>((resolve) => {
          resolveAck = resolve;
        });
      if (command === "cee.room.leave")
        return new Promise<Record<string, unknown>>((resolve) => {
          resolveLeave = resolve;
        });
      return Promise.resolve({ originalAvailable: false });
    });
    const cleanup = initCEEWs();
    try {
      const controller = new AbortController();
      const outcome = useCEEStore
        .getState()
        .joinRoom("1234", "玩家", undefined, controller.signal)
        .then(
          () => null,
          (error: unknown) => error
        );
      controller.abort();
      resolveAck({
        source: "native",
        roomId: "1234",
        sessionToken: "late-token",
        snapshot,
        privateState: null,
      });
      await vi.waitFor(() =>
        expect(send.mock.calls.map(([command]) => command)).toContain("cee.room.leave")
      );
      // 离房还没回，连接换了一条，新连接上已经有了别的房间态。
      status(false);
      status(true);
      useCEEStore.setState({ roomId: "5678", sessionToken: "fresh" });
      resolveLeave({});
      expect(await outcome).toMatchObject({ name: "AbortError" });
      expect(useCEEStore.getState()).toMatchObject({ roomId: "5678", sessionToken: "fresh" });
    } finally {
      cleanup();
    }
  });
});

it("取消加入的晚到 ACK 使用结果凭据离房，不写入新会话", async () => {
  let resolve!: (value: Record<string, unknown>) => void;
  const ack = new Promise<Record<string, unknown>>((done) => {
    resolve = done;
  });
  const send = vi.spyOn(ceeWsClient, "send").mockReturnValueOnce(ack).mockResolvedValue({});
  const controller = new AbortController();
  const outcome = useCEEStore
    .getState()
    .joinRoom("1234", "玩家", undefined, controller.signal)
    .then(
      () => null,
      (error) => error
    );
  controller.abort();
  resolve({
    source: "native",
    roomId: "1234",
    sessionToken: "late-token",
    snapshot,
    privateState: null,
  });
  expect(await outcome).toMatchObject({ name: "AbortError" });
  expect(send.mock.calls.map(([command]) => command)).toEqual(["cee.room.join", "cee.room.leave"]);
  expect(send.mock.calls[1][2]).toEqual({ roomId: "1234", sessionToken: "late-token" });
  expect(readCEESession("1234")).toBeNull();
  expect(useCEEStore.getState()).toMatchObject({
    roomId: null,
    sessionToken: null,
    snapshot: null,
  });
});
it("加入前已取消的意图不发送网络命令", async () => {
  const send = vi.spyOn(ceeWsClient, "send");
  const controller = new AbortController();
  controller.abort();
  const error = await useCEEStore
    .getState()
    .joinRoom("1234", "玩家", undefined, controller.signal)
    .catch((error) => error);
  expect(error).toMatchObject({ name: "AbortError" });
  expect(send).not.toHaveBeenCalled();
});
it("临时恢复失败保留会话并向调用者拒绝，而非伪装成功", async () => {
  writeCEESession("Oblivionis", "recoverable");
  const send = vi
    .spyOn(ceeWsClient, "send")
    .mockRejectedValue({ code: "DISCONNECTED", message: "连接已断开" });
  const error = await useCEEStore
    .getState()
    .reconnectRoom(" oblivionis ")
    .catch((error) => error);
  expect(error).toMatchObject({ code: "DISCONNECTED" });
  expect(readCEESession("Oblivionis")).toBe("recoverable");
  expect(send).toHaveBeenCalledWith(
    "cee.room.reconnect",
    { roomId: "Oblivionis", sessionToken: "recoverable" },
    { timeout: 0 }
  );
});
it("StrictMode 重挂载接管同房在途恢复，不重复恢复或离房", async () => {
  let resolveAck!: (value: Record<string, unknown>) => void;
  const ack = new Promise<Record<string, unknown>>((resolve) => {
    resolveAck = resolve;
  });
  writeCEESession("1234", "old-token");
  const send = vi.spyOn(ceeWsClient, "send").mockReturnValueOnce(ack);
  const oldOwner = new AbortController();
  const newOwner = new AbortController();
  const cancelled = useCEEStore
    .getState()
    .reconnectRoom("1234", oldOwner.signal)
    .catch((error) => error);
  oldOwner.abort();
  const next = useCEEStore.getState().reconnectRoom("1234", newOwner.signal);
  expect(send.mock.calls.map(([command]) => command)).toEqual(["cee.room.reconnect"]);
  resolveAck({
    source: "native",
    roomId: "1234",
    sessionToken: "new-token",
    snapshot,
    privateState: null,
  });
  expect(await cancelled).toMatchObject({ name: "AbortError" });
  expect(await next).toBe(true);
  expect(send).toHaveBeenCalledOnce();
  expect(readCEESession("1234")).toBe("new-token");
  expect(useCEEStore.getState().sessionToken).toBe("new-token");
});
it("恢复的全部发起者都取消时，晚到 ACK 只用结果凭据离房", async () => {
  writeCEESession("1234", "old-token");
  let resolveAck!: (value: Record<string, unknown>) => void;
  const ack = new Promise<Record<string, unknown>>((resolve) => {
    resolveAck = resolve;
  });
  const send = vi.spyOn(ceeWsClient, "send").mockReturnValueOnce(ack).mockResolvedValue({});
  const first = new AbortController();
  const second = new AbortController();
  const tasks = [
    useCEEStore
      .getState()
      .reconnectRoom("1234", first.signal)
      .catch((error) => error),
    useCEEStore
      .getState()
      .reconnectRoom("1234", second.signal)
      .catch((error) => error),
  ];
  first.abort();
  second.abort();
  resolveAck({
    source: "native",
    roomId: "1234",
    sessionToken: "late-token",
    snapshot,
    privateState: null,
  });
  expect(await tasks[0]).toMatchObject({ name: "AbortError" });
  expect(await tasks[1]).toMatchObject({ name: "AbortError" });
  expect(send.mock.calls.map(([command]) => command)).toEqual([
    "cee.room.reconnect",
    "cee.room.leave",
  ]);
  expect(send.mock.calls[1][2]).toEqual({ roomId: "1234", sessionToken: "late-token" });
  expect(readCEESession("1234")).toBeNull();
  expect(useCEEStore.getState()).toMatchObject({
    roomId: null,
    sessionToken: null,
    snapshot: null,
  });
});
it("取消恢复后晚到的永久拒绝不清凭据也不发旧提示", async () => {
  writeCEESession("1234", "previous-token");
  let rejectAck!: (error: unknown) => void;
  vi.spyOn(ceeWsClient, "send").mockImplementation((command: string) =>
    command === "cee.room.reconnect"
      ? new Promise<Record<string, unknown>>((_resolve, reject) => {
          rejectAck = reject;
        })
      : Promise.resolve({})
  );
  const controller = new AbortController();
  const task = useCEEStore
    .getState()
    .reconnectRoom("1234", controller.signal)
    .catch((error) => error);
  const toastsBefore = useCEEStore.getState().toasts;
  controller.abort();
  rejectAck({ code: "SESSION_NOT_FOUND", message: "旧拒绝" });
  expect(await task).toMatchObject({ name: "AbortError" });
  expect(readCEESession("1234")).toBe("previous-token");
  expect(useCEEStore.getState().toasts).toBe(toastsBefore);
});
it("断线作废在途入房：晚到 ACK 不安装身份，也不向新连接发旧离房", async () => {
  let status: (connected: boolean) => void = () => {};
  vi.spyOn(ceeWsClient, "onStatus").mockImplementation((handler) => {
    status = handler;
    return () => {};
  });
  vi.spyOn(ceeWsClient, "connect").mockImplementation(() => {});
  vi.spyOn(ceeWsClient, "disconnect").mockImplementation(() => {});
  let resolveAck!: (value: Record<string, unknown>) => void;
  const send = vi.spyOn(ceeWsClient, "send").mockImplementation((command: string) =>
    command === "cee.room.join"
      ? new Promise<Record<string, unknown>>((resolve) => {
          resolveAck = resolve;
        })
      : Promise.resolve({})
  );
  const cleanup = initCEEWs();
  try {
    const outcome = useCEEStore
      .getState()
      .joinRoom("1234", "玩家")
      .catch((error) => error);
    status(false);
    resolveAck({
      source: "native",
      roomId: "1234",
      sessionToken: "late-token",
      snapshot,
      privateState: null,
    });
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(send.mock.calls.map(([command]) => command)).toEqual(["cee.room.join"]);
    expect(readCEESession("1234")).toBeNull();
    expect(useCEEStore.getState()).toMatchObject({
      roomId: null,
      sessionToken: null,
      snapshot: null,
    });
  } finally {
    cleanup();
  }
});
it("取消后的旧离房尚未完成时，新加入必须等待旧会话释放", async () => {
  let resolveAck!: (value: Record<string, unknown>) => void;
  let resolveLeave!: (value: Record<string, unknown>) => void;
  const ack = new Promise<Record<string, unknown>>((resolve) => {
    resolveAck = resolve;
  });
  const leave = new Promise<Record<string, unknown>>((resolve) => {
    resolveLeave = resolve;
  });
  const send = vi
    .spyOn(ceeWsClient, "send")
    .mockReturnValueOnce(ack)
    .mockReturnValueOnce(leave)
    .mockResolvedValue({
      source: "native",
      roomId: "5678",
      sessionToken: "second-token",
      snapshot: { ...snapshot, roomId: "5678" },
      privateState: null,
    });
  const controller = new AbortController();
  const cancelled = useCEEStore
    .getState()
    .joinRoom("1234", "旧意图", undefined, controller.signal)
    .catch((error) => error);
  controller.abort();
  const next = useCEEStore.getState().joinRoom("5678", "新意图");
  resolveAck({
    source: "native",
    roomId: "1234",
    sessionToken: "first-token",
    snapshot,
    privateState: null,
  });
  await vi.waitFor(() =>
    expect(send.mock.calls.map(([command]) => command)).toEqual(["cee.room.join", "cee.room.leave"])
  );
  resolveLeave({});
  expect(await cancelled).toMatchObject({ name: "AbortError" });
  await next;
  expect(send.mock.calls.map(([command]) => command)).toEqual([
    "cee.room.join",
    "cee.room.leave",
    "cee.room.join",
  ]);
  expect(useCEEStore.getState()).toMatchObject({ roomId: "5678", sessionToken: "second-token" });
});
it("房间关闭作废在途入房：晚到 ACK 只用结果凭据离房并保留关闭标记", async () => {
  let resolveAck!: (value: Record<string, unknown>) => void;
  const ack = new Promise<Record<string, unknown>>((resolve) => {
    resolveAck = resolve;
  });
  const send = vi.spyOn(ceeWsClient, "send").mockReturnValueOnce(ack).mockResolvedValue({});
  const outcome = useCEEStore
    .getState()
    .joinRoom("1234", "玩家")
    .catch((error) => error);
  handleCEEMessage({
    type: "event",
    event: "cee.room.closed",
    payload: { message: "房间已关闭" },
  });
  expect(useCEEStore.getState().roomClosedAt).not.toBeNull();
  resolveAck({
    source: "native",
    roomId: "1234",
    sessionToken: "closed-token",
    snapshot,
    privateState: null,
  });
  expect(await outcome).toMatchObject({ name: "AbortError" });
  expect(send.mock.calls.map(([command]) => command)).toEqual(["cee.room.join", "cee.room.leave"]);
  expect(send.mock.calls[1][2]).toEqual({ roomId: "1234", sessionToken: "closed-token" });
  expect(readCEESession("1234")).toBeNull();
  expect(useCEEStore.getState()).toMatchObject({
    roomId: null,
    sessionToken: null,
    snapshot: null,
  });
  expect(useCEEStore.getState().roomClosedAt).not.toBeNull();
});
it.each(["cee.room.closed", "cee.player.kicked", "session.replaced"])(
  "%s 的房号不是当前房间时只清那间的会话，不动当前房间",
  (event) => {
    writeCEESession("1111", "current-token");
    writeCEESession("2222", "stale-token");
    useCEEStore.setState({ roomId: "1111", sessionToken: "current-token", snapshot });
    handleCEEMessage({ type: "event", event, payload: { roomId: "2222" } });
    expect(readCEESession("2222")).toBeNull();
    expect(readCEESession("1111")).not.toBeNull();
    expect(useCEEStore.getState()).toMatchObject({
      roomId: "1111",
      sessionToken: "current-token",
      roomClosedAt: null,
    });
    expect(useCEEStore.getState().snapshot).not.toBeNull();
  }
);
it("房间结束事件带房号且与当前一致时，清该房会话并退房", () => {
  writeCEESession("1111", "current-token");
  useCEEStore.setState({ roomId: "1111", sessionToken: "current-token", snapshot });
  handleCEEMessage({ type: "event", event: "cee.room.closed", payload: { roomId: "1111" } });
  expect(readCEESession("1111")).toBeNull();
  expect(useCEEStore.getState()).toMatchObject({ roomId: null, snapshot: null });
  expect(useCEEStore.getState().roomClosedAt).not.toBeNull();
});
it.each([
  ["cee.room.closed", "房间已关闭"],
  ["cee.player.kicked", "你已被移出房间"],
  ["session.replaced", "当前席位已在另一个标签页接管"],
])("增强房的 %s 与另两款同一句，不用服务端句子", (event, text) => {
  const shown = () => useCEEStore.getState().toasts.at(-1);
  useCEEStore.setState({ roomId: "1234", sessionToken: "tok", snapshot });
  handleCEEMessage({ type: "event", event, payload: { message: "服务端句子", reason: "原因" } });
  expect(shown()).toMatchObject({ text, type: "error" });
});
it.each([
  ["cee.room.closed", "房间已关闭"],
  ["cee.player.kicked", "你已被移出房间"],
  ["session.replaced", "当前席位已在另一个标签页接管"],
])("原版房的 %s 优先用服务端句子，其次原因，都没有才用同语义的那一句", (event, text) => {
  const shown = () => useCEEStore.getState().toasts.at(-1);
  const original = { ...snapshot, source: "original" as const };
  const enter = () =>
    useCEEStore.setState({ roomId: "1234", sessionToken: "tok", snapshot: original });
  enter();
  handleCEEMessage({ type: "event", event, payload: { message: "服务端句子", reason: "原因" } });
  expect(shown()).toMatchObject({ text: "服务端句子", type: "error" });
  enter();
  handleCEEMessage({ type: "event", event, payload: { reason: "原因" } });
  expect(shown()).toMatchObject({ text: "原因", type: "error" });
  enter();
  handleCEEMessage({ type: "event", event, payload: {} });
  expect(shown()).toMatchObject({ text, type: "error" });
});
it("原版房的结束事件自带来源标记时，即使本地还没有快照也用服务端句子", () => {
  const shown = () => useCEEStore.getState().toasts.at(-1);
  handleCEEMessage({
    type: "event",
    event: "cee.room.closed",
    payload: { source: "original", reason: "原版房间已关闭" },
  });
  expect(shown()).toMatchObject({ text: "原版房间已关闭", type: "error" });
});
it("同步基线重置后，挂起的全量同步不压住下一次补丁缺口", async () => {
  const send = vi.spyOn(ceeWsClient, "send").mockImplementation((command: string) => {
    if (command === "cee.room.requestSync") return new Promise<never>(() => {});
    return Promise.resolve({});
  });
  const requestSyncCalls = () =>
    send.mock.calls.filter(([command]) => command === "cee.room.requestSync");
  useCEEStore.setState({ roomId: "1234", sessionToken: "tok" });
  const gap = {
    type: "event" as const,
    event: "cee.room.snapshot",
    payload: {
      mode: "patch" as const,
      revision: 3,
      baseRevision: 2,
      operations: [{ op: "replace" as const, path: "/name", value: "错位" }],
    },
  };
  handleCEEMessage({
    type: "event",
    event: "cee.room.snapshot",
    payload: { mode: "full", revision: 1, state: snapshot },
  });
  handleCEEMessage(gap);
  await vi.waitFor(() => expect(requestSyncCalls()).toHaveLength(1));

  // 连接重置或退房会清空同步基线；此前那次全量请求可能仍然悬着，不能因此拦住新基线后的缺口。
  resetCEEStateSync();
  handleCEEMessage({
    type: "event",
    event: "cee.room.snapshot",
    payload: { mode: "full", revision: 1, state: snapshot },
  });
  handleCEEMessage(gap);
  await vi.waitFor(() => expect(requestSyncCalls()).toHaveLength(2));
});

describe("CEE 连接生命周期", () => {
  const live = { messages: 0, statuses: 0 };
  let connects = 0;
  let status: (connected: boolean) => void = () => {};

  beforeEach(() => {
    live.messages = 0;
    live.statuses = 0;
    connects = 0;
    status = () => {};
    vi.spyOn(ceeWsClient, "onMessage").mockImplementation(() => {
      live.messages += 1;
      return () => {
        live.messages -= 1;
      };
    });
    vi.spyOn(ceeWsClient, "onStatus").mockImplementation((handler) => {
      live.statuses += 1;
      status = handler;
      return () => {
        live.statuses -= 1;
      };
    });
    vi.spyOn(ceeWsClient, "connect").mockImplementation(() => {
      connects += 1;
    });
    vi.spyOn(ceeWsClient, "disconnect").mockImplementation(() => {});
  });

  it("重复初始化不叠加第二路消息与状态订阅", () => {
    const cleanup = initCEEWs();
    const again = initCEEWs();
    expect(live).toEqual({ messages: 1, statuses: 1 });
    expect(connects).toBe(1);
    // 第二次调用交回的清理是空操作，不能把第一次的订阅退掉。
    again();
    expect(live).toEqual({ messages: 1, statuses: 1 });
    cleanup();
    expect(live).toEqual({ messages: 0, statuses: 0 });
  });

  it("清理之后可以重新初始化", () => {
    initCEEWs()();
    expect(live).toEqual({ messages: 0, statuses: 0 });
    const next = initCEEWs();
    expect(live).toEqual({ messages: 1, statuses: 1 });
    expect(connects).toBe(2);
    next();
  });

  it("大厅订阅的晚到 ACK 换了代次就不写就绪标记", async () => {
    let resolveSubscribe!: (value: Record<string, unknown>) => void;
    const subscribe = new Promise<Record<string, unknown>>((resolve) => {
      resolveSubscribe = resolve;
    });
    vi.spyOn(ceeWsClient, "send").mockReturnValueOnce(subscribe).mockResolvedValue({});
    useCEEStore.setState({ lobbyReady: false, originalAvailable: false });
    const cleanup = initCEEWs();
    try {
      status(true);
      // 订阅回包还没到，连接就又断了一次：旧连接的就绪标记不能落到新连接上。
      status(false);
      resolveSubscribe({ originalAvailable: true });
      await subscribe;
      expect(useCEEStore.getState()).toMatchObject({
        lobbyReady: false,
        originalAvailable: false,
      });
    } finally {
      cleanup();
    }
  });

  it("断线即作废同步基线：断线窗口里到达的补丁不续旧修订号", async () => {
    const send = vi.spyOn(ceeWsClient, "send").mockResolvedValue({});
    useCEEStore.setState({ roomId: "1234", sessionToken: "tok" });
    const cleanup = initCEEWs();
    try {
      handleCEEMessage({
        type: "event",
        event: "cee.room.snapshot",
        payload: { mode: "full", revision: 7, state: snapshot },
      });
      status(false);
      handleCEEMessage({
        type: "event",
        event: "cee.room.snapshot",
        payload: {
          mode: "patch",
          baseRevision: 7,
          revision: 8,
          operations: [{ op: "replace", path: "/name", value: "断线后" }],
        },
      });
      await vi.waitFor(() =>
        expect(
          send.mock.calls.filter(([command]) => command === "cee.room.requestSync")
        ).toHaveLength(1)
      );
      // 保留的画面停在断线前那一帧：补丁不落到它上面，等重连后的全量整体替换。
      expect(useCEEStore.getState().snapshot).toEqual(snapshot);
    } finally {
      cleanup();
    }
  });
});

describe("CEE 断线与回座的时序", () => {
  let status: (connected: boolean) => void = () => {};
  const privateState = ceePrivateState({ playerId: "p1" });
  const serverSnapshot: CEERoomSnapshot = {
    ...snapshot,
    name: "服务端全量",
    phase: "guessing",
    roundNumber: 2,
  };
  const serverPrivate = ceePrivateState({ playerId: "p1", canGuess: false });
  const commands = (send: { mock: { calls: unknown[][] } }) =>
    send.mock.calls.map(([command]) => command);

  beforeEach(() => {
    status = () => {};
    vi.spyOn(ceeWsClient, "onStatus").mockImplementation((handler) => {
      status = handler;
      return () => {};
    });
    vi.spyOn(ceeWsClient, "onMessage").mockImplementation(() => () => {});
    vi.spyOn(ceeWsClient, "connect").mockImplementation(() => {});
    vi.spyOn(ceeWsClient, "disconnect").mockImplementation(() => {});
    writeCEESession("1234", "token");
    useCEEStore.setState({
      source: "native",
      connected: true,
      lobbyReady: true,
      roomId: "1234",
      sessionToken: "token",
      snapshot,
      privateState,
      seatLostAt: null,
    });
  });

  /** 回座命令停在半路，由用例决定它何时、以什么结果回来。 */
  const holdReconnect = () => {
    const acks: Array<ReturnType<typeof deferred<Record<string, unknown>>>> = [];
    const send = vi.spyOn(ceeWsClient, "send").mockImplementation((command: string) => {
      if (command !== "cee.room.reconnect") return Promise.resolve({ originalAvailable: false });
      const ack = deferred<Record<string, unknown>>();
      acks.push(ack);
      return ack.promise;
    });
    return { send, acks };
  };
  const receipt = (token = "token") => ({
    source: "native",
    roomId: "1234",
    sessionToken: token,
    snapshot: serverSnapshot,
    privateState: serverPrivate,
  });

  it("断线保留房间画面；重连后运行时带原凭据回座，展示态整体换成服务端全量", async () => {
    const { send, acks } = holdReconnect();
    const cleanup = initCEEWs();
    try {
      status(false);
      expect(useCEEStore.getState()).toMatchObject({
        connected: false,
        lobbyReady: false,
        roomId: "1234",
        sessionToken: "token",
      });
      expect(useCEEStore.getState().snapshot).toBe(snapshot);
      expect(useCEEStore.getState().privateState).toBe(privateState);

      status(true);
      expect(commands(send)).toEqual(["cee.lobby.subscribeRooms", "cee.room.reconnect"]);
      expect(send.mock.calls[1][1]).toEqual({ roomId: "1234", sessionToken: "token" });
      // 回座在途时仍是断线前的画面，不先清成占位。
      expect(useCEEStore.getState().snapshot).toBe(snapshot);
      acks[0].resolve(receipt());
      await vi.waitFor(() => expect(useCEEStore.getState().snapshot).toEqual(serverSnapshot));
      expect(useCEEStore.getState().privateState).toEqual(serverPrivate);
      expect(useCEEStore.getState().seatLostAt).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("回座途中再次断线：晚到的 ACK 不安装，下一次连上重新回座", async () => {
    const { send, acks } = holdReconnect();
    const cleanup = initCEEWs();
    try {
      status(false);
      status(true);
      status(false);
      acks[0].resolve(receipt("stale"));
      await Promise.resolve();
      await Promise.resolve();
      expect(useCEEStore.getState().snapshot).toBe(snapshot);
      expect(useCEEStore.getState().sessionToken).toBe("token");
      status(true);
      // 新一轮回座排在作废的那一轮落定之后才发出。
      await vi.waitFor(() => expect(acks).toHaveLength(2));
      acks[1].resolve(receipt("fresh"));
      await vi.waitFor(() => expect(useCEEStore.getState().sessionToken).toBe("fresh"));
      expect(useCEEStore.getState().snapshot).toEqual(serverSnapshot);
      expect(commands(send).filter((command) => command === "cee.room.leave")).toEqual([]);
      expect(useCEEStore.getState().seatLostAt).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("断线期间座位失效而房间还在：让出房间、清凭据，标记失座让房间页重新加入", async () => {
    const { acks } = holdReconnect();
    const cleanup = initCEEWs();
    try {
      status(false);
      status(true);
      acks[0].reject({ code: "SESSION_NOT_FOUND", message: "会话不存在" });
      await vi.waitFor(() => expect(useCEEStore.getState().seatLostAt).not.toBeNull());
      expect(useCEEStore.getState()).toMatchObject({
        roomId: null,
        snapshot: null,
        privateState: null,
        roomClosedAt: null,
      });
      expect(readCEESession("1234")).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("断线期间房间被关：重连回座得到房间不存在，标记关闭而非失座", async () => {
    const { acks } = holdReconnect();
    const cleanup = initCEEWs();
    try {
      status(false);
      status(true);
      acks[0].reject({ code: "ROOM_NOT_FOUND", message: "房间不存在" });
      await vi.waitFor(() => expect(useCEEStore.getState().roomClosedAt).not.toBeNull());
      expect(useCEEStore.getState()).toMatchObject({ roomId: null, snapshot: null });
      expect(useCEEStore.getState().seatLostAt).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("回座临时失败：让出房间但留着凭据，标记失座交给房间页重试", async () => {
    const { acks } = holdReconnect();
    const cleanup = initCEEWs();
    try {
      status(false);
      status(true);
      acks[0].reject({ code: "TIMEOUT", message: "请求超时" });
      await vi.waitFor(() => expect(useCEEStore.getState().seatLostAt).not.toBeNull());
      expect(useCEEStore.getState()).toMatchObject({ roomId: null, snapshot: null });
      expect(readCEESession("1234")).toBe("token");
    } finally {
      cleanup();
    }
  });

  it("断线期间主动退房：重连后不再回座", async () => {
    const { send } = holdReconnect();
    const cleanup = initCEEWs();
    try {
      status(false);
      await useCEEStore
        .getState()
        .leaveRoom()
        .catch(() => {});
      status(true);
      await Promise.resolve();
      expect(commands(send).filter((command) => command === "cee.room.reconnect")).toEqual([]);
      expect(useCEEStore.getState()).toMatchObject({ roomId: null, snapshot: null });
    } finally {
      cleanup();
    }
  });

  it("回座在途时房间被关：晚到 ACK 用结果凭据离房，停在关闭态", async () => {
    const { send, acks } = holdReconnect();
    const cleanup = initCEEWs();
    try {
      status(false);
      status(true);
      handleCEEMessage({ type: "event", event: "cee.room.closed", payload: { roomId: "1234" } });
      expect(useCEEStore.getState().roomClosedAt).not.toBeNull();
      acks[0].resolve(receipt("late"));
      await vi.waitFor(() => expect(commands(send)).toContain("cee.room.leave"));
      expect(useCEEStore.getState()).toMatchObject({ roomId: null, snapshot: null });
      expect(useCEEStore.getState().roomClosedAt).not.toBeNull();
      expect(useCEEStore.getState().seatLostAt).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("CEE 反作弊文案与旁观审批", () => {
  it("ceeErrorMessage 按错误码给出可归因文案，CLIENT_REQUIRED 附带下载地址", () => {
    expect(ceeErrorMessage({ code: "CLIENT_REQUIRED", message: "服务端原文" })).toContain(
      BAKA_CLIENT_DOWNLOAD_URL
    );
    expect(ceeErrorMessage({ code: "CLIENT_OUTDATED", message: "服务端原文" })).toContain(
      BAKA_CLIENT_DOWNLOAD_URL
    );
    expect(ceeErrorMessage({ code: "LOGIN_REQUIRED", message: "服务端原文" })).toBe(
      "该房间要求登录后再创建、加入或旁观"
    );
    // 未映射的错误码保留服务端原文，不做兜底改写。
    expect(ceeErrorMessage({ code: "ROOM_NOT_FOUND", message: "房间不存在" })).toBe("房间不存在");
  });

  it("reportError 触发提示，LOGIN_REQUIRED 顺带请求打开登录弹窗", () => {
    const before = useCEEStore.getState().requestLoginAt;
    useCEEStore.getState().reportError({ code: "LOGIN_REQUIRED", message: "服务端原文" });
    expect(useCEEStore.getState().toasts.at(-1)).toMatchObject({
      text: "该房间要求登录后再创建、加入或旁观",
      type: "error",
    });
    expect(useCEEStore.getState().requestLoginAt).toBeGreaterThan(before);
    // 非登录类错误不动登录弹窗时间戳。
    useCEEStore.getState().reportError({ code: "CLIENT_REQUIRED", message: "服务端原文" });
    expect(useCEEStore.getState().requestLoginAt).toBe(useCEEStore.getState().requestLoginAt);
    expect(useCEEStore.getState().toasts.at(-1)?.text).toContain(BAKA_CLIENT_DOWNLOAD_URL);
  });

  it("handleCEEMessage 消费 spectateResult：批准走成功提示，拒绝走错误提示", () => {
    handleCEEMessage({
      type: "event",
      event: "cee.player.spectateResult",
      payload: { approved: true },
    });
    expect(useCEEStore.getState().toasts.at(-1)).toMatchObject({
      text: "房主已同意旁观",
      type: "success",
    });
    handleCEEMessage({
      type: "event",
      event: "cee.player.spectateResult",
      payload: { approved: false },
    });
    expect(useCEEStore.getState().toasts.at(-1)).toMatchObject({
      text: "房主未同意旁观",
      type: "error",
    });
  });
});

describe("CEE 提示行为", () => {
  // 断言布局实际渲染的那份列表：同一句话连发是否重播入场，取决于其中的编号。
  const shownToasts = () => useCEEStore.getState().toasts;

  beforeEach(() => {
    vi.useFakeTimers();
    useCEEStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("不同提示并存，按发出先后排列", () => {
    const { showToast } = useCEEStore.getState();
    showToast("第一条");
    showToast("第二条", "error");
    expect(shownToasts().map((t) => [t.text, t.type])).toEqual([
      ["第一条", "info"],
      ["第二条", "error"],
    ]);
  });

  it("连续两条相同提示仍是一条，编号不变，重播一次", () => {
    const { showToast } = useCEEStore.getState();
    showToast("同一句");
    const first = shownToasts()[0];
    showToast("同一句");
    expect(shownToasts().map((t) => t.text)).toEqual(["同一句"]);
    expect(shownToasts()[0].id).toBe(first.id);
    expect(shownToasts()[0].repeat).toBe(1);
  });

  it("普通信息三秒、错误五秒到点消失", () => {
    const { showToast } = useCEEStore.getState();
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
    useCEEStore.getState().showToast("短提示", "error", 1000);
    vi.advanceTimersByTime(999);
    expect(shownToasts().map((t) => t.text)).toEqual(["短提示"]);
    vi.advanceTimersByTime(1);
    expect(shownToasts()).toEqual([]);
  });

  it("默认类型是普通信息", () => {
    useCEEStore.getState().showToast("默认类型");
    expect(shownToasts().map((t) => t.type)).toEqual(["info"]);
  });

  it("最多同时三条，再来新的最早一条让位", () => {
    const { showToast } = useCEEStore.getState();
    for (const text of ["一", "二", "三", "四"]) showToast(text);
    expect(shownToasts().map((t) => t.text)).toEqual(["二", "三", "四"]);
  });

  it("被移出房间的提示按默认五秒消失", () => {
    useCEEStore.setState({ roomId: "1234", sessionToken: "tok", snapshot });
    handleCEEMessage({ type: "event", event: "cee.player.kicked", payload: {} });
    expect(shownToasts().map((t) => [t.text, t.type])).toEqual([["你已被移出房间", "error"]]);
    vi.advanceTimersByTime(4999);
    expect(shownToasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(shownToasts()).toEqual([]);
  });
});

describe("CEE 聊天展示层续接历史", () => {
  const message = (id: string, createdAt: number, text = id) => ({
    id,
    playerId: "p1",
    playerName: "甲",
    text,
    createdAt,
    system: false,
  });
  const full = (state: CEERoomSnapshot, revision = 1) =>
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: { mode: "full", revision, state },
    });
  const shownChat = () => useCEEStore.getState().snapshot?.chat.map((entry) => entry.id);

  it("同房间的快照把服务端窗口续在本地历史后面，按 id 去重、按时间排序", () => {
    useCEEStore.setState({
      roomId: "1234",
      sessionToken: "tok",
      snapshot: { ...snapshot, chat: [message("a", 1), message("b", 2)] },
    });
    full({ ...snapshot, chat: [message("c", 3), message("b", 2, "改写")] });
    expect(shownChat()).toEqual(["a", "b", "c"]);
    // 同 id 以服务端最新为准。
    expect(useCEEStore.getState().snapshot?.chat[1].text).toBe("改写");
  });

  it("续接只在展示层：补丁仍按服务端窗口的下标落在原始基线上", () => {
    useCEEStore.setState({
      roomId: "1234",
      sessionToken: "tok",
      snapshot: { ...snapshot, chat: [message("a", 1)] },
    });
    full({ ...snapshot, chat: [message("b", 2), message("c", 3)] });
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: {
        mode: "patch",
        revision: 2,
        baseRevision: 1,
        operations: [{ op: "replace", path: "/chat/1/text", value: "补丁改的" }],
      },
    });
    expect(shownChat()).toEqual(["a", "b", "c"]);
    expect(useCEEStore.getState().snapshot?.chat[2].text).toBe("补丁改的");
  });

  it("换了房间不续上一间的聊天", () => {
    useCEEStore.setState({
      roomId: "1234",
      sessionToken: "tok",
      snapshot: { ...snapshot, roomId: "9999", chat: [message("old", 1)] },
    });
    full({ ...snapshot, chat: [message("new", 2)] });
    expect(shownChat()).toEqual(["new"]);
  });

  it("首次进入也守窗口上限：只留最近一段，原始基线不裁", () => {
    const many = Array.from({ length: CLIENT_CHAT_WINDOW + 5 }, (_, index) =>
      message(`m${index}`, index + 1)
    );
    useCEEStore.setState({ roomId: "1234", sessionToken: "tok" });
    full({ ...snapshot, chat: many });
    expect(shownChat()).toHaveLength(CLIENT_CHAT_WINDOW);
    expect(shownChat()?.[0]).toBe("m5");
    handleCEEMessage({
      type: "event",
      event: "cee.room.snapshot",
      payload: {
        mode: "patch",
        revision: 2,
        baseRevision: 1,
        operations: [
          { op: "replace", path: `/chat/${CLIENT_CHAT_WINDOW + 4}/text`, value: "最后一条" },
        ],
      },
    });
    expect(useCEEStore.getState().snapshot?.chat.at(-1)?.text).toBe("最后一条");
  });

  it("入房确认装上展示态时同样续接：断线回座后聊天接着断线前的历史", async () => {
    vi.spyOn(ceeWsClient, "send").mockResolvedValue({
      source: "native",
      roomId: "1234",
      sessionToken: "tok",
      snapshot: { ...snapshot, chat: [message("b", 2)] },
      privateState: ceePrivateState(),
    });
    writeCEESession("1234", "tok");
    useCEEStore.setState({
      roomId: "1234",
      sessionToken: "tok",
      snapshot: { ...snapshot, chat: [message("a", 1)] },
    });
    await useCEEStore.getState().reconnectRoom("1234");
    expect(shownChat()).toEqual(["a", "b"]);
  });

  it("入房确认换了房间时不续接", async () => {
    vi.spyOn(ceeWsClient, "send").mockResolvedValue({
      source: "native",
      roomId: "5678",
      sessionToken: "tok",
      snapshot: { ...snapshot, roomId: "5678", chat: [message("b", 2)] },
      privateState: ceePrivateState(),
    });
    useCEEStore.setState({
      roomId: "1234",
      sessionToken: "old",
      snapshot: { ...snapshot, chat: [message("a", 1)] },
    });
    await useCEEStore.getState().joinRoom("5678", "玩家");
    expect(shownChat()).toEqual(["b"]);
  });
});

describe("CEE 退房的时机", () => {
  const leaveAck = () => {
    const leave = deferred<Record<string, unknown>>();
    const send = vi.spyOn(ceeWsClient, "send").mockImplementation((command: string) => {
      if (command === "cee.room.leave") return leave.promise;
      if (command === "cee.room.join")
        return Promise.resolve({
          source: "native",
          roomId: "5678",
          sessionToken: "next-token",
          snapshot: { ...snapshot, roomId: "5678" },
          privateState: null,
        });
      return Promise.resolve({ originalAvailable: false });
    });
    return { leave, send };
  };
  const commands = (send: { mock: { calls: unknown[][] } }) =>
    send.mock.calls.map(([command]) => command);
  const seated = () => {
    writeCEESession("1234", "tok");
    useCEEStore.setState({ roomId: "1234", sessionToken: "tok", snapshot, privateState: null });
  };

  it("退房立刻让出本地房间，退房命令带离开前的身份", async () => {
    const { leave, send } = leaveAck();
    seated();
    const done = useCEEStore.getState().leaveRoom();
    expect(useCEEStore.getState()).toMatchObject({
      roomId: null,
      sessionToken: null,
      snapshot: null,
    });
    expect(readCEESession("1234")).toBeNull();
    expect(commands(send)).toEqual(["cee.room.leave"]);
    expect(send.mock.calls[0][2]).toMatchObject({ roomId: "1234", sessionToken: "tok" });
    leave.resolve({});
    await done;
  });

  it("退房在途时给出同一次退房；落定后不再有在途的退房", async () => {
    const { leave } = leaveAck();
    seated();
    expect(useCEEStore.getState().roomRelease()).toBeNull();
    const done = useCEEStore.getState().leaveRoom();
    expect(useCEEStore.getState().roomRelease()).toBe(done);
    leave.resolve({});
    await done;
    expect(useCEEStore.getState().roomRelease()).toBeNull();
  });

  it("退房在途时加入下一间要等退房落定，服务端不会撞上还没离开的座位", async () => {
    const { leave, send } = leaveAck();
    seated();
    const left = useCEEStore.getState().leaveRoom();
    const joined = useCEEStore.getState().joinRoom("5678", "玩家");
    await Promise.resolve();
    await Promise.resolve();
    expect(commands(send)).toEqual(["cee.room.leave"]);
    leave.resolve({});
    await left;
    await joined;
    expect(commands(send)).toEqual(["cee.room.leave", "cee.room.join"]);
    expect(useCEEStore.getState()).toMatchObject({ roomId: "5678", sessionToken: "next-token" });
  });

  it("退房失败也不耽误下一次入房", async () => {
    const { leave, send } = leaveAck();
    seated();
    const left = useCEEStore.getState().leaveRoom();
    const joined = useCEEStore.getState().joinRoom("5678", "玩家");
    leave.reject({ code: "NOT_CONNECTED", message: "WebSocket 未连接" });
    await expect(left).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    await joined;
    expect(commands(send)).toEqual(["cee.room.leave", "cee.room.join"]);
  });

  it("退房在途时订阅大厅要等退房落定", async () => {
    const { leave, send } = leaveAck();
    seated();
    const left = useCEEStore.getState().leaveRoom();
    const subscribed = useCEEStore.getState().subscribeLobby();
    await Promise.resolve();
    await Promise.resolve();
    expect(commands(send)).toEqual(["cee.room.leave"]);
    leave.resolve({});
    await left;
    await subscribed;
    expect(commands(send)).toEqual(["cee.room.leave", "cee.lobby.subscribeRooms"]);
  });

  it("退房作废在途入房：晚到的 ACK 不把刚离开的房间写回本地", async () => {
    const ack = deferred<Record<string, unknown>>();
    const send = vi
      .spyOn(ceeWsClient, "send")
      .mockImplementation((command: string) =>
        command === "cee.room.reconnect" ? ack.promise : Promise.resolve({})
      );
    seated();
    const restoring = useCEEStore
      .getState()
      .reconnectRoom("1234")
      .catch((error) => error);
    await useCEEStore.getState().leaveRoom();
    ack.resolve({
      source: "native",
      roomId: "1234",
      sessionToken: "late",
      snapshot,
      privateState: null,
    });
    expect(await restoring).toMatchObject({ name: "AbortError" });
    expect(useCEEStore.getState()).toMatchObject({ roomId: null, snapshot: null });
    expect(
      send.mock.calls.filter(
        ([command, , options]) =>
          command === "cee.room.leave" &&
          (options as { sessionToken?: string }).sessionToken === "late"
      )
    ).toHaveLength(1);
  });
});
