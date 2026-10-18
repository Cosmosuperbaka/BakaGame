import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultCEESettings, type CEERoomSnapshot } from "@bakagame/shared";
import { ceeWs } from "@/lib/CEEWs";
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

afterEach(() => {
  resetCEEStateSync();
  useCEEStore.getState().resetRoom();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("CEE 状态同步", () => {
  it("原版会话过期后删除旧凭据并允许重新加入", async () => {
    writeCEESession("1234", "expired");
    const send = vi
      .spyOn(ceeWs, "send")
      .mockRejectedValue({ code: "SESSION_EXPIRED", message: "会话已过期" });
    await expect(useCEEStore.getState().reconnectRoom("1234")).resolves.toBe(false);
    expect(readCEESession("1234")).toBeNull();
    await expect(useCEEStore.getState().reconnectRoom("1234")).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("重建连接只订阅大厅并等待页面恢复，卸载释放连接且保留刷新凭据", async () => {
    let status: (connected: boolean) => void = () => {};
    vi.spyOn(ceeWs, "onStatus").mockImplementation((handler) => {
      status = handler;
      return () => {};
    });
    vi.spyOn(ceeWs, "connect").mockImplementation(() => {});
    const disconnect = vi.spyOn(ceeWs, "disconnect").mockImplementation(() => status(false));
    const send = vi.spyOn(ceeWs, "send").mockResolvedValue({ originalAvailable: false });
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
        snapshot: null,
      });
      status(true);
      await vi.waitFor(() => expect(useCEEStore.getState().lobbyReady).toBe(true));
      expect(send.mock.calls.map(([command]) => command)).toEqual(["cee.lobby.subscribeRooms"]);
    } finally {
      cleanup();
    }
    expect(disconnect).toHaveBeenCalledOnce();
    expect(readCEESession("1234")).toBe("token");
    expect(useCEEStore.getState()).toMatchObject({
      connected: false,
      lobbyReady: false,
      roomId: null,
    });
  });

  it("受服务端计时的角色与图片请求不受短客户端超时截断", async () => {
    const send = vi.spyOn(ceeWs, "send").mockResolvedValue({});
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
    const send = vi.spyOn(ceeWs, "send").mockResolvedValue({ results: [] });
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
    const send = vi.spyOn(ceeWs, "send").mockResolvedValue({});
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
    vi.spyOn(ceeWs, "send").mockImplementation(
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
it("取消加入的晚到 ACK 使用结果凭据离房，不写入新会话", async () => {
  let resolve!: (value: Record<string, unknown>) => void;
  const ack = new Promise<Record<string, unknown>>((done) => {
    resolve = done;
  });
  const send = vi.spyOn(ceeWs, "send").mockReturnValueOnce(ack).mockResolvedValue({});
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
  const send = vi.spyOn(ceeWs, "send");
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
    .spyOn(ceeWs, "send")
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
  const send = vi.spyOn(ceeWs, "send").mockReturnValueOnce(ack);
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
    .spyOn(ceeWs, "send")
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

describe("CEE 反作弊文案与旁观审批", () => {
  it("ceeErrorMessage 按错误码给出可归因文案，CLIENT_REQUIRED 附带下载地址", () => {
    expect(ceeErrorMessage({ code: "CLIENT_REQUIRED", message: "服务端原文" })).toContain(
      BAKA_CLIENT_DOWNLOAD_URL
    );
    expect(ceeErrorMessage({ code: "CLIENT_OUTDATED", message: "服务端原文" })).toContain(
      BAKA_CLIENT_DOWNLOAD_URL
    );
    expect(ceeErrorMessage({ code: "ANTI_CHEAT_BLOCKED", message: "服务端原文" })).toBe(
      "请先让 Web 接入或未登录的玩家退出"
    );
    expect(ceeErrorMessage({ code: "LOGIN_REQUIRED", message: "服务端原文" })).toBe(
      "该房间要求登录后再加入或旁观"
    );
    // 未映射的错误码保留服务端原文，不做兜底改写。
    expect(ceeErrorMessage({ code: "ROOM_NOT_FOUND", message: "房间不存在" })).toBe("房间不存在");
  });

  it("reportError 触发提示，LOGIN_REQUIRED 顺带请求打开登录弹窗", () => {
    const before = useCEEStore.getState().requestLoginAt;
    useCEEStore.getState().reportError({ code: "LOGIN_REQUIRED", message: "服务端原文" });
    expect(useCEEStore.getState().notice?.text).toBe("该房间要求登录后再加入或旁观");
    expect(useCEEStore.getState().requestLoginAt).toBeGreaterThan(before);
    // 非登录类错误不动登录弹窗时间戳。
    useCEEStore.getState().reportError({ code: "CLIENT_REQUIRED", message: "服务端原文" });
    expect(useCEEStore.getState().requestLoginAt).toBe(useCEEStore.getState().requestLoginAt);
    expect(useCEEStore.getState().notice?.text).toContain(BAKA_CLIENT_DOWNLOAD_URL);
  });

  it("handleCEEMessage 消费 spectateResult：批准走成功提示，拒绝走错误提示", () => {
    handleCEEMessage({
      type: "event",
      event: "cee.player.spectateResult",
      payload: { approved: true },
    });
    expect(useCEEStore.getState().notice).toMatchObject({
      text: "房主已同意旁观",
      type: "success",
    });
    handleCEEMessage({
      type: "event",
      event: "cee.player.spectateResult",
      payload: { approved: false },
    });
    expect(useCEEStore.getState().notice).toMatchObject({
      text: "房主未同意旁观",
      type: "error",
    });
  });
});
