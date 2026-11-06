import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  send: vi.fn<(type: string, payload: Record<string, unknown>) => Promise<unknown>>(async () => ({
    subscribed: true,
  })),
  connect: vi.fn(),
  disconnect: vi.fn(),
  exchange: vi.fn(async () => ({ ok: true })),
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
    exchangeOnOpenSocket: state.exchange,
    connect: state.connect,
    // 与服务端实现一致：主动断开同样会通知状态回调。
    disconnect: () => {
      state.disconnect();
      for (const handler of [...state.statuses]) handler(false);
    },
  }),
}));

import { closePageControl, connectSiteSocket, getSiteLinkConnected, onPageCommand } from "./SiteWs";
import { getSiteAgents, resetSiteAgents } from "@/stores/UseSiteAgents";
import {
  clearPageNotice,
  getPageControl,
  resetPageControl,
  usePageNotice,
} from "@/stores/UsePageControl";
import { renderHook } from "@testing-library/react";

const activity = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  agentName: "BakaAgent",
  tool: "visit_page",
  kind: "site",
  page: "/abouts",
  at: 1_700_000_000_000,
  ...overrides,
});

/** 服务端事件交给站点通道：Agent 活动写 store，页面租约与指令走各自的出口。 */
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

  it("收回页面接管不动共享连接：断线由链路自己决定，不由接管状态推断", () => {
    emit("site.agents", { agents: [activity("a")] });
    for (const handler of state.statuses) handler(true);
    expect(getSiteLinkConnected()).toBe(true);

    // 租约失效（页面刷新、配对码过期）只清展示状态，连接与订阅保持不变：
    // 服务端按连接统计在线，摘监听或断连都会让首页指示凭空消失。
    emit("site.page.lease", { controlled: false });

    expect(state.disconnect).not.toHaveBeenCalled();
    expect(getSiteLinkConnected()).toBe(true);
    expect(getSiteAgents()).toHaveLength(1);
  });

  it("收到身份探测立即应答：另一条连接在问本页还开不开着", () => {
    emit("site.session.probe", { nonce: "nonce-1" });
    expect(state.exchange).toHaveBeenCalledWith("site.session.alive", { nonce: "nonce-1" });
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

describe("标签页接管的连接状态", () => {
  const status = (connected: boolean) => {
    for (const handler of [...state.statuses]) handler(connected);
  };
  const notice = () => renderHook(() => usePageNotice()).result.current?.text;
  const subscribeAck = (controlled: boolean) =>
    state.send.mockImplementation(async (type) =>
      type === "site.subscribe" ? { subscribed: true, controlled } : { ok: true }
    );
  const flush = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers();
    resetPageControl();
    clearPageNotice();
  });

  afterEach(() => {
    vi.useRealTimers();
    state.send.mockReset();
    state.send.mockResolvedValue({ subscribed: true });
  });

  it("断线后保持锁定等身份回来，续上后恢复，不让人类突然接手", async () => {
    subscribeAck(true);
    const stop = connectSiteSocket();
    emit("site.page.lease", { controlled: true, agentName: "BakaAgent" });

    status(false);
    expect(getPageControl()).toMatchObject({ status: "controlled", reconnecting: true });

    status(true);
    emit("site.page.lease", { controlled: true, agentName: "BakaAgent", resumed: true });
    await flush();
    expect(getPageControl().status).toBe("controlled");
    expect(getPageControl().reconnecting).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getPageControl().status).toBe("controlled");
    stop();
  });

  it("重连后服务端已没有这份租约时当场解锁并说明原因", async () => {
    subscribeAck(false);
    const stop = connectSiteSocket();
    emit("site.page.lease", { controlled: true, agentName: "BakaAgent" });
    status(false);
    status(true);
    await flush();
    expect(getPageControl().status).toBe("off");
    expect(notice()).toBe("连接中断，接管已结束");
    stop();
  });

  it("一直连不上时到点解锁，不把人类永远锁在页面外", async () => {
    emit("site.page.lease", { controlled: true, agentName: "BakaAgent" });
    status(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getPageControl().status).toBe("off");
    expect(notice()).toBe("连接中断，接管已结束");
  });

  it("配对码随连接作废：还没认领时断线直接清掉", () => {
    emit("site.page.lease", { controlled: false });
    status(false);
    expect(getPageControl().status).toBe("off");
  });

  it("人类收回不等回执；断线时点的收回在续上后补发", async () => {
    emit("site.page.lease", { controlled: true, agentName: "BakaAgent" });
    status(false);
    state.send.mockRejectedValueOnce(new Error("offline"));
    await closePageControl();
    expect(getPageControl().status).toBe("off");

    state.send.mockClear();
    state.send.mockResolvedValue({ ok: true });
    emit("site.page.lease", { controlled: true, agentName: "BakaAgent", resumed: true });
    await flush();
    expect(getPageControl().status).toBe("off");
    expect(state.send).toHaveBeenCalledWith("site.page.close", {});
  });

  it("Agent 断开、交还、超时都告诉人类发生了什么", () => {
    for (const [reason, text] of [
      ["agent_left", "BakaAgent 已断开，页面已解锁"],
      ["released", "BakaAgent 已交还控制"],
      ["expired", "BakaAgent 长时间没有动作，已自动收回"],
    ] as const) {
      emit("site.page.lease", { controlled: true, agentName: "BakaAgent" });
      emit("site.page.lease", { controlled: false, reason });
      expect(getPageControl().status).toBe("off");
      expect(notice()).toBe(text);
    }
  });

  it("只有接管中才执行指令，未知动作一律丢弃", () => {
    const handler = vi.fn();
    const stop = onPageCommand(handler);
    const command = { id: "1", action: "click", control: "x" };
    emit("site.page.command", command);
    expect(handler).not.toHaveBeenCalled();

    emit("site.page.lease", { controlled: true, agentName: "BakaAgent" });
    emit("site.page.command", { id: "2", action: "eval" });
    expect(handler).not.toHaveBeenCalled();
    emit("site.page.command", command);
    expect(handler).toHaveBeenCalledTimes(1);
    stop();
  });
});
