import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  send: vi.fn<(type: string, payload: Record<string, unknown>) => Promise<unknown>>(async () => ({
    subscribed: true,
  })),
  connect: vi.fn(),
  disconnect: vi.fn(),
  messages: [] as Array<(message: never) => void>,
  statuses: [] as Array<(connected: boolean) => void>,
}));

vi.mock("@/lib/WebsocketClient", () => ({
  createWebSocketClient: () => ({
    onMessage: (handler: (message: never) => void) => {
      state.messages.push(handler);
      return () => undefined;
    },
    onStatus: (handler: (connected: boolean) => void) => {
      state.statuses.push(handler);
      return () => {
        state.statuses = state.statuses.filter((entry) => entry !== handler);
      };
    },
    send: state.send,
    connect: state.connect,
    // 与服务端实现一致：主动断开同样会通知状态回调。
    disconnect: () => {
      state.disconnect();
      for (const handler of [...state.statuses]) handler(false);
    },
  }),
}));

import { connectSiteSocket, disconnectSiteSocket, getSiteLinkConnected } from "./SiteWs";
import { getSiteAgents, resetSiteAgents } from "@/stores/UseSiteAgents";

const activity = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  agentName: "BakaAgent",
  tool: "visit_page",
  kind: "site",
  page: "/abouts",
  at: 1_700_000_000_000,
  ...overrides,
});

/** 服务端事件交给站点通道：`site.*` 三类事件各写一次 store。 */
const emit = (event: string, payload: unknown) => {
  for (const handler of state.messages) handler({ type: "event", event, payload } as never);
};

/** 模块加载时就登记了一条「同步连接状态」的回调，清理只回退到这条基线。 */
const BASE_STATUSES = state.statuses.length;

beforeEach(() => {
  state.send.mockClear();
  state.connect.mockClear();
  state.disconnect.mockClear();
  state.statuses.length = BASE_STATUSES;
});

afterEach(() => {
  resetSiteAgents();
});

describe("站点通道", () => {
  it("首页即连：connectSiteSocket 建连后立刻补发订阅", () => {
    const stop = connectSiteSocket();
    expect(state.connect).toHaveBeenCalledTimes(1);
    // 订阅必须挂在「已连接」之后：链路没通就发，服务端收不到也回不了快照。
    expect(state.send).not.toHaveBeenCalled();
    for (const handler of state.statuses) handler(true);
    expect(state.send).toHaveBeenCalledWith("site.subscribe", {});
    stop();
  });

  it("断线重连会重新订阅：服务端的订阅记在这条连接上，断开即失效", () => {
    const stop = connectSiteSocket();
    for (const handler of state.statuses) handler(true);
    for (const handler of state.statuses) handler(false);
    for (const handler of state.statuses) handler(true);
    expect(state.send).toHaveBeenCalledTimes(2);
    stop();
  });

  it("解绑后不再补发订阅，但共享连接本身不受影响", () => {
    const stop = connectSiteSocket();
    for (const handler of state.statuses) handler(true);
    stop();
    expect(state.statuses).toHaveLength(BASE_STATUSES);
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it("关掉首页连接会真的断开，并清空首页的 Agent 指示", () => {
    emit("site.agents", { agents: [activity("a")] });
    for (const handler of state.statuses) handler(true);
    expect(getSiteLinkConnected()).toBe(true);

    disconnectSiteSocket();

    // 只摘监听不关连接，服务端仍会把这条连接算作在线。
    expect(state.disconnect).toHaveBeenCalledTimes(1);
    expect(getSiteLinkConnected()).toBe(false);
    expect(getSiteAgents()).toEqual([]);
  });

  it("快照覆盖、焦点增量、离开删除，三类事件都只留在站点 store 里", () => {
    emit("site.agents", { agents: [activity("a"), activity("b", { kind: "lobby" })] });
    expect(getSiteAgents().map((agent) => agent.id)).toEqual(["a", "b"]);

    emit("site.agent", activity("a", { page: "/cee" }));
    expect(getSiteAgents().filter((agent) => agent.id === "a")[0]?.page).toBe("/cee");
    expect(getSiteAgents()).toHaveLength(2);

    emit("site.agent.left", { id: "b" });
    expect(getSiteAgents().map((agent) => agent.id)).toEqual(["a"]);
  });

  it("非 event 帧与畸形快照不会污染列表", () => {
    emit("site.agents", { agents: [activity("a")] });
    for (const handler of state.messages) handler({ type: "ack", id: "x" } as never);
    emit("site.agents", { agents: "not-an-array" });
    expect(getSiteAgents()).toEqual([]);
  });
});
