import { describe, expect, it } from "bun:test";
import type { ServerMessage } from "../src/shared/Protocol";
import { isPagePathAllowed, PAGE_CODE_TTL_MS, SitePages } from "../src/transport/SitePages";

const recorder = () => {
  const sent: ServerMessage[] = [];
  return { sent, send: (payload: ServerMessage) => sent.push(payload) };
};

const eventsOf = (sent: ServerMessage[], event: string) =>
  sent.filter(
    (packet): packet is Extract<ServerMessage, { type: "event" }> =>
      packet.type === "event" && packet.event === event
  );

const stateAt = (path: string) => ({
  path,
  title: "BakaGame",
  controls: [{ id: "site.game.faker", label: "WhoisFaker 开始游戏" }],
});

describe("站点页面接管", () => {
  it("配对码 8 位、可认领一次；认领后页会收到租约通知", () => {
    const pages = new SitePages();
    const page = recorder();
    const opened = pages.open("conn-1", page.send);

    expect(opened.code).toHaveLength(8);
    expect(opened.expiresAt).toBeGreaterThan(0);

    const lease = pages.claim(opened.code, "mcp-1", "BakaAgent");
    expect(lease.pageId).toBe(opened.pageId);
    expect(eventsOf(page.sent, "site.page.lease")).toHaveLength(1);

    // 同一枚码不能再用；换一个控制器也不行。
    expect(() => pages.claim(opened.code, "mcp-2", "Other")).toThrow(/无效或已使用/);
  });

  it("配对码过期即作废", () => {
    let now = 1_000;
    const pages = new SitePages(() => now);
    const opened = pages.open("conn-1", recorder().send);
    now += PAGE_CODE_TTL_MS + 1;

    expect(() => pages.claim(opened.code, "mcp-1", "BakaAgent")).toThrow(/无效或已使用/);
  });

  it("页面状态决定可点目标：未上报的控件不能盲点", () => {
    const pages = new SitePages();
    const page = recorder();
    const opened = pages.open("conn-1", page.send);
    pages.updateState("conn-1", stateAt("/"));
    pages.claim(opened.code, "mcp-1", "BakaAgent");

    expect(pages.dispatch("mcp-1", "click", { control: "site.game.faker" })).toMatchObject({
      action: "click",
      control: "site.game.faker",
    });
    expect(() => pages.dispatch("mcp-1", "click", { control: "site.game.cee" })).toThrow(
      /没有可点控件/
    );
  });

  it("导航只接受人类可达位置，外链与未知路径一律拒绝", () => {
    const pages = new SitePages();
    const opened = pages.open("conn-1", recorder().send);
    pages.claim(opened.code, "mcp-1", "BakaAgent");

    expect(pages.dispatch("mcp-1", "navigate", { path: "/songuessr" })).toMatchObject({
      action: "navigate",
      path: "/songuessr",
    });
    expect(pages.dispatch("mcp-1", "navigate", { path: "/cee/room/1234" })).toMatchObject({
      path: "/cee/room/1234",
    });
    expect(() => pages.dispatch("mcp-1", "navigate", { path: "https://example.com" })).toThrow(
      /不在人类可达位置/
    );
    expect(isPagePathAllowed("/abouts")).toBe(true);
    expect(isPagePathAllowed("/api/mcp")).toBe(false);
  });

  it("指令只发给认领的那台页面，并带上指令号", () => {
    const pages = new SitePages();
    const first = recorder();
    const second = recorder();
    const opened = pages.open("conn-1", first.send);
    pages.open("conn-2", second.send);
    pages.claim(opened.code, "mcp-1", "BakaAgent");

    const command = pages.dispatch("mcp-1", "navigate", { path: "/" });

    expect(command.id).toContain(opened.pageId.slice(0, 8));
    expect(eventsOf(first.sent, "site.page.command")).toHaveLength(1);
    expect(eventsOf(second.sent, "site.page.command")).toHaveLength(0);
  });

  it("收回、断线与重复开启都不会留下第二把钥匙", () => {
    const pages = new SitePages();
    const page = recorder();
    const opened = pages.open("conn-1", page.send);

    // 未认领时再次开启：换发新码，旧码立即失效。
    const rotated = pages.open("conn-1", page.send);
    expect(rotated.code).not.toBe(opened.code);
    expect(() => pages.claim(opened.code, "mcp-1", "BakaAgent")).toThrow(/无效或已使用/);

    pages.claim(rotated.code, "mcp-1", "BakaAgent");
    expect(pages.closeByController("mcp-1")).toBe(true);
    expect(pages.viewFor("mcp-1")).toBeUndefined();
    expect(eventsOf(page.sent, "site.page.lease").at(-1)?.payload).toMatchObject({
      controlled: false,
    });

    // 断线同样回收：配对码与租约都绑在这条连接上。
    const reopened = pages.open("conn-1", page.send);
    pages.dropConnection("conn-1");
    expect(() => pages.claim(reopened.code, "mcp-2", "BakaAgent")).toThrow(/无效或已使用/);
    expect(pages.size).toBe(0);
  });
});
