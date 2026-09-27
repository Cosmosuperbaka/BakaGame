import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultCCBSettings, type CCBRoomSnapshot } from "@bakagame/shared";
import { ccbWs } from "@/lib/CCBWs";
import { handleCCBMessage, initCCBWs, resetCCBStateSync, useCCBStore } from "./UseCCBStore";
import { readCCBSession, writeCCBSession } from "@/lib/CCBSession";

const snapshot: CCBRoomSnapshot = {
  roomId: "1234", source: "native", name: "测试", visibility: "public", hasPassword: false,
  allowSpectators: true, hostPlayerId: "p1", phase: "waiting", settings: createDefaultCCBSettings(),
  players: [], roundNumber: 0, syncRound: 0, setterPlayerId: null, phaseDeadlineAt: null,
  chat: [], roundSummary: null, upstreamConnected: true,
};

afterEach(() => { resetCCBStateSync(); useCCBStore.getState().resetRoom(); sessionStorage.clear(); vi.restoreAllMocks(); });

describe("CCB 状态同步", () => {
  it("原版会话过期后删除旧凭据并允许重新加入", async () => {
    writeCCBSession("1234", "expired");
    const send = vi.spyOn(ccbWs, "send").mockRejectedValue({ code: "SESSION_EXPIRED", message: "会话已过期" });
    await expect(useCCBStore.getState().reconnectRoom("1234")).resolves.toBe(false);
    expect(readCCBSession("1234")).toBeNull();
    await expect(useCCBStore.getState().reconnectRoom("1234")).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("重建连接只订阅大厅并等待页面恢复，卸载释放连接且保留刷新凭据", async () => {
    let status: (connected: boolean) => void = () => {};
    vi.spyOn(ccbWs, "onStatus").mockImplementation((handler) => { status = handler; return () => {}; });
    vi.spyOn(ccbWs, "connect").mockImplementation(() => {});
    const disconnect = vi.spyOn(ccbWs, "disconnect").mockImplementation(() => status(false));
    const send = vi.spyOn(ccbWs, "send").mockResolvedValue({ originalAvailable: false });
    writeCCBSession("1234", "token");
    useCCBStore.setState({ source: "native", roomId: "1234", sessionToken: "token", snapshot, lobbyReady: true });
    const cleanup = initCCBWs();
    try {
      status(false);
      expect(useCCBStore.getState()).toMatchObject({ connected: false, lobbyReady: false, snapshot: null });
      status(true);
      await vi.waitFor(() => expect(useCCBStore.getState().lobbyReady).toBe(true));
      expect(send.mock.calls.map(([command]) => command)).toEqual(["ccb.lobby.subscribeRooms"]);
    } finally { cleanup(); }
    expect(disconnect).toHaveBeenCalledOnce();
    expect(readCCBSession("1234")).toBe("token");
    expect(useCCBStore.getState()).toMatchObject({ connected: false, lobbyReady: false, roomId: null });
  });

  it("受服务端计时的角色与图片请求不受短客户端超时截断", async () => {
    const send = vi.spyOn(ccbWs, "send").mockResolvedValue({});
    const store = useCCBStore.getState();
    await store.sendCommand("ccb.game.next", {});
    await store.sendCommand("ccb.game.setAnswer", { characterId: 1, hints: [] });
    await store.sendCommand("ccb.game.imageHint", {});
    await store.sendCommand("ccb.character.image", { characterId: 1 });
    expect(send.mock.calls.map(([, , options]) => options?.timeout)).toEqual([0, 0, 0, 0]);
  });

  it("使用服务端原始基线应用聊天补丁", () => {
    handleCCBMessage({ type: "event", event: "ccb.room.snapshot", payload: { mode: "full", revision: 1, state: snapshot } });
    handleCCBMessage({ type: "event", event: "ccb.room.snapshot", payload: {
      mode: "patch", revision: 2, baseRevision: 1,
      operations: [{ op: "add", path: "/chat/0", value: { id: "m1", playerId: "p1", playerName: "甲", text: "你好", createdAt: 1, system: false } }],
    } });
    expect(useCCBStore.getState().snapshot?.chat.map((entry) => entry.text)).toEqual(["你好"]);
    expect(snapshot.chat).toEqual([]);
  });

  it("发现补丁缺口时请求全量且不覆盖现有房态", async () => {
    const send = vi.spyOn(ccbWs, "send").mockResolvedValue({});
    handleCCBMessage({ type: "event", event: "ccb.room.snapshot", payload: { mode: "full", revision: 1, state: snapshot } });
    handleCCBMessage({ type: "event", event: "ccb.room.snapshot", payload: {
      mode: "patch", revision: 4, baseRevision: 3, operations: [{ op: "replace", path: "/name", value: "错误状态" }],
    } });
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith("ccb.room.requestSync", {}, expect.any(Object));
    expect(useCCBStore.getState().snapshot?.name).toBe("测试");
  });

  /**
   * 服务端建立会话后会**先推快照事件、再回进入房间的 ACK**。若在此期间抢发全量同步，
   * 信封不带凭据，原版会话校验必然判 `SESSION_INVALID`——该错误又会被当成永久错误，
   * 把刚建立的原版会话清掉，表现为「加入原版房间失败」。
   */
  it("进入原版房间期间不抢发同步，凭据写回后补一次全量", async () => {
    const calls: Array<{ command: string; options?: { sessionToken?: string } }> = [];
    vi.spyOn(ccbWs, "send").mockImplementation((command: string, _payload?: unknown, options?: { sessionToken?: string }) => {
      calls.push({ command, options });
      if (command === "ccb.room.join") {
        // 复刻服务端顺序：快照先到（此时凭据尚未写回），ACK 后到。
        handleCCBMessage({ type: "event", event: "ccb.room.snapshot", payload: {
          mode: "patch", revision: 5, baseRevision: 4, operations: [{ op: "replace", path: "/name", value: "新名" }],
        } });
        handleCCBMessage({ type: "event", event: "ccb.game.privateState", payload: {
          mode: "patch", revision: 5, baseRevision: 4, operations: [{ op: "replace", path: "/playerId", value: "p9" }],
        } });
        return Promise.resolve({ roomId: "1234", source: "original", sessionToken: "tok-original",
          snapshot: { ...snapshot, source: "original" }, privateState: { playerId: "p1" } });
      }
      return Promise.resolve({});
    });

    await useCCBStore.getState().joinRoom("1234", "甲");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const duringJoin = calls.filter((call) => call.command === "ccb.room.requestSync" && !call.options?.sessionToken);
    expect(duringJoin).toEqual([]);
    const deferred = calls.filter((call) => call.command === "ccb.room.requestSync");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.options?.sessionToken).toBe("tok-original");
  });
});
