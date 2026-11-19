import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/Sentry", () => ({
  captureClientLog: vi.fn(),
  captureClientException: vi.fn(),
  countClientMetric: vi.fn(),
  recordClientMetric: vi.fn(),
  withClientSpan: async (_name: string, callback: (span: unknown) => unknown) =>
    callback({
      setStatus: () => {},
      setAttribute: () => {},
      spanContext: () => ({ traceId: "0af7651916cd43dd8448eb211c80319c" }),
    }),
}));

import { WebSocketClient } from "./WebsocketClient";
import {
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MIN_INTERVAL_MS,
  RECONNECT_STABLE_MS,
  MAX_RECONNECT_DELAY_MS,
} from "@/config/Constants";
import { FakeSocket, setVisibility } from "@/test/FakeWebSocket";

const created: WebSocketClient[] = [];
const track = (client: WebSocketClient) => {
  created.push(client);
  return client;
};

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  // 模块里的客户端登记表跨用例存活：不收掉，上一个用例排定的重连会被本用例的联网事件拉起。
  for (const client of created.splice(0)) client.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setVisibility("visible");
});

describe("重连策略", () => {
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  /** 让连接建立后立即被服务端关闭，返回这次关闭之后排定的重连延迟下界探测所需信息。 */
  const dropCurrent = () => FakeSocket.instances.at(-1)!.finishClose();

  it("退避带抖动：延迟落在 [下限, 当前上限] 内，随随机数变化", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random");
    const client = track(new WebSocketClient("/api/ws"));
    client.connect();

    // 随机数取 0.5：第一次重连延迟应为上限（BASE）的一半，而不是固定的 BASE。
    random.mockReturnValue(0.5);
    dropCurrent();
    await advance(RECONNECT_BASE_DELAY_MS * 0.5 - 1);
    expect(FakeSocket.instances).toHaveLength(1);
    await advance(1);
    expect(FakeSocket.instances).toHaveLength(2);

    // 随机数取接近 1：延迟逼近第二档上限，不会超过它。
    random.mockReturnValue(0.999);
    dropCurrent();
    await advance(RECONNECT_BASE_DELAY_MS * 2 - 1);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it("退避有下限且逐级增长到上限封顶", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.9999);
    const client = track(new WebSocketClient("/api/ws"));
    client.connect();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = FakeSocket.instances.length;
      dropCurrent();
      let elapsed = 0;
      while (FakeSocket.instances.length === before && elapsed < MAX_RECONNECT_DELAY_MS * 2) {
        await advance(10);
        elapsed += 10;
      }
      delays.push(elapsed);
    }
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]).toBeGreaterThanOrEqual(delays[index - 1] - 10);
    }
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_RECONNECT_DELAY_MS + 10);
    expect(delays.at(-1)).toBeGreaterThanOrEqual(MAX_RECONNECT_DELAY_MS - 10);

    // 随机数取 0：仍有下限，不会出现零延迟的紧密重连。
    vi.spyOn(Math, "random").mockReturnValue(0);
    const before = FakeSocket.instances.length;
    dropCurrent();
    await advance(0);
    expect(FakeSocket.instances).toHaveLength(before);
  });

  it("握手成功后立刻被断开不清零退避：紧接着的重连延迟继续增长", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.9999);
    const client = track(new WebSocketClient("/api/ws"));
    client.connect();

    // 第 1 次：断开后等一个基础延迟，重连并握手成功，但马上又被断开。
    dropCurrent();
    await advance(RECONNECT_BASE_DELAY_MS);
    FakeSocket.instances.at(-1)!.open();
    await advance(1_000);
    dropCurrent();

    // 若握手成功就清零，这次延迟仍是 BASE；实际应已升到下一档（2 倍）。
    await advance(RECONNECT_BASE_DELAY_MS + 50);
    expect(FakeSocket.instances).toHaveLength(2);
    await advance(RECONNECT_BASE_DELAY_MS);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it("连接稳定存活足够久之后才清零退避", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.9999);
    const client = track(new WebSocketClient("/api/ws"));
    client.connect();
    for (let round = 0; round < 3; round += 1) {
      const before = FakeSocket.instances.length;
      dropCurrent();
      await advance(MAX_RECONNECT_DELAY_MS);
      expect(FakeSocket.instances).toHaveLength(before + 1);
    }
    FakeSocket.instances.at(-1)!.open();
    await advance(RECONNECT_STABLE_MS + 10);

    const before = FakeSocket.instances.length;
    dropCurrent();
    await advance(RECONNECT_BASE_DELAY_MS);
    expect(FakeSocket.instances).toHaveLength(before + 1);
  });

  it("页面回到前台时立即重连，但受最小间隔约束", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.9999);
    const client = track(new WebSocketClient("/api/ws"));
    client.connect();
    for (let round = 0; round < 4; round += 1) {
      dropCurrent();
      await advance(MAX_RECONNECT_DELAY_MS);
    }
    // 现在退避已升到上限；再断一次，等一会儿后回到前台。
    const before = FakeSocket.instances.length;
    await advance(RECONNECT_MIN_INTERVAL_MS + 10);
    dropCurrent();
    await advance(RECONNECT_MIN_INTERVAL_MS + 10);
    expect(FakeSocket.instances).toHaveLength(before);

    setVisibility("hidden");
    await advance(0);
    expect(FakeSocket.instances).toHaveLength(before);
    setVisibility("visible");
    await advance(0);
    expect(FakeSocket.instances).toHaveLength(before + 1);
  });

  it("联网恢复事件立即重连；距上次尝试不足最小间隔时顺延到间隔届满", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.9999);
    const client = track(new WebSocketClient("/api/ws"));
    client.connect();
    const attempts = FakeSocket.instances.length;
    // 刚尝试过就失败：此刻联网恢复不能立刻再打一次。
    dropCurrent();
    window.dispatchEvent(new Event("online"));
    await advance(RECONNECT_MIN_INTERVAL_MS - 10);
    expect(FakeSocket.instances).toHaveLength(attempts);
    await advance(10);
    expect(FakeSocket.instances).toHaveLength(attempts + 1);
  });

  it("主动断开之后，联网与前台事件不会把连接重新拉起", async () => {
    vi.useFakeTimers();
    const client = track(new WebSocketClient("/api/ws"));
    client.connect();
    FakeSocket.instances[0].open();
    client.disconnect();
    window.dispatchEvent(new Event("online"));
    setVisibility("visible");
    await advance(MAX_RECONNECT_DELAY_MS * 2);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("连接正常时联网与前台事件不做任何事", async () => {
    vi.useFakeTimers();
    const client = track(new WebSocketClient("/api/ws"));
    client.connect();
    FakeSocket.instances[0].open();
    window.dispatchEvent(new Event("online"));
    setVisibility("visible");
    await advance(MAX_RECONNECT_DELAY_MS);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
