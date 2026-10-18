import { afterEach, describe, expect, it } from "vitest";
import { bakaChannelQuery, bakaClientType, isBakaClient } from "./BakaChannel";

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
});

const params = (query: string) => new URLSearchParams(query.replace(/^\?/, ""));

describe("原生客户端通道探测", () => {
  it("网页环境没有注入：不带任何握手参数", () => {
    expect(isBakaClient()).toBe(false);
    expect(bakaClientType()).toBe("web");
    expect(bakaChannelQuery()).toBe("");
  });
  it("客户端带明文标识，无票时不塞空 ticket", () => {
    window.__BAKA_CHANNEL__ = {
      clientType: "mobile",
      platform: "android",
      clientVersion: "2.1.0",
      channelTicket: "",
    };
    expect(isBakaClient()).toBe(true);
    expect(bakaClientType()).toBe("mobile");
    const search = params(bakaChannelQuery());
    expect(search.get("clientType")).toBe("mobile");
    expect(search.get("clientVersion")).toBe("2.1.0");
    expect(search.has("ticket")).toBe(false);
  });
  it("每次建连重新取票：重连绝不会带上已消费过的旧票", () => {
    const issued = shellWithRotatingTicket();
    const first = params(bakaChannelQuery());
    const second = params(bakaChannelQuery());
    expect(first.get("ticket")).toBe("ticket-1");
    expect(second.get("ticket")).toBe("ticket-2");
    expect(issued()).toBe(2);
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
});
