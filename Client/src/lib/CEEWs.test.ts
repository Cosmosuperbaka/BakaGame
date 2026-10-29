import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  send: vi.fn(),
  refreshIdentity: vi.fn(),
  waitForConnection: vi.fn(),
  isBakaClient: vi.fn(() => true),
  lastHandshakeHadTicket: vi.fn(() => false),
  waitForChannelTicket: vi.fn(async () => true),
}));

vi.mock("@/lib/WebsocketClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/WebsocketClient")>();
  return {
    ...actual,
    createWebSocketClient: () => ({
      send: state.send,
      refreshIdentity: state.refreshIdentity,
      waitForConnection: state.waitForConnection,
    }),
  };
});

vi.mock("@/lib/BakaChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/BakaChannel")>();
  return {
    ...actual,
    bakaChannelQuery: () => "",
    isBakaClient: state.isBakaClient,
    lastHandshakeHadTicket: state.lastHandshakeHadTicket,
    waitForChannelTicket: state.waitForChannelTicket,
  };
});

import { ceeWsClient } from "./CEEWs";

const refused = { code: "CLIENT_REQUIRED", message: "服务端原文" };

beforeEach(() => {
  vi.clearAllMocks();
  state.isBakaClient.mockReturnValue(true);
  state.lastHandshakeHadTicket.mockReturnValue(false);
  state.waitForChannelTicket.mockResolvedValue(true);
  state.waitForConnection.mockResolvedValue(undefined);
});

describe("CEE 客户端通道补偿", () => {
  it("建连时没带上票：建房前先换票重连，再发建房命令", async () => {
    // 第一次判断没有票，换票重连后的复查有票。
    state.lastHandshakeHadTicket.mockReturnValueOnce(false).mockReturnValue(true);
    state.send.mockResolvedValue({ roomId: "123456" });

    await ceeWsClient.send("cee.room.create", { bakaAntiCheat: true });

    expect(state.waitForChannelTicket).toHaveBeenCalledTimes(1);
    expect(state.refreshIdentity).toHaveBeenCalledTimes(1);
    expect(state.waitForConnection).toHaveBeenCalledTimes(1);
    expect(state.send).toHaveBeenCalledTimes(1);
  });
  it("服务端拒绝票据：换票重连后重试一次", async () => {
    state.lastHandshakeHadTicket.mockReturnValue(true);
    state.send.mockRejectedValueOnce(refused).mockResolvedValueOnce({ roomId: "123456" });

    await expect(ceeWsClient.send("cee.room.create", { bakaAntiCheat: true })).resolves.toMatchObject({
      roomId: "123456",
    });
    expect(state.refreshIdentity).toHaveBeenCalledTimes(1);
    expect(state.send).toHaveBeenCalledTimes(2);
  });
  it("重试仍被拒：换成可重试的通道未就绪，而不是笼统的 CLIENT_REQUIRED", async () => {
    state.lastHandshakeHadTicket.mockReturnValue(true);
    state.send.mockRejectedValue(refused);

    await expect(ceeWsClient.send("cee.room.join", { userName: "玩家" })).rejects.toMatchObject({
      code: "CLIENT_CHANNEL_NOT_READY",
    });
    expect(state.send).toHaveBeenCalledTimes(2);
  });
  it("壳签不出票：不发注定被拒的建房请求", async () => {
    state.waitForChannelTicket.mockResolvedValue(false);

    await expect(ceeWsClient.send("cee.room.create", { bakaAntiCheat: true })).rejects.toMatchObject({
      code: "CLIENT_CHANNEL_NOT_READY",
    });
    expect(state.refreshIdentity).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
  });
  it("普通建房完全不走通道补偿", async () => {
    state.send.mockResolvedValue({ roomId: "123456" });

    await ceeWsClient.send("cee.room.create", {});
    expect(state.waitForChannelTicket).not.toHaveBeenCalled();
    expect(state.refreshIdentity).not.toHaveBeenCalled();
    expect(state.send).toHaveBeenCalledTimes(1);
  });
});
