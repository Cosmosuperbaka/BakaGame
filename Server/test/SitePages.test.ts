import { describe, expect, it } from "bun:test";
import { AppError } from "../src/domain/Errors";
import { isAgentPagePath } from "../src/shared/AgentPages";
import type { SitePageCommand, SitePageView } from "../src/shared/AgentActivity";
import type { ServerMessage } from "../src/shared/Protocol";
import { SITE_PAGES } from "../src/mcp/SiteMap";
import { PAGE_CODE_TTL_MS, SitePages, type SitePagesOptions } from "../src/transport/SitePages";

const recorder = () => {
  const sent: ServerMessage[] = [];
  return { sent, send: (payload: ServerMessage) => sent.push(payload) };
};

const eventsOf = (sent: ServerMessage[], event: string) =>
  sent.filter(
    (packet): packet is Extract<ServerMessage, { type: "event" }> =>
      packet.type === "event" && packet.event === event
  );

const leaseOf = (sent: ServerMessage[]) =>
  eventsOf(sent, "site.page.lease").map((packet) => packet.payload as Record<string, unknown>);

const lastCommand = (sent: ServerMessage[]) =>
  eventsOf(sent, "site.page.command").at(-1)?.payload as SitePageCommand;

const view = (path: string): SitePageView => ({
  path,
  title: "BakaGame",
  scroll: { top: 0, max: 0, viewport: 800 },
  lines: ["谜底"],
  offscreenLines: [],
  controls: [],
});

const setup = (options: SitePagesOptions = {}) => {
  const changes: Array<[string, boolean]> = [];
  const pages = new SitePages({
    onControlChange: (tabKey, controlled) => changes.push([tabKey, controlled]),
    ...options,
  });
  const page = recorder();
  const opened = pages.open("tab-1", "conn-1", page.send);
  return { pages, page, opened, changes };
};

const answer = (pages: SitePages, connectionId: string, command: SitePageCommand) =>
  pages.recordResult(connectionId, { id: command.id, ok: true });

describe("配对码", () => {
  it("8 位、一次有效；认领后页面收到接管通知，标签页进入接管状态", () => {
    const { pages, page, opened, changes } = setup();
    expect(opened.code).toHaveLength(8);

    const lease = pages.claim(opened.code, "agent-1", "BakaAgent");
    expect(lease.agentName).toBe("BakaAgent");
    expect(leaseOf(page.sent)).toEqual([{ controlled: true, agentName: "BakaAgent" }]);
    expect(pages.isTabControlled("tab-1")).toBe(true);
    expect(changes).toEqual([["tab-1", true]]);

    expect(() => pages.claim(opened.code, "agent-2", "Other")).toThrow("配对码无效或已使用");
  });

  it("换发后旧码立即失效，过期的码不能认领", () => {
    let now = 0;
    const pages = new SitePages({ now: () => now });
    const page = recorder();
    const first = pages.open("tab-1", "conn-1", page.send);
    const second = pages.open("tab-1", "conn-1", page.send);
    expect(second.pageId).toBe(first.pageId);
    expect(() => pages.claim(first.code, "agent-1", "A")).toThrow("配对码无效或已使用");

    now = PAGE_CODE_TTL_MS + 1;
    expect(() => pages.claim(second.code, "agent-1", "A")).toThrow("配对码无效或已使用");
  });

  it("未认领时连接断开，配对码随之作废，不跨刷新保留", () => {
    const { pages, opened } = setup();
    pages.dropConnection("conn-1");
    expect(pages.size).toBe(0);
    expect(() => pages.claim(opened.code, "agent-1", "A")).toThrow("配对码无效或已使用");
  });

  it("已接管的页面不能再开码；一个会话只能驱动一张标签页", () => {
    const { pages, opened } = setup();
    pages.claim(opened.code, "agent-1", "A");
    expect(() => pages.open("tab-1", "conn-1", recorder().send)).toThrow("已被 Agent 接管");

    const other = pages.open("tab-2", "conn-2", recorder().send);
    expect(() => pages.claim(other.code, "agent-1", "A")).toThrow("已接管一张页面");
  });

  it("准入不过时认领失败，配对码还在、标签页不进入接管", () => {
    const { pages, opened, changes } = setup({
      admitTab: () => {
        throw new AppError("AGENTS_NOT_ALLOWED", "本房间未开启 MCP 接入");
      },
    });
    expect(() => pages.claim(opened.code, "agent-1", "A")).toThrow("未开启 MCP");
    expect(pages.isControlling("agent-1")).toBe(false);
    expect(changes).toEqual([]);
  });

  it("满表时只回收未认领的页面，全部已接管时拒绝新开", () => {
    const pages = new SitePages();
    for (let index = 0; index < 128; index += 1) {
      const { code } = pages.open(`tab-${index}`, `conn-${index}`, recorder().send);
      pages.claim(code, `agent-${index}`, "A");
    }
    expect(() => pages.open("tab-new", "conn-new", recorder().send)).toThrow("已满");
  });
});

describe("指令", () => {
  it("只发给持有这份身份的连接，等到页面回报才算完成", async () => {
    const { pages, page, opened } = setup();
    pages.claim(opened.code, "agent-1", "A");

    const pending = pages.dispatch("agent-1", { action: "click", control: "chat.send" });
    const command = lastCommand(page.sent);
    expect(command).toMatchObject({ action: "click", control: "chat.send" });
    expect(answer(pages, "conn-1", command)).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it("别的连接猜中指令号也写不进结果", async () => {
    const { pages, page, opened } = setup({ commandTimeoutMs: 20 });
    pages.claim(opened.code, "agent-1", "A");
    const pending = pages.dispatch("agent-1", { action: "read" });
    expect(answer(pages, "conn-other", lastCommand(page.sent))).toBe(false);
    await expect(pending).rejects.toMatchObject({ code: "PAGE_TIMEOUT" });
  });

  it("没有接管、路径不可达或参数不对都在发给页面之前拒绝", () => {
    const { pages, page, opened } = setup();
    expect(() => pages.dispatch("agent-1", { action: "read" })).toThrow("尚未接管");
    pages.claim(opened.code, "agent-1", "A");

    const before = eventsOf(page.sent, "site.page.command").length;
    for (const path of ["/admin", "/cee/ranked", "https://example.com", "/account"])
      expect(() => pages.dispatch("agent-1", { action: "navigate", path })).toThrow("不在 Agent");
    expect(() => pages.dispatch("agent-1", { action: "click", control: "a b" })).toThrow(
      "control 不合法"
    );
    expect(() => pages.dispatch("agent-1", { action: "click" })).toThrow("需要 control");
    expect(() => pages.dispatch("agent-1", { action: "type", text: "x".repeat(401) })).toThrow(
      "最长 400 字"
    );
    expect(() => pages.dispatch("agent-1", { action: "press", key: "F5" as never })).toThrow(
      "press 的 key"
    );
    expect(() => pages.dispatch("agent-1", { action: "scroll" })).toThrow("direction");
    expect(eventsOf(page.sent, "site.page.command")).toHaveLength(before);
  });

  it("页面上报的路径不可达时，正文一律不交给 Agent", async () => {
    const { pages, page, opened } = setup();
    pages.claim(opened.code, "agent-1", "A");
    const pending = pages.dispatch("agent-1", { action: "read" });
    pages.recordResult("conn-1", {
      id: lastCommand(page.sent).id,
      ok: true,
      view: view("/admin"),
    });
    const result = await pending;
    expect(result.view).toMatchObject({ path: "/admin", restricted: true, lines: [] });
  });
});

describe("刷新与断线", () => {
  it("刷新后同一身份续上租约，不用重新配对，焦点带回页面", async () => {
    const { pages, page, opened, changes } = setup();
    pages.claim(opened.code, "agent-1", "A");
    const clicked = pages.dispatch("agent-1", { action: "click", control: "chat.send" });
    answer(pages, "conn-1", lastCommand(page.sent));
    await clicked;

    pages.dropConnection("conn-1");
    expect(pages.isTabControlled("tab-1")).toBe(true);
    expect(() => pages.dispatch("agent-1", { action: "read" })).toThrow("重新连接");

    const reloaded = recorder();
    expect(pages.attach("tab-1", "conn-2", reloaded.send)).toBe(true);
    expect(leaseOf(reloaded.sent)).toEqual([
      { controlled: true, resumed: true, agentName: "A", focusControl: "chat.send" },
    ]);

    const pending = pages.dispatch("agent-1", { action: "read" });
    expect(answer(pages, "conn-2", lastCommand(reloaded.sent))).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(changes).toEqual([["tab-1", true]]);
  });

  it("新连接先于旧连接的 close 到达时，旧 close 不影响租约", () => {
    const { pages, opened } = setup();
    pages.claim(opened.code, "agent-1", "A");
    pages.attach("tab-1", "conn-2", recorder().send);
    pages.dropConnection("conn-1");
    expect(pages.isTabControlled("tab-1")).toBe(true);
    pages.dropConnection("conn-2");
    expect(pages.isTabControlled("tab-1")).toBe(true);
  });

  it("页面迟迟不回来，等待期满后接管结束", async () => {
    const { pages, opened, changes } = setup({ reattachGraceMs: 5 });
    pages.claim(opened.code, "agent-1", "A");
    pages.dropConnection("conn-1");
    await Bun.sleep(20);
    expect(pages.isControlling("agent-1")).toBe(false);
    expect(pages.attach("tab-1", "conn-2", recorder().send)).toBe(false);
    expect(changes).toEqual([
      ["tab-1", true],
      ["tab-1", false],
    ]);
  });

  it("换了身份的标签页（复制页）接不上别人的租约", () => {
    const { pages, opened } = setup();
    pages.claim(opened.code, "agent-1", "A");
    expect(pages.attach("tab-copy", "conn-2", recorder().send)).toBe(false);
  });

  it("页面在等待期内断开时，在途指令立刻失败而不是等到超时", async () => {
    const { pages, opened } = setup();
    pages.claim(opened.code, "agent-1", "A");
    const pending = pages.dispatch("agent-1", { action: "read" });
    pages.dropConnection("conn-1");
    await expect(pending).rejects.toMatchObject({ code: "PAGE_DETACHED" });
  });
});

describe("结束接管", () => {
  it("人类随时能收回：不需要 Agent 配合，在途指令立即失败，Agent 下一步被拒", async () => {
    const { pages, opened, changes } = setup();
    pages.claim(opened.code, "agent-1", "A");
    const pending = pages.dispatch("agent-1", { action: "read" });

    expect(pages.close("conn-1")).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "PAGE_RELEASED" });
    expect(pages.isTabControlled("tab-1")).toBe(false);
    expect(() => pages.dispatch("agent-1", { action: "read" })).toThrow("尚未接管");
    expect(changes.at(-1)).toEqual(["tab-1", false]);
  });

  it("Agent 交还或断开时页面立刻收到原因", () => {
    const { pages, page, opened } = setup();
    pages.claim(opened.code, "agent-1", "A");
    expect(pages.closeByController("agent-1", "agent_left")).toBe(true);
    expect(leaseOf(page.sent).at(-1)).toEqual({ controlled: false, reason: "agent_left" });
    expect(pages.closeByController("agent-1")).toBe(false);
  });

  it("Agent 长时间没有动作时自动收回，动作会续期", async () => {
    const { pages, page, opened } = setup({ leaseIdleMs: 30 });
    pages.claim(opened.code, "agent-1", "A");
    await Bun.sleep(15);
    const pending = pages.dispatch("agent-1", { action: "read" });
    answer(pages, "conn-1", lastCommand(page.sent));
    await pending;
    await Bun.sleep(15);
    expect(pages.isControlling("agent-1")).toBe(true);
    await Bun.sleep(40);
    expect(pages.isControlling("agent-1")).toBe(false);
    expect(leaseOf(page.sent).at(-1)).toEqual({ controlled: false, reason: "expired" });
  });
});

describe("页面可达范围", () => {
  it("站点地图只登记 Agent 可达的页面，房间页按形状放行", () => {
    for (const page of SITE_PAGES) expect(isAgentPagePath(page.path)).toBe(true);
    expect(isAgentPagePath("/abouts?tab=terms")).toBe(true);
    expect(isAgentPagePath("/cee/room/1234")).toBe(true);
    expect(isAgentPagePath("/whoisfaker/room/ab_cd-12/")).toBe(true);
    for (const path of ["/admin", "/admin/users", "/cee/ranked", "/account", "/login", "/x/room/1"])
      expect(isAgentPagePath(path)).toBe(false);
  });
});
