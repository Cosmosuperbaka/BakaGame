import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultCCBSettings, type CCBRoomSnapshot } from "@bakagame/shared";
import { ccbWs } from "@/lib/CCBWs";
import { handleCCBMessage, resetCCBStateSync, useCCBStore } from "./UseCCBStore";

const snapshot: CCBRoomSnapshot = {
  roomId: "1234", source: "native", name: "测试", visibility: "public", hasPassword: false,
  allowSpectators: true, hostPlayerId: "p1", phase: "waiting", settings: createDefaultCCBSettings(),
  players: [], roundNumber: 0, syncRound: 0, setterPlayerId: null, phaseDeadlineAt: null,
  chat: [], roundSummary: null, upstreamConnected: true,
};

afterEach(() => { resetCCBStateSync(); useCCBStore.getState().resetRoom(); vi.restoreAllMocks(); });

describe("CCB 状态同步", () => {
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
});
