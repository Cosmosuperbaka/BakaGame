import { afterEach, describe, expect, test } from "bun:test";
import { ceeTestHarness } from "./CEENativeFixtures";
import { createConnection, createTestContext, execute, getLastEventPayload } from "./Helpers";
import { createRoom } from "./whoisfaker/Fixtures";
import { TOOLS, type PageControlPort, type ToolContext } from "../src/mcp/Tools";
import type { AgentGameClient } from "../src/mcp/GameClient";
import type { SitePageResult, SitePageStep } from "../src/shared/AgentActivity";
import type { WhoIsFakerRoomSnapshot } from "../src/shared/Index";

/** 标签页接管对三款游戏的影响：座位徽标、进房准入，以及人类座位的归属不变。 */
const drive = (record: { tabKey?: string; agentDriven?: () => boolean }, state: () => boolean) => {
  record.tabKey = "tab-1";
  record.agentDriven = state;
};

describe("卧底：被接管的标签页", () => {
  const playerOf = (snapshot: WhoIsFakerRoomSnapshot | undefined, name: string) =>
    snapshot?.players.find((player) => player.name === name);

  test("接管开始与结束时，同房玩家立刻看到座位上的 MCP 徽标变化", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "2468", "房主");
    const guest = createConnection(service, "guest");
    await execute(service, guest, {
      id: "join",
      type: "room.join",
      roomId: "2468",
      payload: { userName: "访客" },
    });

    let driven = true;
    drive(host.record, () => driven);
    expect(() => service.publishTabRooms("tab-1")).not.toThrow();
    let snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(guest, "room.snapshot");
    expect(playerOf(snapshot, "房主")?.mcpControlled).toBe(true);
    expect(playerOf(snapshot, "访客")?.mcpControlled).toBeUndefined();

    driven = false;
    service.publishTabRooms("tab-1");
    snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(guest, "room.snapshot");
    expect(playerOf(snapshot, "房主")?.mcpControlled).toBeUndefined();
  });

  test("房间没开 MCP：坐在里面的标签页不能交给 Agent，接管中的标签页也进不来", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "2470", "房主");
    host.record.tabKey = "tab-host";
    expect(() => service.assertTabAgentsAllowed("tab-host")).toThrow("未开启 MCP");
    expect(() => service.assertTabAgentsAllowed("tab-elsewhere")).not.toThrow();

    const visitor = createConnection(service, "visitor");
    drive(visitor.record, () => true);
    await expect(
      execute(service, visitor, {
        id: "join",
        type: "room.join",
        roomId: "2470",
        payload: { userName: "访客" },
      })
    ).rejects.toMatchObject({ code: "AGENTS_NOT_ALLOWED" });
  });

  test("接管中的标签页建房时房间必须开着 MCP，其他玩家才知情", async () => {
    const { service } = createTestContext();
    const host = createConnection(service, "driven-host");
    drive(host.record, () => true);
    await execute(service, host, {
      id: "create",
      type: "room.create",
      payload: {
        roomId: "2472",
        name: "房间",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
      },
    });
    const snapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    expect(snapshot?.settings.allowAgents).toBe(true);
  });

  test("服务端不向接管的标签页隐藏或追加任何私有字段：人类看到的就是 Agent 看到的", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "2474", "房主");
    const before = getLastEventPayload<Record<string, unknown>>(host, "game.privateState");
    drive(host.record, () => true);
    service.publishTabRooms("tab-1");
    const after = getLastEventPayload<Record<string, unknown>>(host, "game.privateState");
    expect(after).toEqual(before);
    expect(after).not.toHaveProperty("mcpControlled");
  });
});

describe("CEE：被接管的标签页", () => {
  const active: ReturnType<typeof ceeTestHarness>[] = [];
  afterEach(() => {
    active.splice(0).forEach((harness) => harness.service.close());
  });

  test("房主没开 MCP 时进不来，反作弊与原版入口同样拦下", async () => {
    const h = ceeTestHarness();
    active.push(h);
    await h.create();
    const visitor = h.connect("访客");
    drive(visitor.record, () => true);
    await expect(h.send(visitor, "cee.room.join", { userName: "访客" })).rejects.toMatchObject({
      code: "AGENTS_NOT_ALLOWED",
    });
  });
});

describe("工具：接管与自有座位互斥", () => {
  const tool = (name: string) => {
    const found = TOOLS.find((entry) => entry.name === name);
    if (!found) throw new Error(`缺少工具 ${name}`);
    return found;
  };

  const client = (rooms: Record<string, string> = {}) =>
    ({ currentRoom: (game: string) => rooms[game] }) as unknown as AgentGameClient;

  const port = (results: (step: SitePageStep) => SitePageResult) => {
    const steps: SitePageStep[] = [];
    let controlling = false;
    const pages: PageControlPort = {
      claim: () => {
        controlling = true;
        return { pageId: "page-1", agentName: "A" };
      },
      dispatch: (_id, step) => {
        steps.push(step);
        return Promise.resolve(results(step));
      },
      isControlling: () => controlling,
      closeByController: () => {
        controlling = false;
        return true;
      },
    };
    return { pages, steps };
  };

  const context = (pages: PageControlPort, seats?: Record<string, string>): ToolContext => ({
    client: client(seats),
    agentName: "A",
    controllerId: "session-1",
    pages,
  });

  const view = {
    path: "/",
    title: "",
    scroll: { top: 0, max: 0, viewport: 0 },
    lines: [],
    offscreenLines: [],
    controls: [],
  };

  test("认领后返回当前页面；已坐在自有座位上时不能接管", async () => {
    const { pages } = port((step) => ({ id: "1", ok: true, ...(step ? { view } : {}) }));
    await expect(
      tool("control_page").handler({ code: "ABCD2345" }, context(pages, { faker: "1234" }))
    ).rejects.toMatchObject({ code: "PAGE_CONTROL_SEATED" });
    const claimed = (await tool("control_page").handler({ code: "ABCD2345" }, context(pages))) as {
      view: unknown;
    };
    expect(claimed.view).toEqual(view);
  });

  test("接管期间自有座位的工具一律拒绝，不能绕开页面直接发命令", async () => {
    const { pages } = port(() => ({ id: "1", ok: true }));
    await tool("control_page").handler({ code: "ABCD2345" }, context(pages));
    for (const name of ["create_room", "join_room", "leave_room", "get_screen", "ui_run"])
      await expect(
        tool(name).handler({ game: "faker", roomId: "1234" }, context(pages))
      ).rejects.toMatchObject({ code: "PAGE_CONTROL_ACTIVE" });
  });

  test("多步操作串行执行，失败即停，只有末步要最新页面", async () => {
    const { pages, steps } = port((step) =>
      step.control === "bad"
        ? { id: "1", ok: false, error: "控件不存在", view }
        : { id: "1", ok: true, ...(step.withView ? { view } : {}) }
    );
    await tool("control_page").handler({ code: "ABCD2345" }, context(pages));
    steps.length = 0;

    const done = (await tool("page_act").handler(
      {
        steps: [
          { action: "focus", control: "chat.input" },
          { action: "type", text: "你好" },
          { action: "click", control: "chat.send" },
        ],
        session: "不进指令",
      },
      context(pages)
    )) as { ok: boolean; view: unknown };
    expect(done.ok).toBe(true);
    expect(done.view).toEqual(view);
    expect(steps.map((step) => step.withView)).toEqual([false, false, true]);

    steps.length = 0;
    const failed = (await tool("page_act").handler(
      {
        steps: [
          { action: "click", control: "bad" },
          { action: "click", control: "chat.send" },
        ],
      },
      context(pages)
    )) as { ok: boolean; steps: Array<{ error?: string }> };
    expect(failed.ok).toBe(false);
    expect(failed.steps[0]?.error).toBe("控件不存在");
    expect(steps).toHaveLength(1);
  });

  test("page_act 不接受 read，也不接受未知动作；单步写法继续可用", async () => {
    const { pages, steps } = port(() => ({ id: "1", ok: true, view }));
    await tool("control_page").handler({ code: "ABCD2345" }, context(pages));
    await expect(tool("page_act").handler({ action: "read" }, context(pages))).rejects.toThrow(
      "action 只能是"
    );
    await expect(tool("page_act").handler({ action: "eval" }, context(pages))).rejects.toThrow(
      "action 只能是"
    );
    steps.length = 0;
    await tool("page_act").handler({ action: "navigate", path: "/cee" }, context(pages));
    expect(steps[0]).toMatchObject({ action: "navigate", path: "/cee", withView: true });
  });
});
