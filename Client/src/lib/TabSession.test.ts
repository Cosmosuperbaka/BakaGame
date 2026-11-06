import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN_KEY = "bakagame:tab_token";
const OPEN_KEY = "bakagame:tab_open";
const TOKEN = "t".repeat(43);

type Exchange = (
  type: string,
  payload: Record<string, unknown>
) => Promise<Record<string, unknown>>;

/** 每次都是一次全新的页面加载：模块状态重来，sessionStorage 留着。 */
const loadPage = async () => {
  vi.resetModules();
  return import("./TabSession");
};

const ackWith =
  (ack: Record<string, unknown>): Exchange =>
  () =>
    Promise.resolve(ack);

const leavePage = () => window.dispatchEvent(new Event("pagehide"));

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("标签页身份的领取", () => {
  it("首次进入不带令牌，由服务端分配后写进本标签页", async () => {
    const { claimTabSession } = await loadPage();
    const exchange = vi.fn(ackWith({ token: TOKEN, rotated: false, serverEpoch: "boot-1" }));

    await claimTabSession(exchange);

    expect(exchange).toHaveBeenCalledWith("site.session.claim", {});
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe(TOKEN);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("刷新后沿用同一份身份：离开页面先摘标记，新页面不算继承", async () => {
    const first = await loadPage();
    await first.claimTabSession(ackWith({ token: TOKEN, rotated: false, serverEpoch: "boot-1" }));
    leavePage();

    const reloaded = await loadPage();
    const exchange = vi.fn(ackWith({ token: TOKEN, rotated: false, serverEpoch: "boot-1" }));
    await reloaded.claimTabSession(exchange);

    expect(exchange).toHaveBeenCalledWith("site.session.claim", { token: TOKEN });
  });

  it("复制标签页继承到标记：身份与全部座位凭证都丢掉，昵称保留", async () => {
    sessionStorage.setItem(TOKEN_KEY, TOKEN);
    sessionStorage.setItem(OPEN_KEY, "1");
    sessionStorage.setItem("whoisfaker_session_1234", "faker-seat");
    sessionStorage.setItem("songuessr_session_1234", "song-seat");
    sessionStorage.setItem("cee_session:1234", "cee-seat");
    sessionStorage.setItem("songuessr_solo_room", "9999");
    localStorage.setItem("bakagame:username", "昵称");

    const { claimTabSession } = await loadPage();

    for (const key of [
      TOKEN_KEY,
      "whoisfaker_session_1234",
      "songuessr_session_1234",
      "cee_session:1234",
      "songuessr_solo_room",
    ])
      expect(sessionStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem("bakagame:username")).toBe("昵称");

    const exchange = vi.fn(ackWith({ token: "n".repeat(43), rotated: false }));
    await claimTabSession(exchange);
    expect(exchange).toHaveBeenCalledWith("site.session.claim", {});
  });

  it("被浏览器回收后重新加载不算复制：没走 pagehide 也保留身份", async () => {
    sessionStorage.setItem(TOKEN_KEY, TOKEN);
    sessionStorage.setItem(OPEN_KEY, "1");
    sessionStorage.setItem("whoisfaker_session_1234", "faker-seat");
    Object.defineProperty(document, "wasDiscarded", { value: true, configurable: true });
    try {
      const { claimTabSession } = await loadPage();
      const exchange = vi.fn(ackWith({ token: TOKEN, rotated: false }));
      await claimTabSession(exchange);

      expect(exchange).toHaveBeenCalledWith("site.session.claim", { token: TOKEN });
      expect(sessionStorage.getItem("whoisfaker_session_1234")).toBe("faker-seat");
    } finally {
      delete (document as unknown as { wasDiscarded?: boolean }).wasDiscarded;
    }
  });

  it("从往返缓存恢复时补回标记：恢复后的页面仍占着这份存储", async () => {
    await loadPage();
    leavePage();
    expect(sessionStorage.getItem(OPEN_KEY)).toBeNull();

    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(sessionStorage.getItem(OPEN_KEY)).toBe("1");
  });

  it("服务端判定身份被占用：换成新身份并丢掉继承来的座位凭证", async () => {
    sessionStorage.setItem(TOKEN_KEY, TOKEN);
    sessionStorage.setItem("whoisfaker_session_1234", "faker-seat");
    const { claimTabSession } = await loadPage();
    const replacement = "r".repeat(43);

    await claimTabSession(ackWith({ token: replacement, rotated: true, serverEpoch: "boot-1" }));

    expect(sessionStorage.getItem(TOKEN_KEY)).toBe(replacement);
    expect(sessionStorage.getItem("whoisfaker_session_1234")).toBeNull();
  });

  it("存储被禁用时本页内身份依然稳定", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const { attachTabSession, claimTabSession } = await loadPage();
    await claimTabSession(ackWith({ token: TOKEN, rotated: false }));
    setItem.mockRestore();

    const exchange = vi.fn(ackWith({ attached: true }));
    await attachTabSession(exchange);
    expect(exchange).toHaveBeenCalledWith("site.session.attach", { token: TOKEN });
  });
});

describe("游戏连接挂上身份", () => {
  it("等站点连接的结果再挂：继承来的令牌可能正要被换掉", async () => {
    sessionStorage.setItem(TOKEN_KEY, TOKEN);
    const { attachTabSession, claimTabSession } = await loadPage();
    const attach = vi.fn(ackWith({ attached: true }));

    const attaching = attachTabSession(attach);
    await Promise.resolve();
    expect(attach).not.toHaveBeenCalled();

    const replacement = "r".repeat(43);
    await claimTabSession(ackWith({ token: replacement, rotated: true }));
    await attaching;

    expect(attach).toHaveBeenCalledWith("site.session.attach", { token: replacement });
  });

  it("站点连接迟迟不到：超时后按无身份继续，不把玩家挡在游戏外", async () => {
    vi.useFakeTimers();
    const { attachTabSession, TAB_READY_TIMEOUT_MS } = await loadPage();
    const attach = vi.fn(ackWith({ attached: true }));

    const attaching = attachTabSession(attach);
    await vi.advanceTimersByTimeAsync(TAB_READY_TIMEOUT_MS);
    await attaching;

    expect(attach).not.toHaveBeenCalled();
  });

  it("站点连接领取途中断开：不提前放行，等重连后领到身份再挂", async () => {
    const { attachTabSession, claimTabSession } = await loadPage();
    const attach = vi.fn(ackWith({ attached: true }));
    const attaching = attachTabSession(attach);

    await expect(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- 与连接层一致：拒绝值是协议错误体
      claimTabSession(() => Promise.reject({ code: "DISCONNECTED", message: "连接已断开" }))
    ).rejects.toMatchObject({ code: "DISCONNECTED" });
    await Promise.resolve();
    expect(attach).not.toHaveBeenCalled();

    await claimTabSession(ackWith({ token: TOKEN, rotated: false }));
    await attaching;
    expect(attach).toHaveBeenCalledWith("site.session.attach", { token: TOKEN });
  });

  it("旧服务端不认识领取命令：不挂身份，游戏照常走旧路径", async () => {
    const { attachTabSession, claimTabSession } = await loadPage();
    await expect(
      claimTabSession(() => Promise.reject(new Error("UNKNOWN_MESSAGE_TYPE")))
    ).rejects.toThrow("UNKNOWN_MESSAGE_TYPE");

    const attach = vi.fn(ackWith({ attached: true }));
    await attachTabSession(attach);
    expect(attach).not.toHaveBeenCalled();
  });
});

describe("服务端重启归因", () => {
  it("epoch 变化后一段时间内判定为刚重启，过后不再归因", async () => {
    const start = new Date("2026-11-06T00:00:00Z").getTime();
    vi.useFakeTimers({ now: start });
    const first = await loadPage();
    await first.claimTabSession(ackWith({ token: TOKEN, rotated: false, serverEpoch: "boot-1" }));
    expect(first.serverRestartedRecently()).toBe(false);

    await first.claimTabSession(ackWith({ token: TOKEN, rotated: false, serverEpoch: "boot-2" }));
    expect(first.serverRestartedRecently()).toBe(true);

    vi.setSystemTime(start + 61_000);
    expect(first.serverRestartedRecently()).toBe(false);
  });

  it("游戏连接先于站点连接重连：恢复房间之前就知道服务端重启过", async () => {
    const { attachTabSession, claimTabSession, serverRestartedRecently } = await loadPage();
    await claimTabSession(ackWith({ token: TOKEN, rotated: false, serverEpoch: "boot-1" }));

    await attachTabSession(ackWith({ attached: true, serverEpoch: "boot-2" }));

    expect(serverRestartedRecently()).toBe(true);
  });

  it("首次见到 epoch 不算重启", async () => {
    const { claimTabSession, serverRestartedRecently } = await loadPage();
    await claimTabSession(ackWith({ token: TOKEN, rotated: false, serverEpoch: "boot-1" }));
    expect(serverRestartedRecently()).toBe(false);
  });
});

describe("探测应答", () => {
  it("收到探测即回一帧：证明本页还开着", async () => {
    const { answerTabProbe } = await loadPage();
    const exchange = vi.fn(ackWith({ ok: true }));

    answerTabProbe("nonce-1", exchange);

    expect(exchange).toHaveBeenCalledWith("site.session.alive", { nonce: "nonce-1" });
  });
});
