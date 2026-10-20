import { afterEach, describe, expect, it } from "vitest";
import {
  bakaChannelQuery,
  bakaClientType,
  isBakaClient,
  lastHandshakeHadTicket,
  waitForChannelTicket,
} from "./BakaChannel";

/** 模拟壳的读一次即补签语义：每次读 `channelTicket` 都换一张新票。 */
function shellWithRotatingTicket() {
  let issued = 0;
  const channel = {
    clientType: "desktop" as const,
    platform: "windows",
    clientVersion: "1.0.0",
    get channelTicket() {
      issued += 1;
      return `ticket-${issued}`;
    },
  };
  window.__BAKA_CHANNEL__ = channel;
  return () => issued;
}

afterEach(() => {
  delete window.__BAKA_CHANNEL__;
  // 清掉上一个用例可能留下的「等票交接」，避免模块级状态跨用例串味。
  bakaChannelQuery();
});

const params = (query: string) => new URLSearchParams(query.replace(/^\?/, ""));

describe("原生客户端通道探测", () => {
  it("网页环境没有注入：不带任何握手参数", () => {
    expect(isBakaClient()).toBe(false);
    expect(bakaClientType()).toBe("web");
    expect(bakaChannelQuery()).toBe("");
  });
  it("客户端无票时握手查询串为空：不再自报 clientType / clientVersion", () => {
    window.__BAKA_CHANNEL__ = {
      clientType: "mobile",
      platform: "android",
      clientVersion: "2.1.0",
      channelTicket: "",
    };
    expect(isBakaClient()).toBe(true);
    expect(bakaClientType()).toBe("mobile");
    expect(bakaChannelQuery()).toBe("");
  });
  it("每次建连重新取票：重连绝不会带上已消费过的旧票", () => {
    const issued = shellWithRotatingTicket();
    const first = params(bakaChannelQuery());
    const second = params(bakaChannelQuery());
    expect(first.get("ticket")).toBe("ticket-1");
    expect(second.get("ticket")).toBe("ticket-2");
    expect(issued()).toBe(2);
    // 握手 URL 只携带服务端真正消费的字段；身份与版本以服务端设备表为权威。
    expect(first.has("clientType")).toBe(false);
    expect(first.has("clientVersion")).toBe(false);
  });
  it("base64 票据里的 + 与 = 必须转义：原样拼进查询串会被解成空格", () => {
    window.__BAKA_CHANNEL__ = {
      clientType: "desktop",
      platform: "windows",
      clientVersion: "1.0.0",
      channelTicket: "ab+cd/ef==",
    };
    const query = bakaChannelQuery();
    expect(query).toContain("ticket=ab%2Bcd%2Fef%3D%3D");
    expect(params(query).get("ticket")).toBe("ab+cd/ef==");
  });
  it("壳晚一步签好票：等到后交给紧接着的一次握手，读走即清", async () => {
    let ticket = "";
    let handed = false;
    window.__BAKA_CHANNEL__ = {
      clientType: "mobile",
      platform: "android",
      clientVersion: "2.1.0",
      get channelTicket() {
        // 与壳一致：有票时读一次就作废；还没签好时继续返回空串。
        if (handed || !ticket) return "";
        handed = true;
        return ticket;
      },
    };
    setTimeout(() => {
      ticket = "late-ticket";
    }, 20);
    await expect(waitForChannelTicket(1_000)).resolves.toBe(true);
    expect(params(bakaChannelQuery()).get("ticket")).toBe("late-ticket");
    // 交接只有一次：下一次握手必须重新向壳要票，不能把同一张一次性票再发一遍。
    expect(bakaChannelQuery()).toBe("");
  });
  it("等票有上限：壳始终没有票时按超时返回，不拖住建连", async () => {
    window.__BAKA_CHANNEL__ = {
      clientType: "desktop",
      platform: "windows",
      clientVersion: "1.0.0",
      channelTicket: "",
    };
    const started = Date.now();
    await expect(waitForChannelTicket(80)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
  it("网页环境不做等票：立即返回，不占用建连时间", async () => {
    const started = Date.now();
    await expect(waitForChannelTicket(5_000)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });
  it("记录最近一次握手是否带上票：建连前后是两回事", () => {
    window.__BAKA_CHANNEL__ = {
      clientType: "desktop",
      platform: "windows",
      clientVersion: "1.0.0",
      channelTicket: "",
    };
    expect(lastHandshakeHadTicket()).toBe(false);
    bakaChannelQuery();
    expect(lastHandshakeHadTicket()).toBe(false);
    window.__BAKA_CHANNEL__ = {
      clientType: "desktop",
      platform: "windows",
      clientVersion: "1.0.0",
      channelTicket: "fresh",
    };
    bakaChannelQuery();
    expect(lastHandshakeHadTicket()).toBe(true);
  });
});
